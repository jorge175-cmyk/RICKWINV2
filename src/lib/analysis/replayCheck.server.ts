// Verificação de replay a cada nova vela, feita SÓ com o que já está no banco.
//
// O job por minuto (src/routes/api/cron/ingest-candles.ts) salva a vela nova de
// cada ativo e, na mesma chamada, pede esta verificação: pega as 5 últimas
// velas fechadas de cada ativo (a "janela ao vivo") e procura esse mesmo
// desenho no arquivo histórico salvo — no próprio ativo, em outro ativo, em
// outro dia/mês, e também invertido no tempo e/ou no preço.
//
// Por que em fatias: o arquivo tem centenas de ativos com muitas velas cada, e
// cada chamada roda num worker com limite de CPU. Então o palheiro é varrido
// em fatias rotativas (HAYSTACK_SLICE ativos por chamada), guardando no cursor
// onde parou. As janelas ao vivo, ao contrário, são TODAS reavaliadas em cada
// chamada — é isso que garante "a cada vela nova, analisa as 5 últimas".
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  buildSeriesIndex,
  findMatchesFast,
  type MirrorCandle,
  type MirrorMatch,
} from "./mirror";
import { getStoredCandles } from "@/lib/iqoption/candleHistory.server";
import {
  claimScanCursor,
  saveScanCursor,
  clearReplayMatches,
  insertReplayMatches,
} from "./replayStore.server";

/** 5 velas idênticas seguidas já contam como replay. */
export const LIVE_WINDOW_SIZE = 5;
/** Quantos ativos do arquivo são comparados por chamada. */
const HAYSTACK_SLICE = 12;
/** Profundidade lida por ativo do arquivo (mais recentes). */
const HAYSTACK_MAX_CANDLES = 6000;
/** Só replay praticamente idêntico interessa. */
const MIN_CORRELATION = 0.995;
const EXACT_TOLERANCE = 0.05;
/** Achados mais velhos que isto já não servem para operar. */
const MATCH_TTL_MINUTES = 20;

function stepSecondsOf(timeframe: string): number {
  return timeframe === "M15" ? 900 : timeframe === "M5" ? 300 : 60;
}

/**
 * Últimas `LIVE_WINDOW_SIZE` velas fechadas de cada ativo, lidas numa única
 * consulta (sem filtrar por ativo) para não fazer centenas de idas ao banco.
 */
async function loadLiveWindows(timeframe: string): Promise<Map<string, MirrorCandle[]>> {
  const step = stepSecondsOf(timeframe);
  const cutoff = Math.floor(Date.now() / 1000) - step * (LIVE_WINDOW_SIZE + 4);
  const { data, error } = await supabaseAdmin
    .from("iqoption_candles")
    .select("asset, time, open, high, low, close, volume")
    .eq("timeframe", timeframe)
    .gte("time", cutoff)
    .order("time", { ascending: true });
  if (error) throw new Error(`Unable to read live windows: ${error.message}`);

  const byAsset = new Map<string, MirrorCandle[]>();
  for (const row of data ?? []) {
    const list = byAsset.get(row.asset) ?? [];
    list.push({
      time: row.time,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume ?? 0,
    });
    byAsset.set(row.asset, list);
  }

  const out = new Map<string, MirrorCandle[]>();
  for (const [asset, list] of byAsset) {
    if (list.length < LIVE_WINDOW_SIZE) continue;
    out.set(asset, list.slice(-LIVE_WINDOW_SIZE));
  }
  return out;
}

/** Ativos que têm arquivo histórico gravado neste timeframe, em ordem estável. */
async function loadHaystackAssets(timeframe: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("iqoption_candle_coverage")
    .select("asset")
    .eq("timeframe", timeframe)
    .order("asset", { ascending: true });
  if (error) throw new Error(`Unable to read archive assets: ${error.message}`);
  return (data ?? []).map((r) => r.asset);
}

/** Apaga achados velhos: a janela ao vivo deles já não é a atual. */
async function pruneStaleMatches(timeframe: string): Promise<void> {
  const cutoff = new Date(Date.now() - MATCH_TTL_MINUTES * 60_000).toISOString();
  const { error } = await supabaseAdmin
    .from("mirror_replay_matches" as never)
    .delete()
    .eq("timeframe", timeframe)
    .lt("found_at", cutoff);
  if (error) throw new Error(`Unable to prune replay matches: ${error.message}`);
}

