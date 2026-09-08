import type { CandleData } from "@/lib/iqoption/mapping";

/** A fitted trendline (LTA = uptrend support line, LTB = downtrend resistance line). */
export interface TrendLine {
  /** "LTA" = linha de tendência de alta (suporte), "LTB" = de baixa (resistência) */
  type: "LTA" | "LTB";
  /** price of the line projected at the last candle */
  currentValue: number;
  /** projected price at the next candle */
  nextValue: number;
  /** price change per candle */
  slopePerCandle: number;
  /** slope normalized as % of price per candle */
  slopePct: number;
  /** pivots used to fit the line */
  touches: number;
  /** distance from current price to the line, in percent (negative = price below line) */
  distancePct: number;
  /** true when price broke the line on the last closed candle */
  broken: boolean;
}

export interface TrendLineAnalysis {
  lta: TrendLine | null;
  ltb: TrendLine | null;
  /** price is squeezing between LTA and LTB (triangle / wedge) */
  converging: boolean;
  notes: string[];
}

interface Pivot {
  index: number;
  price: number;
}

function findPivots(candles: CandleData[], kind: "high" | "low", span = 2): Pivot[] {
  const out: Pivot[] = [];
  for (let i = span; i < candles.length - span; i++) {
    const c = candles[i]!;
    const value = kind === "high" ? c.high : c.low;
    let isPivot = true;
    for (let j = i - span; j <= i + span; j++) {
      if (j === i) continue;
      const other = candles[j]!;
      const cmp = kind === "high" ? other.high : other.low;
      if (kind === "high" ? cmp > value : cmp < value) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) out.push({ index: i, price: value });
  }
  return out;
}

/** Fit a line through the two most relevant pivots and count how many others respect it. */
function fitLine(
  candles: CandleData[],
  pivots: Pivot[],
  type: "LTA" | "LTB",
  tolerance: number,
): TrendLine | null {
  if (pivots.length < 2) return null;

  const lastIndex = candles.length - 1;
  const currentPrice = candles[lastIndex]!.close;
  let best: TrendLine | null = null;

  for (let a = 0; a < pivots.length - 1; a++) {
    for (let b = a + 1; b < pivots.length; b++) {
      const p1 = pivots[a]!;
      const p2 = pivots[b]!;
      const dx = p2.index - p1.index;
      if (dx < 3) continue;
      const slope = (p2.price - p1.price) / dx;
      // LTA must rise, LTB must fall.
      if (type === "LTA" && slope <= 0) continue;
      if (type === "LTB" && slope >= 0) continue;

      const at = (i: number) => p1.price + slope * (i - p1.index);

      // Line is invalid if candles clearly violate it between the pivots.
      let violations = 0;
      let touches = 0;
      for (const p of pivots) {
        const line = at(p.index);
        const diff = p.price - line;
        if (Math.abs(diff) <= tolerance) touches += 1;
        else if (type === "LTA" ? diff < -tolerance * 2 : diff > tolerance * 2) violations += 1;
      }
      if (touches < 2 || violations > 1) continue;

      const currentValue = at(lastIndex);
      const nextValue = at(lastIndex + 1);
      const distancePct = ((currentPrice - currentValue) / currentPrice) * 100;
      const broken = type === "LTA" ? currentPrice < currentValue - tolerance : currentPrice > currentValue + tolerance;

      const candidate: TrendLine = {
        type,
        currentValue: Number(currentValue.toFixed(6)),
        nextValue: Number(nextValue.toFixed(6)),
        slopePerCandle: Number(slope.toFixed(8)),
        slopePct: Number(((slope / currentPrice) * 100).toFixed(5)),
        touches,
        distancePct: Number(distancePct.toFixed(4)),
        broken,
      };
      if (!best || candidate.touches > best.touches) best = candidate;
    }
  }
  return best;
}

/** Detect LTA/LTB trendlines from recent candles. */
export function analyseTrendLines(candles: CandleData[]): TrendLineAnalysis | null {
  const window = candles.slice(-60);
  if (window.length < 20) return null;

  const high = Math.max(...window.map((c) => c.high));
  const low = Math.min(...window.map((c) => c.low));
  const span = high - low || Math.abs(window[window.length - 1]!.close) * 0.0001;
  const tolerance = span * 0.06;

  const lta = fitLine(window, findPivots(window, "low"), "LTA", tolerance);
  const ltb = fitLine(window, findPivots(window, "high"), "LTB", tolerance);

  const notes: string[] = [];
  if (lta) {
    notes.push(
      lta.broken
        ? `LTA rompida para baixo (linha em ${lta.currentValue}) — possível reversão de alta`
        : `LTA ativa com ${lta.touches} toques, suporte projetado em ${lta.nextValue}`,
    );
  }
  if (ltb) {
    notes.push(
      ltb.broken
        ? `LTB rompida para cima (linha em ${ltb.currentValue}) — possível reversão de baixa`
        : `LTB ativa com ${ltb.touches} toques, resistência projetada em ${ltb.nextValue}`,
    );
  }
  const converging = !!lta && !!ltb && lta.slopePerCandle > 0 && ltb.slopePerCandle < 0;
  if (converging) notes.push("LTA e LTB convergindo — triângulo/cunha, aguardar rompimento");

  if (!lta && !ltb) notes.push("Nenhuma linha de tendência válida nas últimas velas");

  return { lta, ltb, converging, notes };
}
