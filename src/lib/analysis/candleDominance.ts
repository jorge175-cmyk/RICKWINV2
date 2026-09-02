// Per-candle HFT dominance: while a candle is live we keep sampling the tick
// analysis (pressure windows, tick rate, aggression, streak) and accumulate who
// dominated the flow. When the candle closes we emit a consolidated verdict and
// fuse it with the candle indicators (trend / RSI / multi-timeframe).
import type { TickAnalysis } from "./tick";

export interface DominanceState {
  /** candle bucket start, epoch seconds */
  candleTime: number;
  sizeSeconds: number;
  samples: number;
  callSamples: number;
  putSamples: number;
  neutralSamples: number;
  callWeight: number;
  putWeight: number;
  /** sum of |strength| used to compute the mean pressure */
  strengthSum: number;
  tickRateSum: number;
  peakTickRate: number;
  bursts: number;
  absorptions: number;
  maxCallStreak: number;
  maxPutStreak: number;
  firstPrice: number | null;
  lastPrice: number | null;
  lastSampleAt: number;
}

export interface CandleDominance {
  candleTime: number;
  sizeSeconds: number;
  /** side that dominated the HFT frequency during the candle */
  dominant: "CALL" | "PUT" | null;
  /** 0..100 — share of the weighted flow held by the dominant side */
  dominancePct: number;
  samples: number;
  callSamples: number;
  putSamples: number;
  neutralSamples: number;
  /** -100..100 mean net pressure across the candle */
  netStrength: number;
  avgTickRate: number;
  peakTickRate: number;
  bursts: number;
  absorptions: number;
  maxStreak: number;
  priceChange: number;
  complete: boolean;
}

export function createDominanceState(candleTime: number, sizeSeconds: number): DominanceState {
  return {
    candleTime,
    sizeSeconds,
    samples: 0,
    callSamples: 0,
    putSamples: 0,
    neutralSamples: 0,
    callWeight: 0,
    putWeight: 0,
    strengthSum: 0,
    tickRateSum: 0,
    peakTickRate: 0,
    bursts: 0,
    absorptions: 0,
    maxCallStreak: 0,
    maxPutStreak: 0,
    firstPrice: null,
    lastPrice: null,
    lastSampleAt: 0,
  };
}

/**
 * Folds one tick-analysis snapshot into the running candle accumulator.
 * Weight favours moments of high tick frequency and one-sided aggression, so
 * "who dominated" reflects the HFT flow rather than plain sample counting.
 */
export function sampleDominance(state: DominanceState, analysis: TickAnalysis): void {
  if (analysis.updatedAt <= state.lastSampleAt) return;
  state.lastSampleAt = analysis.updatedAt;
  state.samples += 1;

  const short = analysis.windows[0]?.strength ?? 0;
  const mid = analysis.windows[1]?.strength ?? 0;
  const blended = short * 0.65 + mid * 0.35;
  const rate = Math.max(0, analysis.hft.tickRate);
  const weight = Math.max(0.2, rate) * (1 + analysis.hft.aggression / 100) * (Math.abs(blended) / 100);

  state.strengthSum += blended;
  state.tickRateSum += rate;
  if (rate > state.peakTickRate) state.peakTickRate = rate;
  if (analysis.hft.burst) state.bursts += 1;
  if (analysis.hft.absorption) state.absorptions += 1;
  if (analysis.hft.streak > state.maxCallStreak) state.maxCallStreak = analysis.hft.streak;
  if (-analysis.hft.streak > state.maxPutStreak) state.maxPutStreak = -analysis.hft.streak;

  if (blended > 2) {
    state.callSamples += 1;
    state.callWeight += weight;
  } else if (blended < -2) {
    state.putSamples += 1;
    state.putWeight += weight;
  } else {
    state.neutralSamples += 1;
  }

  if (analysis.price != null) {
    if (state.firstPrice == null) state.firstPrice = analysis.price;
    state.lastPrice = analysis.price;
  }
}

export function summariseDominance(state: DominanceState, complete: boolean): CandleDominance {
  const total = state.callWeight + state.putWeight;
  const dominant = total <= 0 ? null : state.callWeight > state.putWeight ? "CALL" : "PUT";
  const dominancePct = total > 0 ? Math.round((Math.max(state.callWeight, state.putWeight) / total) * 100) : 0;
  return {
    candleTime: state.candleTime,
    sizeSeconds: state.sizeSeconds,
    dominant,
    dominancePct,
    samples: state.samples,
    callSamples: state.callSamples,
    putSamples: state.putSamples,
    neutralSamples: state.neutralSamples,
    netStrength: state.samples > 0 ? Math.round(state.strengthSum / state.samples) : 0,
    avgTickRate: state.samples > 0 ? +(state.tickRateSum / state.samples).toFixed(2) : 0,
    peakTickRate: +state.peakTickRate.toFixed(2),
    bursts: state.bursts,
    absorptions: state.absorptions,
    maxStreak: state.maxCallStreak >= state.maxPutStreak ? state.maxCallStreak : -state.maxPutStreak,
    priceChange:
      state.firstPrice != null && state.lastPrice != null ? state.lastPrice - state.firstPrice : 0,
    complete,
  };
}

