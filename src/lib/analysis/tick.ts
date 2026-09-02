// Pure tick-level math: tick strength, HFT microstructure and volume profile
// (POC / value area). All functions are synchronous and side-effect free so
// they can run on every incoming tick in the browser.

export interface Tick {
  /** epoch milliseconds (server-synced) */
  t: number;
  price: number;
  /** +1 uptick, -1 downtick, 0 unchanged (filled by the analyser) */
  dir?: number;
}

export type TickBias = "CALL" | "PUT" | null;

export interface WindowStrength {
  label: string;
  ms: number;
  ticks: number;
  upTicks: number;
  downTicks: number;
  /** -100..100 — net directional pressure weighted by tick magnitude */
  strength: number;
  /** ticks per second inside the window */
  velocity: number;
  /** net price change inside the window */
  delta: number;
}

export interface HftMetrics {
  /** ticks per second (last 3s) */
  tickRate: number;
  /** tickRate vs the 30s baseline, 1 = normal */
  acceleration: number;
  /** current streak of same-direction ticks (signed) */
  streak: number;
  /** 0..100 — how one-sided the aggression is in the last 3s */
  aggression: number;
  /** average absolute tick size, in price units */
  avgTickSize: number;
  /** realised micro-volatility (stddev of tick returns, in bps) */
  microVolBps: number;
  /** true when tick rate spikes over the baseline */
  burst: boolean;
  /** absorption: heavy tick flow with little net movement */
  absorption: boolean;
}

export interface PocLevel {
  price: number;
  ticks: number;
  share: number;
}

export interface PocMetrics {
  poc: number | null;
  valueAreaLow: number | null;
  valueAreaHigh: number | null;
  /** distance from last price to POC, in bps */
  distanceBps: number;
  position: "above" | "below" | "at";
  insideValueArea: boolean;
  levels: PocLevel[];
}

export interface TickAnalysis {
  price: number | null;
  spreadBps: number | null;
  windows: WindowStrength[];
  hft: HftMetrics;
  poc: PocMetrics;
  bias: TickBias;
  confidence: number;
  reasons: string[];
  warnings: string[];
  tickCount: number;
  updatedAt: number;
}

const WINDOWS: Array<{ label: string; ms: number }> = [
  { label: "3s", ms: 3_000 },
  { label: "15s", ms: 15_000 },
  { label: "60s", ms: 60_000 },
];

function windowStrength(ticks: Tick[], now: number, label: string, ms: number): WindowStrength {
  const slice = ticks.filter((tick) => now - tick.t <= ms);
  let up = 0;
  let down = 0;
  let upSize = 0;
  let downSize = 0;
  for (let i = 1; i < slice.length; i += 1) {
    const diff = slice[i]!.price - slice[i - 1]!.price;
    if (diff > 0) {
      up += 1;
      upSize += diff;
    } else if (diff < 0) {
      down += 1;
      downSize -= diff;
    }
  }
  const sizeTotal = upSize + downSize;
  const countTotal = up + down;
  // Blend count imbalance with magnitude imbalance so a few large ticks in one
  // direction are not drowned out by many tiny ones.
  const countBias = countTotal > 0 ? (up - down) / countTotal : 0;
  const sizeBias = sizeTotal > 0 ? (upSize - downSize) / sizeTotal : 0;
  const first = slice[0]?.price ?? null;
  const last = slice[slice.length - 1]?.price ?? null;
  return {
    label,
    ms,
    ticks: slice.length,
    upTicks: up,
    downTicks: down,
    strength: Math.round((countBias * 0.45 + sizeBias * 0.55) * 100),
    velocity: slice.length > 0 ? +(slice.length / (ms / 1000)).toFixed(2) : 0,
    delta: first != null && last != null ? last - first : 0,
  };
}

