import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getIqOptionName, timeframeSeconds } from "@/lib/iqoption/mapping";
import {
  consensusOf,
  findMatchesInSeries,
  type MirrorCandle,
  type MirrorConsensus,
  type MirrorMatch,
} from "./mirror";

const inputSchema = z.object({
  asset: z.string().min(2),
  timeframe: z.enum(["M1", "M5", "M15"]),
  /** Quantidade de velas fechadas usadas como assinatura do trecho ao vivo. */
  windowSize: z.number().int().min(12).max(60).default(24),
  /** Ativos que entram na varredura (o próprio ativo é sempre incluído). */
  assets: z.array(z.string()).max(40).default([]),
  /** Blocos de histórico por ativo (cada bloco = 500 velas). */
  historyBlocks: z.number().int().min(1).max(12).default(6),
  minCorrelation: z.number().min(0.7).max(0.999).default(0.93),
});

export interface MirrorSearchResult {
  liveWindow: MirrorCandle[];
  matches: MirrorMatch[];
  consensus: MirrorConsensus;
  scannedAssets: number;
  scannedCandles: number;
  skippedAssets: string[];
  error?: string;
}

const BLOCK_SIZE = 500;
const MAX_MATCHES = 8;

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
    await sleep(350);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Procura trechos históricos que repitam o desenho atual do ativo ao vivo. */
export const findMirrorMatches = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => inputSchema.parse(input))
  .handler(async ({ data }): Promise<MirrorSearchResult> => {
    const { fetchCandles, IqOptionBackoffError } = await import("@/lib/iqoption/iqoption.server");
    const size = timeframeSeconds(data.timeframe);
    const liveName = getIqOptionName(data.asset);

    const empty: MirrorSearchResult = {
      liveWindow: [],
      matches: [],
      consensus: consensusOf([]),
      scannedAssets: 0,
      scannedCandles: 0,
      skippedAssets: [],
    };

    if (!liveName) {
      return { ...empty, error: "Ativo não reconhecido pela corretora." };
    }

    try {
      const liveSeries = await loadHistory(fetchCandles, liveName, size, 1);
      if (liveSeries.length < data.windowSize + 3) {
        return { ...empty, error: "Histórico insuficiente para este ativo e timeframe." };
      }
      // A última vela pode estar em formação: usamos apenas velas fechadas.
      const closed = liveSeries.slice(0, -1);
      const liveWindow = closed.slice(-(data.windowSize + 1));
      const liveStart = liveWindow[0]!.time;

      const candidates = new Map<string, string>();
      candidates.set(liveName, data.asset);
      for (const symbol of data.assets) {
        const name = getIqOptionName(symbol);
        if (name) candidates.set(name, symbol);
      }

      const all: MirrorMatch[] = [];
      const skipped: string[] = [];
      let scannedAssets = 0;
      let scannedCandles = 0;

      for (const [iqName, label] of candidates) {
        try {
          const hist =
            iqName === liveName ? closed : await loadHistory(fetchCandles, iqName, size, data.historyBlocks);
          if (iqName === liveName && data.historyBlocks > 1) {
            const deep = await loadHistory(fetchCandles, iqName, size, data.historyBlocks);
            if (deep.length > hist.length) hist.splice(0, hist.length, ...deep.filter((c) => c.time < liveStart));
          }
          scannedAssets++;
          scannedCandles += hist.length;
          all.push(
            ...findMatchesInSeries(label, data.timeframe, liveWindow, hist, {
              minCorrelation: data.minCorrelation,
              maxPerAsset: 3,
              // Nunca comparar com o próprio trecho ao vivo.
              excludeFrom: iqName === liveName ? liveStart : undefined,
            }),
          );
        } catch (error) {
          if (error instanceof IqOptionBackoffError) throw error;
          skipped.push(label);
        }
        await sleep(200);
      }

      all.sort((a, b) => b.correlation - a.correlation);
      const matches = all.slice(0, MAX_MATCHES);

      return {
        liveWindow,
        matches,
        consensus: consensusOf(matches),
        scannedAssets,
        scannedCandles,
        skippedAssets: skipped,
      };
    } catch (error) {
      console.error("[mirror] search failed", error);
      if (error instanceof IqOptionBackoffError) {
        return {
          ...empty,
          error: "Conexão com a corretora em recuperação. Tente novamente em instantes.",
        };
      }
      return { ...empty, error: "Não foi possível concluir a varredura agora." };
    }
  });
