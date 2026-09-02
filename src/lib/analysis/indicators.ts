import type { CandleData } from "@/lib/iqoption/mapping";

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let prev: number | null = null;
  let seed = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (i < period - 1) {
      seed += v;
      out.push(null);
      continue;
    }
    if (i === period - 1) {
      seed += v;
      prev = seed / period;
      out.push(prev);
      continue;
    }
    prev = v * k + (prev as number) * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i]! - values[i - 1]!;
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i]! - values[i - 1]!;
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function atr(candles: CandleData[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

export type TrendDirection = "up" | "down" | "flat";

export interface TrendInfo {
  direction: TrendDirection;
  emaFast: number | null;
  emaSlow: number | null;
  slopePct: number;
}

/** EMA9 vs EMA21 plus slope of the slow EMA. */
export function detectTrend(candles: CandleData[]): TrendInfo {
  const closes = candles.map((c) => c.close);
  const fastSeries = ema(closes, 9);
  const slowSeries = ema(closes, 21);
  const emaFast = fastSeries[fastSeries.length - 1] ?? null;
  const emaSlow = slowSeries[slowSeries.length - 1] ?? null;
  const slowPrev = slowSeries[slowSeries.length - 4] ?? null;
  const slopePct = emaSlow && slowPrev ? ((emaSlow - slowPrev) / slowPrev) * 100 : 0;

  let direction: TrendDirection = "flat";
  if (emaFast != null && emaSlow != null) {
    const spread = ((emaFast - emaSlow) / emaSlow) * 100;
    if (spread > 0.008 && slopePct >= 0) direction = "up";
    else if (spread < -0.008 && slopePct <= 0) direction = "down";
  }
  return { direction, emaFast, emaSlow, slopePct };
}
