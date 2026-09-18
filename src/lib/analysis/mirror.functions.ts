import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getIqOptionName, timeframeSeconds } from "@/lib/iqoption/mapping";
import { getStoredCandles, saveCandles } from "@/lib/iqoption/candleHistory.server";
import {
  buildSeriesIndex,
  consensusOf,
  findMatchesFast,
  type MirrorCandle,
  type MirrorConsensus,
  type MirrorMatch,
  type MirrorSeriesIndex,
} from "./mirror";

const BLOCK_SIZE = 500;
const MAX_MATCHES = 8;
/**
 * Quantas velas à frente CADA coincidência tenta projetar. Alto de propósito:
 * a varredura completa (coleta + cruzamento) pode levar minutos, então o plano
 * precisa ter fôlego para ainda ter velas no futuro quando o resultado aparece.
 */
const PROJECTION_STEPS = 20;
/**
 * Mínimo de velas projetadas para uma coincidência ser aceita. Exigir os 20
 * completos descartava replays válidos que só tinham, digamos, 10 velas de
 * histórico disponíveis depois do ponto do replay (comum na leitura invertida
 * no tempo, que projeta "pra trás" no array). 5 é o suficiente para valer a
 * pena mostrar, mesmo quando não há espaço para as 20.
 */
const MIN_PROJECTION_STEPS = 5;
/**
 * Só usado para limpar entradas abandonadas do cache em memória (ex.: um
 * ativo que saiu do catálogo no meio de uma varredura anterior). NÃO controla
 * se um ativo é buscado de novo — isso acontece sempre, a cada varredura.
 */
const STORE_TTL_MS = 25 * 60 * 1000;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Teto de velas lidas do banco por ativo. O arquivo pode ter muito mais; o que
 * interessa ao matcher é a janela mais recente, e ler tudo de 400 ativos
 * estouraria memória e tempo da requisição.
 */
const MAX_ARCHIVE_CANDLES = 40_000;
/** Quando o ativo ainda não tem nada arquivado, busca só um bloco recente. */
const FIRST_TIME_BLOCKS = 1;

/**
 * Histórico de um ativo lido do ARQUIVO no banco (preenchido uma vez pelo
 * arquivamento — ver src/lib/iqoption/backfill.functions.ts — e mantido em dia
 * pelo job de ingestão). Da corretora só vêm as velas recentes que ainda não
 * estão salvas: normalmente 1 requisição pequena por ativo, em vez de dezenas
 * de blocos profundos a cada varredura (era isso que fazia a varredura passar
 * de 20 minutos).
 */
