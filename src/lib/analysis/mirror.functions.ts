import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getIqOptionName, timeframeSeconds } from "@/lib/iqoption/mapping";
import {
  getStoredCandles,
  getNewestCandleTime,
  saveCandles,
} from "@/lib/iqoption/candleHistory.server";
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
 * Quantos ativos processar em paralelo por etapa. Antes, cada ativo abria sua
 * conexão e esperava a anterior terminar — agora que cada chamada já abre sua
 * própria sessão isolada (ver iqoption.server.ts), processar vários ao mesmo
 * tempo é seguro (tudo dentro da mesma requisição) e evita que a varredura
 * inteira demore minutos só por ir um ativo de cada vez.
 */
const SCAN_CONCURRENCY = 6;
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
 * Concorrência para ler o arquivo do banco na etapa de cruzamento. Mais alta
 * que SCAN_CONCURRENCY porque é só leitura de banco, sem limite da corretora.
 */
const HAYSTACK_CONCURRENCY = 20;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Roda até `limit` tarefas por vez, sem esperar a lista inteira terminar em série. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = items[index++]!;
      await fn(current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

/**
 * Teto de velas lidas do banco por ativo para montar o palheiro do
 * cruzamento. 40.000 (o valor anterior) parecia seguro, mas cada leitura
 * pagina de 1000 em 1000 (getStoredCandles) — depois que o arquivamento
 * aprofunda o histórico de verdade, isso virou até 40 idas ao banco POR
 * ATIVO, vezes ~230 ativos, TODA chamada do cruzamento, e a varredura
 * travava em 0% por minutos. 2.000 velas (uns 33h contínuas de M1) já cobre
 * bastante coincidência com no máximo 2 idas ao banco por ativo.
 */
const MAX_ARCHIVE_CANDLES = 2_000;
/** Quando o ativo ainda não tem nada arquivado, busca só um bloco recente. */
const FIRST_TIME_BLOCKS = 1;

/**
 * Garante que o banco tenha as velas recentes deste ativo em dia: busca na
 * corretora só o buraco entre a última vela salva (getNewestCandleTime — uma
 * linha, não o arquivo inteiro) e agora, e grava o que faltava. Quem lê o
 * arquivo para comparar é a etapa de cruzamento, direto do banco — nunca
 * volta pronto daqui, porque manter esse resultado em memória entre chamadas
 * é exatamente o que causava o bug de dados sumindo (ver mirrorScanChunk).
 */
async function loadHistory(
  fetchCandles: (name: string, size: number, count: number, to?: number) => Promise<MirrorCandle[]>,
  iqName: string,
  timeframeLabel: string,
  sizeSeconds: number,
  maxRecentBlocks: number,
): Promise<void> {
  const newestStoredTime = await getNewestCandleTime(iqName, timeframeLabel);
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
    fresh.push(...chunk);
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
}

/** Histórico arquivado de um ativo, lido do banco para servir de "palheiro" na busca. */
interface StoredSeries {
  label: string;
  history: MirrorCandle[];
  index: MirrorSeriesIndex;
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
  // O cruzamento remonta o palheiro inteiro do banco a cada chamada (ver
  // mirrorScanChunk), então um lote maior nessa fase significa menos vezes
  // repetindo essa leitura no total da varredura.
  limit: z.number().int().min(1).max(50).default(10),
  // Teto de blocos RECENTES buscados na corretora por ativo. O histórico
  // profundo vem do arquivo no banco (backfillArchiveChunk), então aqui só se
  // cobre o buraco entre a última vela salva e agora — 2 blocos já bastam.
  historyBlocks: z.number().int().min(1).max(6).default(2),
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
  /**
   * Na coleta: ativos atualizados NESTA chamada (o navegador acumula entre
   * chamadas). No cruzamento: total de ativos com arquivo suficiente no
   * banco NESTE MOMENTO — lido fresco a cada chamada, por isso é estável.
   */
  storedAssets: number;
  storedCandles: number;
  skippedAssets: string[];
  nextOffset: number | null;
  totalAssets: number;
  error?: string;
}

/**
 * Uma etapa da varredura global. O navegador chama em sequência até cobrir todo
 * o catálogo: primeiro coletando o histórico de todos os ativos (do banco,
 * completando na corretora só o que falta), depois cruzando cada ativo ao vivo
 * contra o histórico de TODOS os outros — só assim a comparação é simétrica e
 * completa. Cada chamada processa até `SCAN_CONCURRENCY` ativos em paralelo.
 */
export const mirrorScanChunk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => chunkSchema.parse(input))
  .handler(async ({ data }): Promise<MirrorChunkResult> => {
    const { fetchCandles, IqOptionBackoffError } = await import("@/lib/iqoption/iqoption.server");
    const size = timeframeSeconds(data.timeframe);
    const catalog = buildCatalog(data.assets);

    const base: MirrorChunkResult = {
      phase: data.phase,
      groups: [],
      processed: 0,
      storedAssets: 0,
      storedCandles: 0,
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
        await mapWithConcurrency(batch, SCAN_CONCURRENCY, async ({ iqName, label }) => {
          try {
            await loadHistory(fetchCandles, iqName, data.timeframe, size, data.historyBlocks);
            processed++;
          } catch (error) {
            if (error instanceof IqOptionBackoffError) throw error;
            console.error(`[mirror] loadHistory falhou para ${iqName}:`, error);
            skipped.push(label);
          }
        });
        return {
          ...base,
          processed,
          storedAssets: processed,
          skippedAssets: skipped,
          nextOffset,
        };
      }

      // ---- fase de cruzamento ----
      // O "palheiro" (histórico arquivado de cada ativo) é lido direto do
      // banco A CADA CHAMADA, nunca de um cache em memória entre chamadas: o
      // Cloudflare Workers pode atender cada requisição num isolado
      // diferente, e um Map de módulo não sobrevive de forma confiável de uma
      // chamada para a outra — a mesma restrição por trás do bug de socket
      // corrigido antes, só que aqui sem lançar erro nenhum: os dados só
      // desapareciam em silêncio (por isso "9 ativos com histórico" mesmo
      // depois de centenas processados, e o contador às vezes até diminuindo).
      const haystack = new Map<string, StoredSeries>();
      await mapWithConcurrency(catalog, HAYSTACK_CONCURRENCY, async ({ iqName, label }) => {
        const history = await getStoredCandles(iqName, data.timeframe, {
          maxCandles: MAX_ARCHIVE_CANDLES,
        });
        if (history.length < data.windowSize + 6) return;
        haystack.set(iqName, { label, history, index: buildSeriesIndex(history) });
      });
      let haystackCandles = 0;
      for (const s of haystack.values()) haystackCandles += s.history.length;

      const groups: MirrorAssetGroup[] = [];
      const skipped: string[] = [];
      let processed = 0;

      await mapWithConcurrency(batch, SCAN_CONCURRENCY, async ({ iqName, label }) => {
        if (!haystack.has(iqName)) {
          skipped.push(iqName);
          return;
        }
        processed++;

        // A janela ao vivo precisa refletir o instante do cruzamento, não o
        // instante em que o arquivo foi lido — busca sempre fresca, pequena e
        // rápida (o "palheiro" que acabou de ser montado é que pode ser mais
        // antigo, e tudo bem, ele é o passado contra o qual comparamos).
        let liveCandles: MirrorCandle[];
        try {
          liveCandles = await fetchCandles(iqName, size, data.windowSize + 5);
        } catch (error) {
          if (error instanceof IqOptionBackoffError) throw error;
          console.error(`[mirror] falha ao atualizar janela ao vivo de ${iqName}:`, error);
          skipped.push(iqName);
          return;
        }
        // A última vela pode estar em formação: só velas fechadas entram.
        const closed = liveCandles.slice(0, -1);
        const liveWindow = closed.slice(-(data.windowSize + 1));
        if (liveWindow.length < data.windowSize + 1) return;
        const liveStart = liveWindow[0]!.time;

        const found: MirrorMatch[] = [];
        for (const [histName, hist] of haystack) {
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
        if (found.length === 0) return;

        found.sort((a, b) => b.correlation - a.correlation);
        const matches = found.slice(0, MAX_MATCHES);
        groups.push({
          liveAsset: label,
          liveWindow,
          matches,
          consensus: consensusOf(matches),
        });
      });

      groups.sort((a, b) => (b.matches[0]?.correlation ?? 0) - (a.matches[0]?.correlation ?? 0));

      return {
        ...base,
        groups,
        processed,
        storedAssets: haystack.size,
        storedCandles: haystackCandles,
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
