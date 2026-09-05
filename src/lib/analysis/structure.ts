import type { CandleData } from "@/lib/iqoption/mapping";

export interface PriceZone {
  /** zone center price */
  price: number;
  /** number of candle extremes touching the zone */
  touches: number;
  /** distance from the current price in percent */
  distancePct: number;
}

export interface ManipulationFlags {
  /** long wick with rejected body — classic stop hunt */
  wickHunts: number;
  /** candles that pierced a zone and closed back inside (false break) */
  falseBreaks: number;
  /** abnormal range candles vs recent average */
  spikes: number;
  /** consecutive doji / exhaustion candles (liquidity trap) */
  stalls: number;
  /** price is inside a zone right now */
  insideZone: boolean;
  /** summary labels in Portuguese */
  notes: string[];
}

export interface StructureAnalysis {
  currentPrice: number;
  supports: PriceZone[];
  resistances: PriceZone[];
  nearestSupportPct: number | null;
  nearestResistancePct: number | null;
  rangeHigh: number;
  rangeLow: number;
  /** 0-100 — where price sits inside the 50-candle range */
  rangePosition: number;
  /** true when price sits close to a reversal zone */
  reversalRisk: boolean;
  manipulation: ManipulationFlags;
}

const clusterLevels = (values: number[], tolerance: number): Array<{ price: number; touches: number }> => {
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: Array<{ sum: number; touches: number; price: number }> = [];
  for (const value of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(value - last.price) <= tolerance) {
      last.sum += value;
      last.touches += 1;
      last.price = last.sum / last.touches;
    } else {
      clusters.push({ sum: value, touches: 1, price: value });
    }
  }
  return clusters
    .filter((c) => c.touches >= 2)
    .map((c) => ({ price: c.price, touches: c.touches }))
    .sort((a, b) => b.touches - a.touches);
};

/** Support/resistance zones and chart-manipulation footprints from the last candles. */
export function analyseStructure(candles: CandleData[]): StructureAnalysis | null {
  const window = candles.slice(-50);
  if (window.length < 10) return null;

  const last = window[window.length - 1]!;
  const currentPrice = last.close;
  const rangeHigh = Math.max(...window.map((c) => c.high));
  const rangeLow = Math.min(...window.map((c) => c.low));
  const span = rangeHigh - rangeLow || Math.abs(currentPrice) * 0.0001;
  const tolerance = span * 0.08;

  const highs = clusterLevels(window.map((c) => c.high), tolerance);
  const lows = clusterLevels(window.map((c) => c.low), tolerance);

  const toZone = (level: { price: number; touches: number }): PriceZone => ({
    price: Number(level.price.toFixed(6)),
    touches: level.touches,
    distancePct: Number((((level.price - currentPrice) / currentPrice) * 100).toFixed(4)),
  });

  const resistances = highs.filter((l) => l.price >= currentPrice).slice(0, 3).map(toZone);
  const supports = lows.filter((l) => l.price <= currentPrice).slice(0, 3).map(toZone);

  const nearestResistancePct = resistances.length
    ? Math.min(...resistances.map((z) => Math.abs(z.distancePct)))
    : null;
  const nearestSupportPct = supports.length
    ? Math.min(...supports.map((z) => Math.abs(z.distancePct)))
    : null;

  // ---- manipulation footprints ----
  const ranges = window.map((c) => c.high - c.low);
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length || span * 0.02;
  const zones = [...supports, ...resistances].map((z) => z.price);

  let wickHunts = 0;
  let falseBreaks = 0;
  let spikes = 0;
  let stalls = 0;

  const recent = window.slice(-12);
  for (const candle of recent) {
    const body = Math.abs(candle.close - candle.open);
    const range = candle.high - candle.low;
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    if (range > 0 && Math.max(upperWick, lowerWick) > body * 2 && Math.max(upperWick, lowerWick) / range > 0.5) {
      wickHunts += 1;
    }
    if (range > avgRange * 2.2) spikes += 1;
    if (range > 0 && body / range < 0.12) stalls += 1;
    for (const zone of zones) {
      const pierced = candle.high > zone + tolerance * 0.25 && candle.close < zone;
      const piercedDown = candle.low < zone - tolerance * 0.25 && candle.close > zone;
      if (pierced || piercedDown) {
        falseBreaks += 1;
        break;
      }
    }
  }

  const insideZone = zones.some((zone) => Math.abs(currentPrice - zone) <= tolerance * 0.5);
  const notes: string[] = [];
  if (wickHunts >= 2) notes.push("Múltiplas caças de stop (pavios longos rejeitados)");
  if (falseBreaks >= 1) notes.push("Rompimentos falsos em zonas de suporte/resistência");
  if (spikes >= 1) notes.push("Velas de amplitude anormal (spike de liquidez)");
  if (stalls >= 3) notes.push("Sequência de dojis — possível armadilha de liquidez");
  if (insideZone) notes.push("Preço operando dentro de zona de reversão");

  const rangePosition = Number((((currentPrice - rangeLow) / span) * 100).toFixed(1));

  return {
    currentPrice,
    supports,
    resistances,
    nearestSupportPct,
    nearestResistancePct,
    rangeHigh,
    rangeLow,
    rangePosition,
    reversalRisk:
      insideZone ||
      (nearestResistancePct !== null && nearestResistancePct < 0.05) ||
      (nearestSupportPct !== null && nearestSupportPct < 0.05),
    manipulation: { wickHunts, falseBreaks, spikes, stalls, insideZone, notes },
  };
}
