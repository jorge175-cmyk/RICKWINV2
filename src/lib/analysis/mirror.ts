// Motor puro de detecção de repetição de gráficos.
// Compara a janela ao vivo com todo o histórico disponível em quatro leituras:
// direta, espelhada no tempo, invertida no preço e as duas combinadas.

export interface MirrorCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type MirrorTransform = "DIRECT" | "TIME_REVERSED" | "PRICE_INVERTED" | "BOTH";

export interface MirrorMatch {
  asset: string;
  timeframe: string;
  transform: MirrorTransform;
  /** Correlação de Pearson entre as séries de retornos normalizadas (0-1). */
  correlation: number;
  /** Semelhança em porcentagem, arredondada. */
  similarity: number;
  /** Início e fim (epoch segundos) do trecho histórico encontrado. */
  startTime: number;
  endTime: number;
  /** Razão entre a volatilidade do trecho antigo e a do trecho ao vivo. */
  volatilityRatio: number;
  /** Retorno projetado para a próxima vela, em fração (0.0012 = +0,12%). */
  predictedReturn: number;
  direction: "CALL" | "PUT";
  /** Fechamento projetado, aplicado sobre o último fechamento ao vivo. */
  projectedClose: number;
  /** Trecho histórico (k+1 velas) para desenhar a miniatura. */
  window: MirrorCandle[];
  /** A vela que veio depois (ou antes, no espelho de tempo) do trecho. */
  nextCandle: MirrorCandle | null;
}

export interface MirrorSearchOptions {
  /** Correlação mínima aceita (0-1). */
  minCorrelation?: number;
  /** Faixa aceita para a razão de volatilidade. */
  volatilityTolerance?: number;
  /** Máximo de coincidências devolvidas por ativo. */
  maxPerAsset?: number;
  /** Não comparar com trechos que se sobrepõem à própria janela ao vivo. */
  excludeFrom?: number;
}

const TRANSFORMS: MirrorTransform[] = ["DIRECT", "TIME_REVERSED", "PRICE_INVERTED", "BOTH"];

/** Retornos percentuais entre fechamentos consecutivos. */
export function closeReturns(candles: MirrorCandle[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!.close;
    const curr = candles[i]!.close;
    out.push(prev > 0 ? (curr - prev) / prev : 0);
  }
  return out;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) ** 2;
  return Math.sqrt(acc / (values.length - 1));
}

/** Correlação de Pearson. Retorna 0 quando alguma série é constante. */
export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return 0;
  const r = num / Math.sqrt(da * db);
  return Number.isFinite(r) ? r : 0;
}

/**
 * Aplica a transformação ao vetor de retornos de um trecho histórico.
 * Espelhar no tempo é ler o caminho de preços de trás pra frente, o que
 * inverte a ordem E o sinal de cada retorno. Inverter no preço troca só o sinal.
 */
function transformReturns(returns: number[], transform: MirrorTransform): number[] {
  switch (transform) {
    case "DIRECT":
      return returns;
    case "PRICE_INVERTED":
      return returns.map((r) => -r);
    case "TIME_REVERSED":
      return [...returns].reverse().map((r) => -r);
    case "BOTH":
      // Espelho de tempo (inverte sinal) + inversão de preço (inverte de novo) = só a ordem.
      return [...returns].reverse();
  }
}

/** Índice da vela que representa a "próxima" da sequência, conforme a leitura. */
function nextIndexFor(startIndex: number, windowLength: number, transform: MirrorTransform): number {
  const readsBackwards = transform === "TIME_REVERSED" || transform === "BOTH";
  return readsBackwards ? startIndex - 1 : startIndex + windowLength;
}

/** Retorno projetado para a próxima vela, já convertido para a leitura atual. */
function projectedReturn(
  hist: MirrorCandle[],
  startIndex: number,
  windowLength: number,
  transform: MirrorTransform,
): { value: number; candle: MirrorCandle } | null {
  const readsBackwards = transform === "TIME_REVERSED" || transform === "BOTH";
  const nextIdx = nextIndexFor(startIndex, windowLength, transform);
  const candle = hist[nextIdx];
  if (!candle) return null;

  let anchorClose: number;
  let targetClose: number;
  if (readsBackwards) {
    // Lendo de trás pra frente, a continuação é a vela anterior ao trecho.
    anchorClose = hist[nextIdx + 1]!.close;
    targetClose = candle.close;
  } else {
    anchorClose = hist[startIndex + windowLength - 1]!.close;
    targetClose = candle.close;
  }
  if (!(anchorClose > 0)) return null;

  let raw = (targetClose - anchorClose) / anchorClose;
  if (transform === "TIME_REVERSED") raw = -raw; // espelho de tempo inverte o sinal
  if (transform === "PRICE_INVERTED") raw = -raw;
  if (transform === "BOTH") raw = raw; // dupla inversão se cancela
  return { value: raw, candle };
}

