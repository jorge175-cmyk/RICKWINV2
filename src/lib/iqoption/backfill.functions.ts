// Arquivo histórico: baixa da corretora TODO o histórico disponível de cada
// ativo (bloco a bloco, andando para trás no tempo) e salva no banco por ativo
// e horário. Feito uma vez por ativo/timeframe; depois a varredura de replay só
// busca na corretora as velas recentes que ainda não estão salvas.
//
// Cada chamada processa um pedaço pequeno do catálogo para caber no tempo de
// uma requisição serverless — o navegador chama em sequência até terminar, e
// pode ser interrompido e retomado sem perder o que já foi arquivado (o
// progresso vive na tabela de cobertura, não na memória do servidor).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getIqOptionName, timeframeSeconds } from "@/lib/iqoption/mapping";
import {
  getCoverage,
  saveCandles,
  saveCoverage,
  type CandleCoverage,
} from "@/lib/iqoption/candleHistory.server";

/** Velas por requisição à corretora. 1000 é o teto prático do get-candles. */
const BLOCK_SIZE = 1000;
/** Espaçamento entre requisições: evita bloqueio por excesso de acessos (429). */
const REQUEST_GAP_MS = 200;

const schema = z.object({
  timeframe: z.enum(["M1", "M5", "M15"]),
  assets: z.array(z.string()).min(1).max(600),
  offset: z.number().int().min(0).default(0),
  /** Ativos por chamada. */
  limit: z.number().int().min(1).max(20).default(4),
  /** Blocos por ativo nesta chamada (cada bloco = BLOCK_SIZE velas para trás). */
  blocksPerAsset: z.number().int().min(1).max(30).default(8),
});

export interface BackfillChunkResult {
  processed: number;
  /** Velas novas gravadas nesta chamada. */
  savedCandles: number;
  /** Ativos que terminaram o arquivo (corretora sem nada mais antigo). */
  completed: number;
  /** Ativos já completos antes desta chamada — nada foi baixado. */
  skipped: number;
  nextOffset: number | null;
  totalAssets: number;
  /** Ativos com arquivo completo no timeframe, no total. */
  archiveAssets: number;
  archiveComplete: number;
  error?: string;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function buildCatalog(assets: string[]): Array<{ iqName: string }> {
  const seen = new Set<string>();
  const out: Array<{ iqName: string }> = [];
  for (const symbol of assets) {
    const iqName = getIqOptionName(symbol);
    if (!iqName || seen.has(iqName)) continue;
    seen.add(iqName);
    out.push({ iqName });
  }
  return out;
}

export const backfillArchiveChunk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => schema.parse(input))
  .handler(async ({ data }): Promise<BackfillChunkResult> => {
    const { fetchCandles, IqOptionBackoffError } = await import("@/lib/iqoption/iqoption.server");
    const size = timeframeSeconds(data.timeframe);
    const catalog = buildCatalog(data.assets);

    const batch = catalog.slice(data.offset, data.offset + data.limit);
    const nextOffset =
      data.offset + batch.length < catalog.length ? data.offset + batch.length : null;

    const base: BackfillChunkResult = {
      processed: 0,
      savedCandles: 0,
      completed: 0,
      skipped: 0,
      nextOffset,
      totalAssets: catalog.length,
      archiveAssets: 0,
      archiveComplete: 0,
    };
    if (batch.length === 0) return { ...base, nextOffset: null };

    const coverage = await getCoverage(
      data.timeframe,
      batch.map((b) => b.iqName),
    );

    let savedCandles = 0;
    let completed = 0;
    let skipped = 0;
    let processed = 0;

    try {
      for (const { iqName } of batch) {
        const current: CandleCoverage | undefined = coverage.get(iqName);
        if (current?.complete) {
          skipped++;
          continue;
        }
        processed++;

        // Continua de onde parou: do bloco imediatamente anterior à vela mais
        // antiga já arquivada. Primeira vez começa em "agora".
        let to = current?.oldestTime != null ? current.oldestTime - size : Math.floor(Date.now() / 1000);
        let oldest = current?.oldestTime ?? null;
        let newest = current?.newestTime ?? null;
        let blocks = current?.blocksFetched ?? 0;
        let done = false;

        for (let i = 0; i < data.blocksPerAsset; i++) {
          const chunk = await fetchCandles(iqName, size, BLOCK_SIZE, to);
          if (chunk.length === 0) {
            done = true;
            break;
          }
          await saveCandles(
            iqName,
            data.timeframe,
            chunk.map((c) => ({ ...c, volume: c.volume ?? 0 })),
          );
          savedCandles += chunk.length;
          blocks++;

          const chunkOldest = chunk[0]!.time;
          const chunkNewest = chunk[chunk.length - 1]!.time;
          if (oldest == null || chunkOldest < oldest) oldest = chunkOldest;
          if (newest == null || chunkNewest > newest) newest = chunkNewest;

          // Corretora não tem mais nada antes disso: arquivo completo.
          if (chunkOldest >= to || chunk.length < BLOCK_SIZE / 2) {
            done = true;
            break;
          }
          to = chunkOldest - size;
          await sleep(REQUEST_GAP_MS);
        }

        await saveCoverage(iqName, data.timeframe, {
          oldestTime: oldest,
          newestTime: newest,
          blocksFetched: blocks,
          complete: done,
          lastError: null,
        });
        if (done) completed++;
        await sleep(REQUEST_GAP_MS);
      }
    } catch (error) {
      console.error("[backfill] falhou", error);
      const message =
        error instanceof IqOptionBackoffError
          ? "Corretora em recuperação (limite de acessos). Aguarde e retome o arquivamento."
          : "Não foi possível concluir esta etapa do arquivamento.";
      return { ...base, processed, savedCandles, completed, skipped, error: message };
    }

    return { ...base, processed, savedCandles, completed, skipped };
  });
