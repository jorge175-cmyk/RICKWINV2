// Persistent candle store (table public.iqoption_candles) plus the archive
// bookkeeping (table public.iqoption_candle_coverage).
//
// Two writers feed it:
//  - the per-minute ingest job (src/routes/api/cron/ingest-candles.ts), which
//    appends the newest closed candle of every asset;
//  - the archive backfill (src/lib/iqoption/backfill.functions.ts), which walks
//    each asset backwards in blocks until the broker has nothing older.
//
// The mirror scan then reads history from here and only asks the broker for the
// few recent candles that are not stored yet — that is what turned a 20+ minute
// scan into a short one. Rows are keyed by (asset, timeframe, time), so
// different assets and timeframes never mix.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export interface StoredCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const PAGE_SIZE = 1000;
const UPSERT_CHUNK = 500;

export interface StoredCandlesOptions {
  /** Ignore candles older than this epoch-second timestamp. */
  sinceTime?: number;
  /** Hard cap on how many of the NEWEST candles are returned. */
  maxCandles?: number;
}

/**
 * Candles saved for this asset+timeframe, oldest first. Reads newest-first
 * internally so `maxCandles` keeps the most recent window (the only part the
 * matcher can compare against a live window), then flips the order back.
 */
export async function getStoredCandles(
  asset: string,
  timeframe: string,
  options: StoredCandlesOptions = {},
): Promise<StoredCandle[]> {
  const cap = options.maxCandles ?? Number.POSITIVE_INFINITY;
  const out: StoredCandle[] = [];
  let from = 0;
  for (;;) {
    const pageSize = Math.min(PAGE_SIZE, Math.max(1, cap - out.length));
    let query = supabaseAdmin
      .from("iqoption_candles")
      .select("time, open, high, low, close, volume")
      .eq("asset", asset)
      .eq("timeframe", timeframe);
    if (options.sinceTime != null) query = query.gte("time", options.sinceTime);
    const { data, error } = await query
      .order("time", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Unable to read stored candles: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < pageSize || out.length >= cap) break;
    from += pageSize;
  }
  return out.reverse();
}

/** Newest stored candle time for this asset+timeframe, or null if nothing is saved yet. */
export async function getNewestCandleTime(
  asset: string,
  timeframe: string,
): Promise<number | null> {
  const { data, error } = await supabaseAdmin
    .from("iqoption_candles")
    .select("time")
    .eq("asset", asset)
    .eq("timeframe", timeframe)
    .order("time", { ascending: false })
    .limit(1);
  if (error) throw new Error(`Unable to read newest candle: ${error.message}`);
  return data?.[0]?.time ?? null;
}

/** Upserts new/updated candles. Chunked to keep each request small. */
export async function saveCandles(
  asset: string,
  timeframe: string,
  candles: StoredCandle[],
): Promise<void> {
  if (candles.length === 0) return;
  for (let i = 0; i < candles.length; i += UPSERT_CHUNK) {
    const chunk = candles.slice(i, i + UPSERT_CHUNK).map((c) => ({ asset, timeframe, ...c }));
    const { error } = await supabaseAdmin
      .from("iqoption_candles")
      .upsert(chunk, { onConflict: "asset,timeframe,time" });
    if (error) throw new Error(`Unable to save candles: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Archive coverage
// ---------------------------------------------------------------------------

export interface CandleCoverage {
  asset: string;
  timeframe: string;
  oldestTime: number | null;
  newestTime: number | null;
  blocksFetched: number;
  complete: boolean;
}

/** Coverage rows for the given assets, keyed by asset name. */
export async function getCoverage(
  timeframe: string,
  assets: string[],
): Promise<Map<string, CandleCoverage>> {
  const out = new Map<string, CandleCoverage>();
  if (assets.length === 0) return out;
  for (let i = 0; i < assets.length; i += 200) {
    const { data, error } = await supabaseAdmin
      .from("iqoption_candle_coverage")
      .select("asset, timeframe, oldest_time, newest_time, blocks_fetched, complete")
      .eq("timeframe", timeframe)
      .in("asset", assets.slice(i, i + 200));
    if (error) throw new Error(`Unable to read candle coverage: ${error.message}`);
    for (const row of data ?? []) {
      out.set(row.asset, {
        asset: row.asset,
        timeframe: row.timeframe,
        oldestTime: row.oldest_time,
        newestTime: row.newest_time,
        blocksFetched: row.blocks_fetched,
        complete: row.complete,
      });
    }
  }
  return out;
}

/** Records how far back this asset's archive now goes. */
export async function saveCoverage(
  asset: string,
  timeframe: string,
  patch: {
    oldestTime?: number | null;
    newestTime?: number | null;
    blocksFetched?: number;
    complete?: boolean;
    lastError?: string | null;
  },
): Promise<void> {
  const row: Record<string, unknown> = { asset, timeframe, updated_at: new Date().toISOString() };
  if (patch.oldestTime !== undefined) row["oldest_time"] = patch.oldestTime;
  if (patch.newestTime !== undefined) row["newest_time"] = patch.newestTime;
  if (patch.blocksFetched !== undefined) row["blocks_fetched"] = patch.blocksFetched;
  if (patch.complete !== undefined) row["complete"] = patch.complete;
  if (patch.lastError !== undefined) row["last_error"] = patch.lastError;
  const { error } = await supabaseAdmin
    .from("iqoption_candle_coverage")
    .upsert(row as never, { onConflict: "asset,timeframe" });
  if (error) throw new Error(`Unable to save candle coverage: ${error.message}`);
}

/** How many candles and assets the archive holds for this timeframe. */
export async function archiveStats(
  timeframe: string,
): Promise<{ assets: number; complete: number }> {
  const { data, error } = await supabaseAdmin
    .from("iqoption_candle_coverage")
    .select("asset, complete")
    .eq("timeframe", timeframe);
  if (error) throw new Error(`Unable to read archive stats: ${error.message}`);
  const rows = data ?? [];
  return { assets: rows.length, complete: rows.filter((r) => r.complete).length };
}
