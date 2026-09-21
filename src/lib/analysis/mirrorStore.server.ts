// Persistência do histórico de velas usado pela varredura de espelho.
// Objetivo: baixar o histórico uma única vez por ativo e, nas varreduras
// seguintes, buscar apenas as velas novas.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { MirrorCandle } from "./mirror";

/** Quantas velas por ativo/timeframe mantemos em memória para o cruzamento. */
export const MAX_STORED_CANDLES = 4000;
const PAGE = 1000;

export interface CoverageRow {
  oldest_time: number | null;
  newest_time: number | null;
  blocks_fetched: number;
  complete: boolean;
}

/** Lê as velas salvas (mais recentes primeiro no banco, devolvidas em ordem crescente). */
export async function readSavedCandles(
  asset: string,
  timeframe: string,
  max = MAX_STORED_CANDLES,
): Promise<MirrorCandle[]> {
  const out: MirrorCandle[] = [];
  for (let offset = 0; offset < max; offset += PAGE) {
    const size = Math.min(PAGE, max - offset);
    const { data, error } = await supabaseAdmin
      .from("iqoption_candles")
      .select("time, open, high, low, close, volume")
      .eq("asset", asset)
      .eq("timeframe", timeframe)
      .order("time", { ascending: false })
      .range(offset, offset + size - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) {
      out.push({
        time: Number(row.time),
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume ?? 0,
      });
    }
    if (data.length < size) break;
  }
  return out.sort((a, b) => a.time - b.time);
}

export async function readCoverage(asset: string, timeframe: string): Promise<CoverageRow | null> {
  const { data, error } = await supabaseAdmin
    .from("iqoption_candle_coverage")
    .select("oldest_time, newest_time, blocks_fetched, complete")
    .eq("asset", asset)
    .eq("timeframe", timeframe)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    oldest_time: data.oldest_time === null ? null : Number(data.oldest_time),
    newest_time: data.newest_time === null ? null : Number(data.newest_time),
    blocks_fetched: data.blocks_fetched ?? 0,
    complete: data.complete ?? false,
  };
}

/** Grava as velas novas (idempotente pela chave ativo/timeframe/horário). */
export async function saveCandles(
  asset: string,
  timeframe: string,
  candles: MirrorCandle[],
): Promise<void> {
  if (candles.length === 0) return;
  const rows = candles.map((c) => ({
    asset,
    timeframe,
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume ?? 0,
    updated_at: new Date().toISOString(),
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabaseAdmin
      .from("iqoption_candles")
      .upsert(rows.slice(i, i + 500), { onConflict: "asset,timeframe,time" });
    if (error) throw error;
  }
}

export async function saveCoverage(
  asset: string,
  timeframe: string,
  patch: { oldest: number | null; newest: number | null; blocks: number; lastError?: string | null },
): Promise<void> {
  const { error } = await supabaseAdmin.from("iqoption_candle_coverage").upsert(
    {
      asset,
      timeframe,
      oldest_time: patch.oldest,
      newest_time: patch.newest,
      blocks_fetched: patch.blocks,
      last_error: patch.lastError ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "asset,timeframe" },
  );
  if (error) throw error;
}
