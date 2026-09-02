import type { CandleData } from "@/lib/iqoption/mapping";

export type PatternBias = "bullish" | "bearish";

export interface PatternHit {
  name: string;
  bias: PatternBias;
  /** 0-1 strength weight used by the strategy. */
  strength: number;
}

const body = (c: CandleData) => Math.abs(c.close - c.open);
const range = (c: CandleData) => Math.max(c.high - c.low, Number.EPSILON);
const upperWick = (c: CandleData) => c.high - Math.max(c.open, c.close);
const lowerWick = (c: CandleData) => Math.min(c.open, c.close) - c.low;
const isBull = (c: CandleData) => c.close > c.open;
const isBear = (c: CandleData) => c.close < c.open;

/** Candlestick patterns on the last closed candle (and its predecessor). */
export function detectPatterns(candles: CandleData[]): PatternHit[] {
  const hits: PatternHit[] = [];
  if (candles.length < 3) return hits;

  const last = candles[candles.length - 1]!;
  const prev = candles[candles.length - 2]!;

  const avgBody =
    candles.slice(-11, -1).reduce((sum, c) => sum + body(c), 0) / Math.max(candles.slice(-11, -1).length, 1);

  // Engulfing (bullish / bearish)
  const engulfsPrev = last.close >= Math.max(prev.open, prev.close) && last.open <= Math.min(prev.open, prev.close);
  const engulfedDown = last.close <= Math.min(prev.open, prev.close) && last.open >= Math.max(prev.open, prev.close);
  if (isBull(last) && isBear(prev) && engulfsPrev) {
    hits.push({ name: "Engolfamento de alta", bias: "bullish", strength: body(last) > avgBody ? 1 : 0.7 });
  }
  if (isBear(last) && isBull(prev) && engulfedDown) {
    hits.push({ name: "Engolfamento de baixa", bias: "bearish", strength: body(last) > avgBody ? 1 : 0.7 });
  }

  // Hammer / shooting star
  if (lowerWick(last) > body(last) * 2 && upperWick(last) < body(last)) {
    hits.push({ name: "Martelo", bias: "bullish", strength: 0.8 });
  }
  if (upperWick(last) > body(last) * 2 && lowerWick(last) < body(last)) {
    hits.push({ name: "Estrela cadente", bias: "bearish", strength: 0.8 });
  }

  // Pin bar rejection using wick dominance
  if (lowerWick(last) / range(last) > 0.6) {
    hits.push({ name: "Rejeição de fundo", bias: "bullish", strength: 0.6 });
  }
  if (upperWick(last) / range(last) > 0.6) {
    hits.push({ name: "Rejeição de topo", bias: "bearish", strength: 0.6 });
  }

  // Doji = indecision, no bias emitted but useful to dampen (handled by strategy via absence)
  return hits;
}

export function patternScore(hits: PatternHit[]): { bias: PatternBias | null; score: number } {
  let bull = 0;
  let bear = 0;
  for (const hit of hits) {
    if (hit.bias === "bullish") bull += hit.strength;
    else bear += hit.strength;
  }
  if (bull === bear) return { bias: null, score: 0 };
  return bull > bear
    ? { bias: "bullish", score: Math.min(bull - bear, 2) / 2 }
    : { bias: "bearish", score: Math.min(bear - bull, 2) / 2 };
}