async function loadHistory(
  fetchCandles: (name: string, size: number, count: number, to?: number) => Promise<MirrorCandle[]>,
  iqName: string,
  timeframeLabel: string,
  sizeSeconds: number,
  maxRecentBlocks: number,
): Promise<MirrorCandle[]> {
  const stored = await getStoredCandles(iqName, timeframeLabel, {
    maxCandles: MAX_ARCHIVE_CANDLES,
  });
  const newestStoredTime = stored.length > 0 ? stored[stored.length - 1]!.time : null;

  const byTime = new Map<number, MirrorCandle>();
  for (const c of stored) byTime.set(c.time, c);

  const now = Math.floor(Date.now() / 1000);
  // Só o buraco entre a última vela salva e agora.
  const missing =
    newestStoredTime == null
      ? FIRST_TIME_BLOCKS * BLOCK_SIZE
      : Math.min(
          Math.ceil((now - newestStoredTime) / sizeSeconds) + 2,
          maxRecentBlocks * BLOCK_SIZE,
        );

  const fresh: MirrorCandle[] = [];
  let remaining = missing;
  let to: number | undefined = undefined;
  while (remaining > 0) {
    const count = Math.min(BLOCK_SIZE, remaining);
    const chunk = await fetchCandles(iqName, sizeSeconds, count, to);
    if (chunk.length === 0) break;
    for (const c of chunk) {
      if (!byTime.has(c.time)) fresh.push(c);
      byTime.set(c.time, c);
    }
    const oldest = chunk[0]!.time;
    remaining -= chunk.length;
    if (newestStoredTime != null && oldest <= newestStoredTime) break;
    if (remaining <= 0) break;
    to = oldest - sizeSeconds;
    // Espaçamento entre requisições: evita bloqueio por excesso de acessos.
    await sleep(200);
  }

  if (fresh.length > 0) {
    await saveCandles(
      iqName,
      timeframeLabel,
      fresh.map((c) => ({ ...c, volume: c.volume ?? 0 })),
    );
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

interface StoredSeries {
  label: string;
  history: MirrorCandle[];
  index: MirrorSeriesIndex;
  at: number;
}

/**
 * Histórico já baixado, reaproveitado entre as etapas da varredura global.
 * Vive no processo do servidor; se for perdido, a etapa de coleta refaz.
 */
const historyStore = new Map<string, Map<string, StoredSeries>>();

function storeFor(timeframe: string): Map<string, StoredSeries> {
  let bucket = historyStore.get(timeframe);
  if (!bucket) {
    bucket = new Map();
    historyStore.set(timeframe, bucket);
  }
  const cutoff = Date.now() - STORE_TTL_MS;
  for (const [key, value] of bucket) {
    if (value.at < cutoff) bucket.delete(key);
  }
  return bucket;
}

/** Catálogo normalizado (nomes reconhecidos pela corretora, sem repetição). */
function buildCatalog(assets: string[]): Array<{ iqName: string; label: string }> {
  const out: Array<{ iqName: string; label: string }> = [];
  const seen = new Set<string>();
  for (const symbol of assets) {
    const iqName = getIqOptionName(symbol);
    if (!iqName || seen.has(iqName)) continue;
    seen.add(iqName);
    out.push({ iqName, label: symbol });
  }
  return out;
}

const chunkSchema = z.object({
  timeframe: z.enum(["M1", "M5", "M15"]),
  windowSize: z.number().int().min(12).max(60).default(24),
  /** Catálogo completo de ativos da corretora. */
  assets: z.array(z.string()).min(1).max(600),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(24).default(10),
  // loadHistory já para sozinho quando a corretora não tem mais velas para
  // entregar, então um teto alto aqui só significa "puxe o máximo que a
  // corretora tiver", sem excesso de requisições para ativos com histórico
  // mais curto.
  historyBlocks: z.number().int().min(1).max(20).default(6),
  minCorrelation: z.number().min(0.7).max(0.999).default(0.93),
  /**
   * "collect" baixa o histórico deste trecho do catálogo.
   * "match" cruza o trecho atual destes ativos contra TODO o histórico coletado.
   */
  phase: z.enum(["collect", "match"]),
});

export interface MirrorAssetGroup {
  liveAsset: string;
  liveWindow: MirrorCandle[];
  matches: MirrorMatch[];
  consensus: MirrorConsensus;
}

export interface MirrorChunkResult {
  phase: "collect" | "match";
  groups: MirrorAssetGroup[];
  /** Ativos processados nesta chamada. */
  processed: number;
  /** Ativos com histórico disponível na memória da varredura. */
  storedAssets: number;
  storedCandles: number;
  skippedAssets: string[];
  nextOffset: number | null;
  totalAssets: number;
  error?: string;
}

/**
 * Uma etapa da varredura global. O navegador chama em sequência até cobrir todo
 * o catálogo: primeiro coletando o histórico de todos os ativos (sempre fresco
 * na corretora, nada fica em banco), depois cruzando cada ativo ao vivo contra
 * o histórico de TODOS os outros — só assim a comparação é simétrica e completa.
 */
export const mirrorScanChunk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => chunkSchema.parse(input))
  .handler(async ({ data }): Promise<MirrorChunkResult> => {
    const { fetchCandles, IqOptionBackoffError } = await import("@/lib/iqoption/iqoption.server");
    const size = timeframeSeconds(data.timeframe);
    const catalog = buildCatalog(data.assets);
    const store = storeFor(data.timeframe);

    const countCandles = () => {
      let total = 0;
      for (const s of store.values()) total += s.history.length;
      return total;
    };

    const base: MirrorChunkResult = {
      phase: data.phase,
      groups: [],
      processed: 0,
      storedAssets: store.size,
      storedCandles: countCandles(),
      skippedAssets: [],
      nextOffset: null,
      totalAssets: catalog.length,
    };

    if (catalog.length === 0) {
      return { ...base, error: "Nenhum ativo reconhecido pela corretora." };
    }

    const batch = catalog.slice(data.offset, data.offset + data.limit);
    const nextOffset =
      data.offset + batch.length < catalog.length ? data.offset + batch.length : null;
    if (batch.length === 0) return { ...base, nextOffset: null };

    try {
      if (data.phase === "collect") {
        const skipped: string[] = [];
        let processed = 0;
        for (const { iqName, label } of batch) {
          // Sempre busca de novo, mesmo se este ativo já está no cache: cada
          // varredura precisa refletir as velas mais recentes no momento em
          // que o usuário clicou, não o que estava ao vivo há minutos atrás
          // (loadHistory é barata para isso — só busca na corretora o que
          // ainda não está salvo no banco).
          try {
            const history = await loadHistory(
              fetchCandles,
              iqName,
              data.timeframe,
              size,
              data.historyBlocks,
            );
            if (history.length < data.windowSize + 6) {
              // Sem isto, uma falha silenciosa de fetchCandles (ex.: sessão da
              // corretora não sobrevivendo entre requisições) some sem deixar
              // rastro nos logs - aparece só como "sem histórico suficiente".
              console.warn(
                `[mirror] histórico insuficiente para ${iqName}: ${history.length} vela(s)`,
              );
              skipped.push(label);
              continue;
            }
            store.set(iqName, { label, history, index: buildSeriesIndex(history), at: Date.now() });
            processed++;
          } catch (error) {
            if (error instanceof IqOptionBackoffError) throw error;
            console.error(`[mirror] loadHistory falhou para ${iqName}:`, error);
            skipped.push(label);
          }
          await sleep(120);
        }
        return {
          ...base,
          processed,
          storedAssets: store.size,
          storedCandles: countCandles(),
          skippedAssets: skipped,
          nextOffset,
        };
      }

      // ---- fase de cruzamento ----
      const groups: MirrorAssetGroup[] = [];
      const skipped: string[] = [];
      let processed = 0;

      for (const { iqName } of batch) {
        const live = store.get(iqName);
        if (!live) {
          skipped.push(iqName);
          continue;
        }
        processed++;

        // A janela ao vivo precisa refletir o instante do cruzamento, não o
        // instante em que a coleta passou por este ativo — a varredura
        // inteira pode levar minutos, então reaproveitar o histórico da
        // coleta aqui gera planos que já nascem no passado (é exatamente o
        // que estava acontecendo). O histórico arquivado de cada ativo
        // (`hist.history`, usado como "palheiro" da busca) pode continuar
        // vindo da coleta normalmente — só a ponta viva precisa ser buscada
        // de novo, agora, e essa busca é pequena e rápida.
        let liveCandles: MirrorCandle[];
        try {
          liveCandles = await fetchCandles(iqName, size, data.windowSize + 5);
        } catch (error) {
          if (error instanceof IqOptionBackoffError) throw error;
          console.error(`[mirror] falha ao atualizar janela ao vivo de ${iqName}:`, error);
          skipped.push(iqName);
          continue;
        }
        await sleep(120);
        // A última vela pode estar em formação: só velas fechadas entram.
        const closed = liveCandles.slice(0, -1);
        const liveWindow = closed.slice(-(data.windowSize + 1));
        if (liveWindow.length < data.windowSize + 1) continue;
        const liveStart = liveWindow[0]!.time;

        const found: MirrorMatch[] = [];
        for (const [histName, hist] of store) {
          found.push(
            ...findMatchesFast(hist.label, data.timeframe, liveWindow, hist.history, hist.index, {
              minCorrelation: data.minCorrelation,
              maxPerAsset: 3,
              excludeFrom: histName === iqName ? liveStart : undefined,
              projectionSteps: PROJECTION_STEPS,
              stepSeconds: size,
            }).filter((m) => m.projection.length >= MIN_PROJECTION_STEPS),
          );
        }
        if (found.length === 0) continue;

        found.sort((a, b) => b.correlation - a.correlation);
        const matches = found.slice(0, MAX_MATCHES);
        groups.push({
          liveAsset: live.label,
          liveWindow,
          matches,
          consensus: consensusOf(matches),
        });
      }

      groups.sort((a, b) => (b.matches[0]?.correlation ?? 0) - (a.matches[0]?.correlation ?? 0));

      return {
        ...base,
        groups,
        processed,
        storedAssets: store.size,
        storedCandles: countCandles(),
        skippedAssets: skipped,
        nextOffset,
      };
    } catch (error) {
      console.error("[mirror] scan chunk failed", error);
      if (error instanceof IqOptionBackoffError) {
        return {
          ...base,
          nextOffset,
          error: "Conexão com a corretora em recuperação. Retomando em instantes.",
        };
      }
      return { ...base, nextOffset, error: "Não foi possível concluir esta etapa da varredura." };
    }
  });
