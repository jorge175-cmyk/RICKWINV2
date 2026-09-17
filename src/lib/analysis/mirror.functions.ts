import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getIqOptionName, timeframeSeconds } from "@/lib/iqoption/mapping";
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
/** Quantas velas à frente cada coincidência precisa projetar. */
const PROJECTION_STEPS = 5;
/** Tempo que o histórico baixado continua reaproveitável na varredura. */
const STORE_TTL_MS = 25 * 60 * 1000;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Baixa blocos de histórico voltando no tempo e devolve uma série contínua. */
async function loadHistory(
  fetchCandles: (name: string, size: number, count: number, to?: number) => Promise<MirrorCandle[]>,
  iqName: string,
  sizeSeconds: number,
  blocks: number,
): Promise<MirrorCandle[]> {
  const byTime = new Map<number, MirrorCandle>();
  let to = Math.floor(Date.now() / 1000);
  for (let i = 0; i < blocks; i++) {
    const chunk = await fetchCandles(iqName, sizeSeconds, BLOCK_SIZE, i === 0 ? undefined : to);
    if (chunk.length === 0) break;
    for (const c of chunk) byTime.set(c.time, c);
    const oldest = chunk[0]!.time;
    if (oldest >= to) break;
    to = oldest - sizeSeconds;
    // Espaçamento entre requisições: evita bloqueio por excesso de acessos.
    await sleep(250);
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
  historyBlocks: z.number().int().min(1).max(6).default(2),
  /** Replay exige correlação altíssima; abaixo disso é só "parecido". */
  minCorrelation: z.number().min(0.99).max(0.9999).default(0.995),
  /** Desvio máximo tolerado por vela (fração do tamanho típico da vela). */
  exactTolerance: z.number().min(0.005).max(0.15).default(0.05),
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
 * o catálogo: primeiro coletando o histórico de todos os ativos, depois cruzando
 * cada ativo ao vivo contra o histórico de todos os outros.
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
    const nextOffset = data.offset + batch.length < catalog.length ? data.offset + batch.length : null;
    if (batch.length === 0) return { ...base, nextOffset: null };

    try {
      if (data.phase === "collect") {
        const skipped: string[] = [];
        let processed = 0;
        for (const { iqName, label } of batch) {
          const existing = store.get(iqName);
          if (existing && existing.at > Date.now() - STORE_TTL_MS) {
            processed++;
            continue;
          }
          try {
            const history = await loadHistory(fetchCandles, iqName, size, data.historyBlocks);
            if (history.length < data.windowSize + 6) {
              skipped.push(label);
              continue;
            }
            store.set(iqName, { label, history, index: buildSeriesIndex(history), at: Date.now() });
            processed++;
          } catch (error) {
            if (error instanceof IqOptionBackoffError) throw error;
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

      // ---- fase de cruzamento: nenhuma requisição à corretora ----
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
        // A última vela pode estar em formação: só velas fechadas entram.
        const closed = live.history.slice(0, -1);
        const liveWindow = closed.slice(-(data.windowSize + 1));
        if (liveWindow.length < data.windowSize + 1) continue;
        const liveStart = liveWindow[0]!.time;

        const found: MirrorMatch[] = [];
        for (const [histName, hist] of store) {
          found.push(
            ...findMatchesFast(hist.label, data.timeframe, liveWindow, hist.history, hist.index, {
              minCorrelation: data.minCorrelation,
              exactOnly: true,
              exactTolerance: data.exactTolerance,
              maxPerAsset: 3,
              excludeFrom: histName === iqName ? liveStart : undefined,
              projectionSteps: PROJECTION_STEPS,
              stepSeconds: size,
            }).filter((m) => m.exact && m.projection.length >= PROJECTION_STEPS),
          );
        }
        if (found.length === 0) continue;

        found.sort((a, b) => a.maxDeviation - b.maxDeviation || b.correlation - a.correlation);
        const matches = found.slice(0, MAX_MATCHES);
        groups.push({
          liveAsset: live.label,
          liveWindow,
          matches,
          consensus: consensusOf(matches),
        });
      }

      groups.sort(
        (a, b) =>
          (a.matches[0]?.maxDeviation ?? Number.POSITIVE_INFINITY) -
            (b.matches[0]?.maxDeviation ?? Number.POSITIVE_INFINITY) ||
          (b.matches[0]?.correlation ?? 0) - (a.matches[0]?.correlation ?? 0),
      );

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