export interface IndicatorContext {
  /** direction from the candle strategy (patterns + trend/RSI + MTF) */
  direction?: "CALL" | "PUT" | null | undefined;
  confidence?: number | undefined;
  trend?: "up" | "down" | "flat" | undefined;
  higherTrend?: "up" | "down" | "flat" | undefined;
  rsi?: number | null | undefined;
}

export interface FusedVerdict {
  direction: "CALL" | "PUT" | null;
  confidence: number;
  agreement: "confluente" | "divergente" | "parcial";
  reasons: string[];
  warnings: string[];
}

/**
 * Fuses the closed-candle HFT dominance with the candle indicators to produce
 * the entry verdict for the NEXT candle.
 */
export function fuseDominanceWithIndicators(
  dominance: CandleDominance,
  indicators: IndicatorContext = {},
): FusedVerdict {
  const reasons: string[] = [];
  const warnings: string[] = [];

  let score = 0;
  if (dominance.dominant) {
    const edge = (dominance.dominancePct - 50) / 50; // 0..1
    const dir = dominance.dominant === "CALL" ? 1 : -1;
    score += dir * (0.6 + edge * 0.9);
    reasons.push(
      `HFT dominou ${dominance.dominant} em ${dominance.dominancePct}% da frequência da vela (${dominance.callSamples}↑ / ${dominance.putSamples}↓ em ${dominance.samples} leituras).`,
    );
  } else {
    warnings.push("Nenhum lado dominou a frequência HFT nesta vela.");
  }

  if (Math.abs(dominance.netStrength) >= 15) {
    score += Math.sign(dominance.netStrength) * 0.3;
    reasons.push(`Pressão média da vela em ${dominance.netStrength}%.`);
  }
  if (dominance.bursts > 0) {
    reasons.push(`${dominance.bursts} burst(s) HFT com pico de ${dominance.peakTickRate} ticks/s.`);
  }
  if (dominance.absorptions >= Math.max(2, dominance.samples * 0.3)) {
    warnings.push("Muita absorção durante a vela — dominância pouco eficiente.");
    score *= 0.7;
  }
  if (dominance.samples < 5) {
    warnings.push("Poucas leituras de tick nesta vela — dominância pouco confiável.");
    score *= 0.6;
  }

  const indicatorDir = indicators.direction ?? null;
  if (indicatorDir) {
    const dir = indicatorDir === "CALL" ? 1 : -1;
    score += dir * 0.8;
    reasons.push(`Indicadores (padrões + tendência/RSI + multi-timeframe) apontam ${indicatorDir}.`);
  }
  if (indicators.trend === "up") score += 0.25;
  else if (indicators.trend === "down") score -= 0.25;
  if (indicators.higherTrend === "up") score += 0.2;
  else if (indicators.higherTrend === "down") score -= 0.2;
  if (indicators.rsi != null) {
    if (indicators.rsi >= 70) {
      score -= 0.25;
      warnings.push(`RSI sobrecomprado (${indicators.rsi.toFixed(1)}).`);
    } else if (indicators.rsi <= 30) {
      score += 0.25;
      warnings.push(`RSI sobrevendido (${indicators.rsi.toFixed(1)}).`);
    }
  }

  let agreement: FusedVerdict["agreement"] = "parcial";
  if (dominance.dominant && indicatorDir) {
    agreement = dominance.dominant === indicatorDir ? "confluente" : "divergente";
    if (agreement === "divergente") {
      warnings.push("Dominância HFT contra os indicadores de vela — sinal enfraquecido.");
      score *= 0.5;
    }
  }

  const magnitude = Math.min(Math.abs(score) / 2.4, 1);
  const raw = Math.round(Math.min(95, 40 + magnitude * 55));
  const direction = Math.abs(score) >= 1 ? (score > 0 ? "CALL" : "PUT") : null;

  return {
    direction,
    confidence: direction ? raw : Math.min(raw, 45),
    agreement,
    reasons,
    warnings,
  };
}