function computeHft(ticks: Tick[], now: number): HftMetrics {
  const recent = ticks.filter((tick) => now - tick.t <= 3_000);
  const baseline = ticks.filter((tick) => now - tick.t <= 30_000);
  const tickRate = recent.length / 3;
  const baseRate = baseline.length / 30;
  const acceleration = baseRate > 0 ? +(tickRate / baseRate).toFixed(2) : 0;

  let streak = 0;
  for (let i = ticks.length - 1; i > 0; i -= 1) {
    const diff = ticks[i]!.price - ticks[i - 1]!.price;
    const dir = diff > 0 ? 1 : diff < 0 ? -1 : 0;
    if (dir === 0) continue;
    if (streak === 0 || Math.sign(streak) === dir) streak += dir;
    else break;
  }

  let up = 0;
  let down = 0;
  const sizes: number[] = [];
  const returns: number[] = [];
  for (let i = 1; i < recent.length; i += 1) {
    const prev = recent[i - 1]!.price;
    const diff = recent[i]!.price - prev;
    if (diff > 0) up += 1;
    else if (diff < 0) down += 1;
    if (diff !== 0) {
      sizes.push(Math.abs(diff));
      if (prev !== 0) returns.push((diff / prev) * 10_000);
    }
  }
  const total = up + down;
  const aggression = total > 0 ? Math.round((Math.abs(up - down) / total) * 100) : 0;
  const avgTickSize = sizes.length > 0 ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0;
  const mean = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const microVolBps =
    returns.length > 1
      ? Math.sqrt(returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (returns.length - 1))
      : 0;

  const netMove = recent.length > 1 ? Math.abs(recent[recent.length - 1]!.price - recent[0]!.price) : 0;
  const travelled = sizes.reduce((a, b) => a + b, 0);
  const efficiency = travelled > 0 ? netMove / travelled : 0;

  return {
    tickRate: +tickRate.toFixed(2),
    acceleration,
    streak,
    aggression,
    avgTickSize,
    microVolBps: +microVolBps.toFixed(2),
    burst: acceleration >= 1.6 && recent.length >= 6,
    absorption: recent.length >= 12 && efficiency < 0.15,
  };
}

/** Tick-count volume profile: POC plus 70% value area. */
function computePoc(ticks: Tick[], now: number, windowMs = 300_000, bins = 40): PocMetrics {
  const slice = ticks.filter((tick) => now - tick.t <= windowMs);
  const last = slice[slice.length - 1]?.price ?? null;
  if (slice.length < 10 || last == null) {
    return {
      poc: null,
      valueAreaLow: null,
      valueAreaHigh: null,
      distanceBps: 0,
      position: "at",
      insideValueArea: false,
      levels: [],
    };
  }

  let min = Infinity;
  let max = -Infinity;
  for (const tick of slice) {
    if (tick.price < min) min = tick.price;
    if (tick.price > max) max = tick.price;
  }
  const span = max - min;
  const step = span > 0 ? span / bins : Math.max(Math.abs(last) * 1e-6, 1e-6);
  const counts = new Array(bins).fill(0) as number[];
  for (const tick of slice) {
    const idx = span > 0 ? Math.min(bins - 1, Math.floor((tick.price - min) / step)) : 0;
    counts[idx] = (counts[idx] ?? 0) + 1;
  }

  const priceOf = (idx: number) => min + step * (idx + 0.5);
  let pocIdx = 0;
  for (let i = 1; i < bins; i += 1) if (counts[i]! > counts[pocIdx]!) pocIdx = i;

  // Expand around the POC until 70% of ticks are covered.
  const target = slice.length * 0.7;
  let low = pocIdx;
  let high = pocIdx;
  let covered = counts[pocIdx]!;
  while (covered < target && (low > 0 || high < bins - 1)) {
    const below = low > 0 ? counts[low - 1]! : -1;
    const above = high < bins - 1 ? counts[high + 1]! : -1;
    if (above >= below) {
      high += 1;
      covered += counts[high]!;
    } else {
      low -= 1;
      covered += counts[low]!;
    }
  }

  const poc = priceOf(pocIdx);
  const valueAreaLow = priceOf(low) - step / 2;
  const valueAreaHigh = priceOf(high) + step / 2;
  const distanceBps = poc !== 0 ? ((last - poc) / poc) * 10_000 : 0;

  const levels: PocLevel[] = counts
    .map((count, idx) => ({ price: priceOf(idx), ticks: count, share: count / slice.length }))
    .filter((level) => level.ticks > 0)
    .sort((a, b) => b.price - a.price);

  return {
    poc,
    valueAreaLow,
    valueAreaHigh,
    distanceBps: +distanceBps.toFixed(2),
    position: Math.abs(distanceBps) < 0.5 ? "at" : last > poc ? "above" : "below",
    insideValueArea: last >= valueAreaLow && last <= valueAreaHigh,
    levels,
  };
}

export interface AnalyseTicksOptions {
  now?: number;
  /** best bid/ask when available, for spread cost */
  bid?: number | null;
  ask?: number | null;
  /** higher-timeframe context so the tick read doesn't fight the trend */
  trend?: "up" | "down" | "flat" | undefined;
}

/**
 * Tick-level read for the NEXT candle entry: short-term pressure (3s/15s/60s),
 * HFT microstructure (rate, bursts, absorption) and auction context (POC).
 */
