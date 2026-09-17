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
/** Tempo que o histórico baixado continua reaproveitável na varredura. */
const STORE_TTL_MS = 25 * 60 * 1000;

export type Broker = "iqoption" | "binolla";

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Carrega o módulo da corretora escolhida. Mantém os dois brokers com a mesma
 * forma (fetchCandles + classe de erro "conexão em recuperação") para que o
 * resto do arquivo não precise saber qual corretora está em uso.
 */
async function loadBroker(broker: Broker) {
  if (broker === "binolla") {
    const mod = await import("@/lib/binolla/binolla.server");
    return {
      fetchCandles: mod.fetchCandles,
      isBackoffError: (error: unknown) => error instanceof mod.BinollaAuthError,
      backoffMessage: "Token da Binolla ausente, expirado ou inválido. Atualize o BINOLLA_ACCESS_TOKEN.",
    };
  }
  const mod = await import("@/lib/iqoption/iqoption.server");
  return {
    fetchCandles: mod.fetchCandles,
    isBackoffError: (error: unknown) => error instanceof mod.IqOptionBackoffError,
    backoffMessage: "Conexão com a corretora em recuperação. Retomando em instantes.",
  };
}

/** Normaliza o nome de um ativo para o formato que a corretora reconhece. */
function translateFor(broker: Broker): (symbol: string) => string | null {
  if (broker === "binolla") {
    // O catálogo da Binolla já vem no formato nativo dela (ex.: "EURUSD_otc");
    // não existe tradução como a da IQ Option, só validação simples.
    return (symbol: string) => (symbol && symbol.trim() ? symbol.trim() : null);
  }
  return getIqOptionName;
}

/** Baixa blocos de histórico voltando no tempo e devolve uma série contínua. */
async function loadHistory(
  fetchCandles: (name: string, size: number, count: number, to?: number) => Promise<MirrorCandle[]>,
  providerName: string,
  sizeSeconds: number,
  blocks: number,
): Promise<MirrorCandle[]> {
  const byTime = new Map<number, MirrorCandle>();
  let to = Math.floor(Date.now() / 1000);
  for (let i = 0; i < blocks; i++) {
    const chunk = await fetchCandles(providerName, sizeSeconds, BLOCK_SIZE, i === 0 ? undefined : to);
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
 * Chave composta por corretora+timeframe: os dados de uma nunca se misturam
 * com os da outra mesmo que os nomes de ativo coincidam por acaso.
 */
const historyStore = new Map<string, Map<string, StoredSeries>>();

function storeFor(broker: Broker, timeframe: string): Map<string, StoredSeries> {
  const key = `${broker}:${timeframe}`;
  let bucket = historyStore.get(key);
  if (!bucket) {
    bucket = new Map();
    historyStore.set(key, bucket);
  }
  const cutoff = Date.now() - STORE_TTL_MS;
  for (const [k, value] of bucket) {
    if (value.at < cutoff) bucket.delete(k);
  }
  return bucket;
}

/** Catálogo normalizado (nomes reconhecidos pela corretora, sem repetição). */
function buildCatalog(assets: string[], translate: (symbol: string) => string | null) {
  const out: Array<{ providerName: string; label: string }> = [];
  const seen = new Set<string>();
  for (const symbol of assets) {
    const providerName = translate(symbol);
    if (!providerName || seen.has(providerName)) continue;
    seen.add(providerName);
    out.push({ providerName, label: symbol });
  }
  return out;
}

const chunkSchema = z.object({
  broker: z.enum(["iqoption", "binolla"]).default("iqoption"),
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
    const { fetchCandles, isBackoffError, backoffMessage } = await loadBroker(data.broker);
    const size = timeframeSeconds(data.timeframe);
    const catalog = buildCatalog(data.assets, translateFor(data.broker));
    const store = storeFor(data.broker, data.timeframe);

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
        for (const { providerName, label } of batch) {
          const existing = store.get(providerName);
          if (existing && existing.at > Date.now() - STORE_TTL_MS) {
            processed++;
            continue;
          }
          try {
            const history = await loadHistory(fetchCandles, providerName, size, data.historyBlocks);
            if (history.length < data.windowSize + 6) {
              // Sem isto, uma falha silenciosa de fetchCandles (ex.: sessão da
              // corretora não sobrevivendo entre requisições) some sem deixar
              // rastro nos logs - aparece só como "sem histórico suficiente".
              console.warn(
                `[mirror] histórico insuficiente para ${providerName}: ${history.length} vela(s)`,
              );
              skipped.push(label);
              continue;
            }
            store.set(providerName, { label, history, index: buildSeriesIndex(history), at: Date.now() });
            processed++;
          } catch (error) {
            if (isBackoffError(error)) throw error;
            console.error(`[mirror] loadHistory falhou para ${providerName}:`, error);
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

      for (const { providerName } of batch) {
        const live = store.get(providerName);
        if (!live) {
          skipped.push(providerName);
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
              maxPerAsset: 3,
              excludeFrom: histName === providerName ? liveStart : undefined,
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
      if (isBackoffError(error)) {
        return { ...base, nextOffset, error: backoffMessage };
      }
      return { ...base, nextOffset, error: "Não foi possível concluir esta etapa da varredura." };
    }
  });