export interface ReplayCheckResult {
  ok: boolean;
  liveAssets: number;
  haystackAssets: number;
  haystackScanned: number;
  matchesFound: number;
  skipped?: string;
}

/**
 * Uma passada da verificação: todas as janelas ao vivo contra a próxima fatia
 * do arquivo. Devolve quantos replays foram gravados.
 */
export async function runReplayCheck(timeframe: string): Promise<ReplayCheckResult> {
  // A trava do cursor impede que duas chamadas sobrepostas (o job por minuto
  // mais um disparo manual, por exemplo) embaralhem o progresso.
  const cursor = await claimScanCursor(`${timeframe}:live`, 45);
  if (!cursor) {
    return {
      ok: true,
      liveAssets: 0,
      haystackAssets: 0,
      haystackScanned: 0,
      matchesFound: 0,
      skipped: "busy",
    };
  }

  const [liveWindows, haystackAssets] = await Promise.all([
    loadLiveWindows(timeframe),
    loadHaystackAssets(timeframe),
  ]);

  if (liveWindows.size === 0 || haystackAssets.length === 0) {
    await saveScanCursor(`${timeframe}:live`, { ...cursor, haystackOffset: 0, liveWindows: {} });
    return {
      ok: true,
      liveAssets: liveWindows.size,
      haystackAssets: haystackAssets.length,
      haystackScanned: 0,
      matchesFound: 0,
    };
  }

  const offset = cursor.haystackOffset % haystackAssets.length;
  const slice = haystackAssets.slice(offset, offset + HAYSTACK_SLICE);
  const stepSeconds = stepSecondsOf(timeframe);

  // Acumula por ativo ao vivo para gravar de uma vez só no fim.
  const found = new Map<string, MirrorMatch[]>();

  for (const histAsset of slice) {
    let hist: MirrorCandle[];
    try {
      hist = await getStoredCandles(histAsset, timeframe, {
        maxCandles: HAYSTACK_MAX_CANDLES,
      });
    } catch {
      continue;
    }
    if (hist.length < LIVE_WINDOW_SIZE + 4) continue;
    const index = buildSeriesIndex(hist);

    for (const [liveAsset, live] of liveWindows) {
      const matches = findMatchesFast(histAsset, timeframe, live, hist, index, {
        minCorrelation: MIN_CORRELATION,
        exactOnly: true,
        exactTolerance: EXACT_TOLERANCE,
        maxPerAsset: 2,
        projectionSteps: 5,
        stepSeconds,
        // No mesmo ativo, não casar com o próprio trecho ao vivo.
        excludeFrom: histAsset === liveAsset ? live[0]!.time : undefined,
      }).filter((m) => m.exact);
      if (matches.length === 0) continue;
      const list = found.get(liveAsset) ?? [];
      list.push(...matches);
      found.set(liveAsset, list);
    }
  }

  await pruneStaleMatches(timeframe);

  let matchesFound = 0;
  for (const [liveAsset, matches] of found) {
    const live = liveWindows.get(liveAsset)!;
    // Substitui o que havia deste ativo: a janela ao vivo mudou de vela.
    await clearReplayMatches(timeframe, [liveAsset]);
    await insertReplayMatches(
      timeframe,
      liveAsset,
      live,
      matches.map((m) => ({
        histAsset: m.asset,
        transform: m.transform,
        correlation: m.correlation,
        similarity: m.similarity,
        maxDeviation: m.maxDeviation,
        exact: m.exact,
        startTime: m.startTime,
        endTime: m.endTime,
        volatilityRatio: m.volatilityRatio,
        predictedReturn: m.predictedReturn,
        direction: m.direction,
        projectedClose: m.projectedClose,
        window: m.window,
        nextCandle: m.nextCandle,
        projection: m.projection,
      })),
    );
    matchesFound += matches.length;
  }

  const nextOffset = (offset + slice.length) % haystackAssets.length;
  await saveScanCursor(`${timeframe}:live`, {
    liveOffset: 0,
    haystackOffset: nextOffset,
    liveWindows: {},
  });

  return {
    ok: true,
    liveAssets: liveWindows.size,
    haystackAssets: haystackAssets.length,
    haystackScanned: slice.length,
    matchesFound,
  };
}
