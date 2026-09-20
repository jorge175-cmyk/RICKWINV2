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
/** Máximo de coincidências mantidas por ativo nos resultados do job em segundo plano. */
const MAX_MATCHES_BACKGROUND = 8;
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
const MIN_PROJECTION_STEPS = 1;
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
 * cruzamento. Restaurado para perto da profundidade histórica (a varredura
 * antiga chegava a ~3 milhões de velas no total, ou seja, uns 13 mil por
 * ativo) — voltar a cortar isso pra 2.000 tirava profundidade demais e
 * parava de achar replays. O que evita estourar CPU agora não é mais cortar
 * a profundidade, e sim dividir também o CATÁLOGO em fatias por chamada
 * (ver haystackOffset/haystackLimit abaixo) — assim a profundidade fica
 * inteira, só espalhada por mais chamadas menores.
 */
const MAX_ARCHIVE_CANDLES = 15_000;
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
export function buildCatalog(assets: string[]): Array<{ iqName: string; label: string }> {
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

const candleSchema = z.object({
  time: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().optional(),
});

const chunkSchema = z.object({
  timeframe: z.enum(["M1", "M5", "M15"]),
  windowSize: z.number().int().min(5).max(60).default(6),
  /** Catálogo completo de ativos da corretora. */
  assets: z.array(z.string()).min(1).max(600),
  offset: z.number().int().min(0).default(0),
  // Teto de segurança: o custo de CPU do cruzamento é (ativos deste lote) ×
  // (ativos NESTA FATIA do palheiro) × (velas por ativo) — ver MATCH_CHUNK e
  // HAYSTACK_CHUNK em mirror.tsx, que são quem realmente controla o tamanho
  // de cada lado nessa fase.
  limit: z.number().int().min(1).max(24).default(10),
  // Teto de blocos RECENTES buscados na corretora por ativo. O histórico
  // profundo vem do arquivo no banco (backfillArchiveChunk), então aqui só se
  // cobre o buraco entre a última vela salva e agora — 2 blocos já bastam.
  historyBlocks: z.number().int().min(1).max(6).default(2),
  minCorrelation: z.number().min(0.7).max(0.999).default(0.93),
  /**
   * "collect" baixa o histórico deste trecho do catálogo.
   * "match" cruza o trecho atual destes ativos contra UMA FATIA do catálogo
   * (haystackOffset/haystackLimit) — o navegador chama de novo com a fatia
   * seguinte até cobrir o catálogo inteiro para este MESMO lote de ativos ao
   * vivo, antes de avançar para o próximo lote.
   */
  phase: z.enum(["collect", "match"]),
  /** Só na fase "match": qual fatia do catálogo (o "palheiro") processar agora. */
  haystackOffset: z.number().int().min(0).default(0),
  haystackLimit: z.number().int().min(1).max(100).default(10),
  /**
   * Janela ao vivo já buscada numa fatia anterior deste MESMO lote de ativos,
   * devolvida pelo servidor e ecoada de volta aqui — evita reabrir conexão
   * com a corretora a cada fatia só para reler a mesma ponta viva.
   */
  liveWindows: z.record(z.string(), z.array(candleSchema)).optional(),
});

export interface MirrorAssetGroup {
  liveAsset: string;
  liveWindow: MirrorCandle[];
  matches: MirrorMatch[];
  consensus: MirrorConsensus;
}

/** Contribuição de UMA fatia do palheiro para um ativo ao vivo — ainda não é o resultado final. */
export interface MirrorPartialGroup {
  liveAsset: string;
  liveWindow: MirrorCandle[];
  matches: MirrorMatch[];
}

export interface MirrorChunkResult {
  phase: "collect" | "match";
  /** Só na fase "match": achados desta fatia do palheiro — o navegador funde entre fatias. */
  partialGroups: MirrorPartialGroup[];
  /** Só na fase "match": janela ao vivo desta chamada, para ecoar nas próximas fatias do mesmo lote. */
  liveWindows: Record<string, MirrorCandle[]>;
  /** Ativos processados nesta chamada. */
  processed: number;
  /**
   * Na coleta: ativos atualizados NESTA chamada (o navegador acumula entre
   * chamadas). No cruzamento: ativos com arquivo suficiente NESTA FATIA do
   * palheiro (o navegador também acumula, entre fatias).
   */
  storedAssets: number;
  storedCandles: number;
  skippedAssets: string[];
  /** Próximo lote de ativos AO VIVO (avança só depois de cobrir todas as fatias do palheiro). */
  nextOffset: number | null;
  /** Só na fase "match": próxima fatia do palheiro para este MESMO lote de ativos ao vivo. */
  haystackNextOffset: number | null;
  totalAssets: number;
  error?: string;
}

export interface MatchSliceParams {
  fetchCandles: (name: string, size: number, count: number, to?: number) => Promise<MirrorCandle[]>;
  /** Reconhece IqOptionBackoffError sem precisar importar a classe aqui (mantém iqoption.server fora do bundle do cliente). */
  isBackoffError: (error: unknown) => boolean;
  timeframe: "M1" | "M5" | "M15";
  windowSize: number;
  minCorrelation: number;
  /** Catálogo completo (para calcular corretamente o `haystackNextOffset`). */
  catalog: Array<{ iqName: string; label: string }>;
  /** Lote de ativos AO VIVO a comparar nesta chamada. */
  batch: Array<{ iqName: string; label: string }>;
  haystackOffset: number;
  haystackLimit: number;
  /** Aceita o formato bruto vindo do zod (volume opcional inclui `undefined`); normalizado internamente. */
  liveWindowsIn?: Record<string, Array<z.infer<typeof candleSchema>>> | undefined;
}

export interface MatchSliceResult {
  partialGroups: MirrorPartialGroup[];
  liveWindows: Record<string, MirrorCandle[]>;
  processed: number;
  skippedAssets: string[];
  storedAssets: number;
  storedCandles: number;
  haystackNextOffset: number | null;
}

/**
 * O núcleo do cruzamento: compara um lote de ativos ao vivo contra UMA FATIA
 * do catálogo (o "palheiro"). Usado tanto pela varredura manual
 * (mirrorScanChunk, abaixo) quanto pelo job de detecção em segundo plano
 * (src/routes/api/cron/mirror-scan.ts) — mantido num só lugar porque é
 * exatamente o código que precisou de ajuste fino para não estourar o limite
 * de CPU do Cloudflare Workers (ver MAX_ARCHIVE_CANDLES/HAYSTACK_CONCURRENCY).
 */
export async function runMatchSlice(params: MatchSliceParams): Promise<MatchSliceResult> {
  const {
    fetchCandles,
    isBackoffError,
    timeframe,
    windowSize,
    minCorrelation,
    catalog,
    batch,
    haystackOffset,
    haystackLimit,
    liveWindowsIn,
  } = params;
  const size = timeframeSeconds(timeframe);

  const haystackBatch = catalog.slice(haystackOffset, haystackOffset + haystackLimit);
  const haystackNextOffset =
    haystackOffset + haystackBatch.length < catalog.length
      ? haystackOffset + haystackBatch.length
      : null;

  const haystack = new Map<string, StoredSeries>();
  await mapWithConcurrency(haystackBatch, HAYSTACK_CONCURRENCY, async ({ iqName, label }) => {
    const history = await getStoredCandles(iqName, timeframe, { maxCandles: MAX_ARCHIVE_CANDLES });
    if (history.length < windowSize + 6) return;
    haystack.set(iqName, { label, history, index: buildSeriesIndex(history) });
  });
  let haystackCandles = 0;
  for (const s of haystack.values()) haystackCandles += s.history.length;

  const liveWindows: Record<string, MirrorCandle[]> = {};
  const partialGroups: MirrorPartialGroup[] = [];
  const skipped: string[] = [];
  let processed = 0;

  await mapWithConcurrency(batch, SCAN_CONCURRENCY, async ({ iqName, label }) => {
    // A janela ao vivo precisa refletir o instante do cruzamento, não o
    // instante em que o arquivo foi lido. Mas como o MESMO lote de ativos ao
    // vivo é reprocessado uma vez por fatia do palheiro, a janela só é
    // buscada de novo na corretora na PRIMEIRA fatia — nas seguintes, quem
    // chama ecoa de volta a que já veio, evitando abrir conexão à toa várias
    // vezes só para reler a mesma ponta viva.
    let liveWindow: MirrorCandle[] | undefined = liveWindowsIn?.[iqName]?.map((c) => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume ?? 0,
    }));
    if (!liveWindow) {
      let liveCandles: MirrorCandle[];
      try {
        liveCandles = await fetchCandles(iqName, size, windowSize + 5);
      } catch (error) {
        if (isBackoffError(error)) throw error;
        console.error(`[mirror] falha ao atualizar janela ao vivo de ${iqName}:`, error);
        skipped.push(iqName);
        return;
      }
      // A última vela pode estar em formação: só velas fechadas entram.
      const closed = liveCandles.slice(0, -1);
      liveWindow = closed.slice(-(windowSize + 1));
    }
    if (liveWindow.length < windowSize + 1) {
      skipped.push(iqName);
      return;
    }
    liveWindows[iqName] = liveWindow;
    processed++;
    const liveStart = liveWindow[0]!.time;

    const found: MirrorMatch[] = [];
    for (const [histName, hist] of haystack) {
      found.push(
        ...findMatchesFast(hist.label, timeframe, liveWindow, hist.history, hist.index, {
          minCorrelation,
          maxPerAsset: 3,
          excludeFrom: histName === iqName ? liveStart : undefined,
          projectionSteps: PROJECTION_STEPS,
          stepSeconds: size,
        }).filter((m) => m.projection.length >= MIN_PROJECTION_STEPS),
      );
    }
    if (found.length > 0) {
      partialGroups.push({ liveAsset: label, liveWindow, matches: found });
    }
  });

  return {
    partialGroups,
    liveWindows,
    processed,
    skippedAssets: skipped,
    storedAssets: haystack.size,
    storedCandles: haystackCandles,
    haystackNextOffset,
  };
}