/**
 * Varre um histórico procurando janelas parecidas com a janela ao vivo.
 * `live` deve conter as últimas velas fechadas (k+1 velas → k retornos).
 */
export function findMatchesInSeries(
  asset: string,
  timeframe: string,
  live: MirrorCandle[],
  hist: MirrorCandle[],
  options: MirrorSearchOptions = {},
): MirrorMatch[] {
  const minCorrelation = options.minCorrelation ?? 0.93;
  const tolerance = options.volatilityTolerance ?? 2.4;
  const maxPerAsset = options.maxPerAsset ?? 3;

  const liveReturns = closeReturns(live);
  const k = liveReturns.length;
  if (k < 6 || hist.length < k + 3) return [];
  const liveVol = stdev(liveReturns);
  if (!(liveVol > 0)) return [];
  const liveLastClose = live[live.length - 1]!.close;

  const found: MirrorMatch[] = [];

  for (let start = 1; start + k + 1 < hist.length; start++) {
    const window = hist.slice(start, start + k + 1);
    const last = window[window.length - 1]!;
    if (options.excludeFrom != null && last.time >= options.excludeFrom) break;

    const winReturns = closeReturns(window);
    if (winReturns.length !== k) continue;
    const winVol = stdev(winReturns);
    if (!(winVol > 0)) continue;
    const ratio = winVol / liveVol;
    if (ratio > tolerance || ratio < 1 / tolerance) continue;

    for (const transform of TRANSFORMS) {
      const candidate = transformReturns(winReturns, transform);
      const r = pearson(liveReturns, candidate);
      if (r < minCorrelation) continue;
      const projection = projectedReturn(hist, start, k + 1, transform);
      if (!projection) continue;

      // Reescala o movimento projetado para a volatilidade atual do ativo ao vivo.
      const scaled = projection.value / (ratio || 1);
      found.push({
        asset,
        timeframe,
        transform,
        correlation: r,
        similarity: Math.round(r * 1000) / 10,
        startTime: window[0]!.time,
        endTime: last.time,
        volatilityRatio: Math.round(ratio * 100) / 100,
        predictedReturn: scaled,
        direction: scaled >= 0 ? "CALL" : "PUT",
        projectedClose: liveLastClose * (1 + scaled),
        window,
        nextCandle: projection.candle,
      });
    }
  }

  // Mantém apenas as melhores e evita janelas praticamente idênticas (vizinhas).
  found.sort((a, b) => b.correlation - a.correlation);
  const kept: MirrorMatch[] = [];
  for (const match of found) {
    const overlapping = kept.some(
      (m) => m.transform === match.transform && Math.abs(m.startTime - match.startTime) < (match.endTime - match.startTime) / 2,
    );
    if (overlapping) continue;
    kept.push(match);
    if (kept.length >= maxPerAsset) break;
  }
  return kept;
}

export interface MirrorConsensus {
  direction: "CALL" | "PUT" | null;
  /** Porcentagem das melhores coincidências que apontam para a direção. */
  agreement: number;
  /** Média ponderada do movimento projetado, em fração. */
  averageReturn: number;
  callCount: number;
  putCount: number;
}

/** Consolida as coincidências em uma leitura única da próxima vela. */
export function consensusOf(matches: MirrorMatch[]): MirrorConsensus {
  if (matches.length === 0) {
    return { direction: null, agreement: 0, averageReturn: 0, callCount: 0, putCount: 0 };
  }
  let callWeight = 0;
  let putWeight = 0;
  let weighted = 0;
  let weightSum = 0;
  let callCount = 0;
  let putCount = 0;
  for (const m of matches) {
    const w = Math.max(0, m.correlation);
    if (m.direction === "CALL") {
      callWeight += w;
      callCount++;
    } else {
      putWeight += w;
      putCount++;
    }
    weighted += m.predictedReturn * w;
    weightSum += w;
  }
  const total = callWeight + putWeight;
  const direction = callWeight >= putWeight ? "CALL" : "PUT";
  return {
    direction,
    agreement: total > 0 ? Math.round((Math.max(callWeight, putWeight) / total) * 100) : 0,
    averageReturn: weightSum > 0 ? weighted / weightSum : 0,
    callCount,
    putCount,
  };
}

export const TRANSFORM_LABELS: Record<MirrorTransform, string> = {
  DIRECT: "Igual",
  TIME_REVERSED: "Espelhado no tempo",
  PRICE_INVERTED: "Invertido no preço",
  BOTH: "Tempo + preço invertidos",
};
