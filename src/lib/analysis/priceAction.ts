import type { CandleData } from "@/lib/iqoption/mapping";

export type PriceActionBias = "bullish" | "bearish" | "neutral";

export interface Swing {
  index: number;
  price: number;
  type: "high" | "low";
}

export interface PriceActionAnalysis {
  /** overall read from market structure + momentum */
  bias: PriceActionBias;
  /** 0-1 conviction of the price action read */
  score: number;
  /** HH/HL, LH/LL, or range */
  structure: "alta" | "baixa" | "lateral";
  /** last confirmed swing highs/lows (most recent last) */
  swings: Swing[];
  /** break of structure on the last closed candles */
  breakOfStructure: "alta" | "baixa" | null;
  /** structure shift: BOS against the previous structure */
  structureShift: boolean;
  /** average body / range of the last closed candle (0-1) */
  bodyRatio: number;
  /** last candle body vs average body of the window */
  momentumRatio: number;
  /** consecutive candles in the same direction */
  streak: number;
  /** last candle sits inside the previous candle's range */
  insideBar: boolean;
  /** price is pulling back inside an established trend */
  pullback: boolean;
  /** rejection wick at the extreme of the window */
  rejection: "topo" | "fundo" | null;
  /** human readable notes (pt-BR) */
  notes: string[];
}

const body = (c: CandleData) => Math.abs(c.close - c.open);
const range = (c: CandleData) => Math.max(c.high - c.low, Number.EPSILON);
const upperWick = (c: CandleData) => c.high - Math.max(c.open, c.close);
const lowerWick = (c: CandleData) => Math.min(c.open, c.close) - c.low;

/** Fractal swing points using a symmetric lookback. */
function findSwings(candles: CandleData[], depth = 2): Swing[] {
  const swings: Swing[] = [];
  for (let i = depth; i < candles.length - depth; i++) {
    const c = candles[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = i - depth; j <= i + depth; j++) {
      if (j === i) continue;
      const other = candles[j]!;
      if (other.high >= c.high) isHigh = false;
      if (other.low <= c.low) isLow = false;
    }
    if (isHigh) swings.push({ index: i, price: c.high, type: "high" });
    else if (isLow) swings.push({ index: i, price: c.low, type: "low" });
  }
  return swings;
}

/**
 * Pure price action read: market structure (HH/HL vs LH/LL), break of structure,
 * momentum/body quality, inside bars, pullbacks and rejection wicks.
 */
