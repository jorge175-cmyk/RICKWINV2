// Persistent candle store (table public.iqoption_candles): a background job
// keeps this fed with the newest closed M1/M5 candle for every asset, so the
// mirror scan mostly reads from here instead of re-downloading everything
// from the broker on every run. Rows are keyed by (asset, timeframe, time),
// so different assets and different timeframes never mix.
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

/** All candles saved for this asset+timeframe, oldest first. Paginates past PostgREST's row cap. */
export async function getStoredCandles(asset: string, timeframe: string): Promise<StoredCandle[]> {
  const out: StoredCandle[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("iqoption_candles")
      .select("time, open, high, low, close, volume")
      .eq("asset", asset)
      .eq("timeframe", timeframe)
      .order("time", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Unable to read stored candles: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
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