/**
 * Uma etapa da varredura global. O navegador chama em sequência até cobrir todo
 * o catálogo: primeiro coletando o histórico de todos os ativos (do banco,
 * completando na corretora só o que falta), depois cruzando cada lote de
 * ativos ao vivo contra o catálogo inteiro — em fatias, para o cálculo de
 * correlação nunca crescer demais numa única chamada (ver haystackOffset).
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
      partialGroups: [],
      liveWindows: {},
      processed: 0,
      storedAssets: 0,
      storedCandles: 0,
      skippedAssets: [],
      nextOffset: null,
      haystackNextOffset: null,
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
      //
      // O CATÁLOGO INTEIRO nunca é lido numa chamada só: isso fazia o cálculo
      // de correlação (ativos deste lote × ativos no palheiro × velas de
      // cada um) estourar o limite de CPU do Cloudflare Workers antes de
      // terminar. Cada chamada processa só uma FATIA do catálogo
      // (haystackOffset/haystackLimit); o navegador funde os achados de
      // todas as fatias antes de considerar um lote de ativos ao vivo
      // concluído. A lógica em si mora em runMatchSlice, reaproveitada pelo
      // job de detecção em segundo plano (src/routes/api/cron/mirror-scan.ts).
      const result = await runMatchSlice({
        fetchCandles,
        isBackoffError: (error) => error instanceof IqOptionBackoffError,
        timeframe: data.timeframe,
        windowSize: data.windowSize,
        minCorrelation: data.minCorrelation,
        catalog,
        batch,
        haystackOffset: data.haystackOffset,
        haystackLimit: data.haystackLimit,
        liveWindowsIn: data.liveWindows,
      });

      return { ...base, ...result, nextOffset };
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

const replayResultsSchema = z.object({
  timeframe: z.enum(["M1", "M5", "M15"]),
});

export interface ReplayResults {
  groups: MirrorAssetGroup[];
  /** Horário do achado mais recente entre os grupos, ou null se não há nada salvo ainda. */
  updatedAt: string | null;
}

/**
 * Lê os replays já encontrados pelo job em segundo plano (ver
 * src/routes/api/cron/mirror-scan.ts) — instantâneo, sem rodar varredura
 * nenhuma. É o que a tela do Espelho OTC mostra por padrão.
 */
export const getReplayResults = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => replayResultsSchema.parse(input))
  .handler(async ({ data }): Promise<ReplayResults> => {
    const { getReplayGroups } = await import("@/lib/analysis/replayStore.server");
    const stored = await getReplayGroups(data.timeframe);
    let updatedAt: string | null = null;
    for (const g of stored) {
      if (updatedAt == null || g.foundAt > updatedAt) updatedAt = g.foundAt;
    }
    const groups = stored
      .map((g) => {
        const matches = [...g.matches]
          .sort((a, b) => b.correlation - a.correlation)
          .slice(0, MAX_MATCHES_BACKGROUND);
        return {
          liveAsset: g.liveAsset,
          liveWindow: g.liveWindow,
          matches,
          consensus: consensusOf(matches),
        };
      })
      .sort((a, b) => (b.matches[0]?.correlation ?? 0) - (a.matches[0]?.correlation ?? 0));
    return { groups, updatedAt };
  });