export function analysePriceAction(candles: CandleData[]): PriceActionAnalysis | null {
  const window = candles.slice(-60);
  if (window.length < 15) return null;

  const swings = findSwings(window, 2);
  const highs = swings.filter((s) => s.type === "high").slice(-3);
  const lows = swings.filter((s) => s.type === "low").slice(-3);
  const notes: string[] = [];

  let structure: PriceActionAnalysis["structure"] = "lateral";
  const higherHighs = highs.length >= 2 && highs[highs.length - 1]!.price > highs[highs.length - 2]!.price;
  const higherLows = lows.length >= 2 && lows[lows.length - 1]!.price > lows[lows.length - 2]!.price;
  const lowerHighs = highs.length >= 2 && highs[highs.length - 1]!.price < highs[highs.length - 2]!.price;
  const lowerLows = lows.length >= 2 && lows[lows.length - 1]!.price < lows[lows.length - 2]!.price;

  if (higherHighs && higherLows) {
    structure = "alta";
    notes.push("Estrutura de alta: topos e fundos ascendentes.");
  } else if (lowerHighs && lowerLows) {
    structure = "baixa";
    notes.push("Estrutura de baixa: topos e fundos descendentes.");
  } else {
    notes.push("Estrutura lateral: sem sequência clara de topos/fundos.");
  }

  const last = window[window.length - 1]!;
  const prev = window[window.length - 2]!;
  const lastHigh = highs[highs.length - 1]?.price ?? null;
  const lastLow = lows[lows.length - 1]?.price ?? null;

  let breakOfStructure: PriceActionAnalysis["breakOfStructure"] = null;
  if (lastHigh != null && last.close > lastHigh) {
    breakOfStructure = "alta";
    notes.push("Rompimento de estrutura para cima (fechamento acima do último topo).");
  } else if (lastLow != null && last.close < lastLow) {
    breakOfStructure = "baixa";
    notes.push("Rompimento de estrutura para baixo (fechamento abaixo do último fundo).");
  }
  const structureShift =
    (breakOfStructure === "alta" && structure === "baixa") ||
    (breakOfStructure === "baixa" && structure === "alta");
  if (structureShift) notes.push("Mudança de caráter (CHoCH) — estrutura anterior invalidada.");

  const bodies = window.slice(-21, -1).map(body);
  const avgBody = bodies.reduce((a, b) => a + b, 0) / Math.max(bodies.length, 1);
  const bodyRatio = body(last) / range(last);
  const momentumRatio = avgBody > 0 ? body(last) / avgBody : 1;
  if (momentumRatio >= 1.5 && bodyRatio >= 0.6) {
    notes.push(`Vela de força (corpo ${momentumRatio.toFixed(1)}x a média).`);
  }

  let streak = 0;
  const lastUp = last.close > last.open;
  for (let i = window.length - 1; i >= 0; i--) {
    const c = window[i]!;
    const up = c.close > c.open;
    if (c.close === c.open || up !== lastUp) break;
    streak++;
  }

  const insideBar = last.high <= prev.high && last.low >= prev.low;
  if (insideBar) notes.push("Inside bar — compressão antes da expansão.");

  const rangeHigh = Math.max(...window.map((c) => c.high));
  const rangeLow = Math.min(...window.map((c) => c.low));
  let rejection: PriceActionAnalysis["rejection"] = null;
  const nearTop = rangeHigh - last.high <= (rangeHigh - rangeLow) * 0.1;
  const nearBottom = last.low - rangeLow <= (rangeHigh - rangeLow) * 0.1;
  if (nearTop && upperWick(last) > body(last) * 1.5) {
    rejection = "topo";
    notes.push("Rejeição no topo do range — pavio superior dominante.");
  } else if (nearBottom && lowerWick(last) > body(last) * 1.5) {
    rejection = "fundo";
    notes.push("Rejeição no fundo do range — pavio inferior dominante.");
  }

  const pullback =
    (structure === "alta" && !lastUp && streak <= 2) || (structure === "baixa" && lastUp && streak <= 2);
  if (pullback) notes.push("Pullback dentro da tendência — possível continuação.");

  // ---- bias scoring ----
  let bull = 0;
  let bear = 0;
  if (structure === "alta") bull += 1;
  if (structure === "baixa") bear += 1;
  if (breakOfStructure === "alta") bull += structureShift ? 1.2 : 0.8;
  if (breakOfStructure === "baixa") bear += structureShift ? 1.2 : 0.8;
  if (momentumRatio >= 1.5 && bodyRatio >= 0.6) (lastUp ? (bull += 0.7) : (bear += 0.7));
  if (streak >= 3) (lastUp ? (bull += 0.4) : (bear += 0.4));
  if (pullback) (structure === "alta" ? (bull += 0.5) : (bear += 0.5));
  if (rejection === "topo") bear += 0.8;
  if (rejection === "fundo") bull += 0.8;
  if (insideBar) {
    bull *= 0.85;
    bear *= 0.85;
  }

  const total = bull + bear;
  const bias: PriceActionBias = bull === bear ? "neutral" : bull > bear ? "bullish" : "bearish";
  const score = total > 0 ? Math.min(Math.abs(bull - bear) / 2.5, 1) : 0;

  return {
    bias,
    score: Number(score.toFixed(3)),
    structure,
    swings: [...highs, ...lows].sort((a, b) => a.index - b.index),
    breakOfStructure,
    structureShift,
    bodyRatio: Number(bodyRatio.toFixed(3)),
    momentumRatio: Number(momentumRatio.toFixed(2)),
    streak,
    insideBar,
    pullback,
    rejection,
    notes,
  };
}