export function analyseTicks(ticks: Tick[], options: AnalyseTicksOptions = {}): TickAnalysis {
  const now = options.now ?? Date.now();
  const price = ticks[ticks.length - 1]?.price ?? null;
  const windows = WINDOWS.map((w) => windowStrength(ticks, now, w.label, w.ms));
  const hft = computeHft(ticks, now);
  const poc = computePoc(ticks, now);

  const reasons: string[] = [];
  const warnings: string[] = [];

  const short = windows[0]!;
  const mid = windows[1]!;
  const long = windows[2]!;

  let score = 0;
  // Weighted pressure: the closer to the entry, the more it matters.
  score += (short.strength / 100) * 1.3;
  score += (mid.strength / 100) * 1.0;
  score += (long.strength / 100) * 0.6;

  if (Math.abs(short.strength) >= 25) {
    reasons.push(
      `Força do tick em 3s: ${short.strength > 0 ? "compradora" : "vendedora"} (${short.strength}%), ${short.upTicks}↑ / ${short.downTicks}↓.`,
    );
  }
  if (Math.abs(mid.strength) >= 20) {
    reasons.push(`Pressão de 15s ${mid.strength > 0 ? "positiva" : "negativa"} (${mid.strength}%).`);
  }
  if (Math.sign(short.strength) !== Math.sign(mid.strength) && short.strength !== 0 && mid.strength !== 0) {
    warnings.push("Divergência entre a pressão de 3s e 15s — fluxo indeciso.");
    score *= 0.6;
  }

  // HFT layer
  if (hft.burst) {
    const dir = short.strength >= 0 ? 1 : -1;
    score += dir * 0.5;
    reasons.push(`Burst HFT: ${hft.tickRate} ticks/s (${hft.acceleration}× a média) na direção ${dir > 0 ? "de alta" : "de baixa"}.`);
  }
  if (Math.abs(hft.streak) >= 4) {
    score += Math.sign(hft.streak) * 0.4;
    reasons.push(`Sequência de ${Math.abs(hft.streak)} ticks ${hft.streak > 0 ? "de alta" : "de baixa"} consecutivos.`);
  }
  if (hft.aggression >= 60) {
    reasons.push(`Agressão de ${hft.aggression}% concentrada num lado do book.`);
  }
  if (hft.absorption) {
    warnings.push("Absorção detectada: muito fluxo de ticks sem deslocamento de preço.");
    score *= 0.55;
  }
  if (hft.tickRate < 0.5) {
    warnings.push("Fluxo de ticks muito baixo — leitura HFT pouco confiável.");
    score *= 0.5;
  }

  // POC / auction layer
  if (poc.poc != null && price != null) {
    if (!poc.insideValueArea) {
      const revert = poc.position === "above" ? -0.5 : 0.5;
      score += revert;
      reasons.push(
        `Preço fora da área de valor (${poc.position === "above" ? "acima" : "abaixo"} do POC ${poc.poc.toFixed(5)}) — viés de retorno à média.`,
      );
    } else if (Math.abs(poc.distanceBps) < 0.6) {
      warnings.push("Preço colado no POC — zona de equilíbrio, entrada de baixa qualidade.");
      score *= 0.65;
    } else {
      reasons.push(
        `Preço ${poc.position === "above" ? "acima" : "abaixo"} do POC dentro da área de valor (${poc.distanceBps.toFixed(1)} bps).`,
      );
    }
  } else {
    warnings.push("Perfil de volume ainda em formação — POC indisponível.");
  }

  // Trend context (from the candle strategy) as a light filter.
  if (options.trend === "up") score += 0.3;
  else if (options.trend === "down") score -= 0.3;

  const spreadBps =
    options.bid != null && options.ask != null && options.ask > 0
      ? +(((options.ask - options.bid) / options.ask) * 10_000).toFixed(2)
      : null;
  if (spreadBps != null && spreadBps > 3) {
    warnings.push(`Spread alargado (${spreadBps} bps) — custo de entrada elevado.`);
    score *= 0.8;
  }

  const enoughData = ticks.length >= 20 && hft.tickRate >= 0.5;
  if (!enoughData) warnings.push("Amostra de ticks insuficiente para um sinal de tick.");

  const magnitude = Math.min(Math.abs(score) / 2.2, 1);
  const confidence = Math.round(Math.min(95, 40 + magnitude * 55));
  const bias: TickBias = enoughData && Math.abs(score) >= 0.9 ? (score > 0 ? "CALL" : "PUT") : null;

  return {
    price,
    spreadBps,
    windows,
    hft,
    poc,
    bias,
    confidence: bias ? confidence : Math.min(confidence, 45),
    reasons,
    warnings,
    tickCount: ticks.length,
    updatedAt: now,
  };
}

/** Seconds remaining until the next candle of `sizeSeconds` opens. */
export function secondsToNextCandle(nowMs: number, sizeSeconds: number): number {
  const nowSec = nowMs / 1000;
  return Math.max(0, Math.ceil(Math.ceil(nowSec / sizeSeconds) * sizeSeconds - nowSec));
}
