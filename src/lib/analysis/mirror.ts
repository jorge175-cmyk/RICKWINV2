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

export interface MirrorProjectedStep {
  /** 1 = próxima vela, 2 = a seguinte, e assim por diante. */
  step: number;
  /** Horário previsto da vela no mercado ao vivo (epoch segundos). */
  time: number;
  /** Retorno projetado da vela, em fração (0.0012 = +0,12%). */
  ret: number;
  direction: "CALL" | "PUT";
  /** Fechamento projetado acumulado sobre o último fechamento ao vivo. */
  close: number;
  /** Vela histórica que originou a projeção. */
  source: MirrorCandle;
}

export interface MirrorMatch {
  asset: string;
  timeframe: string;
  transform: MirrorTransform;
  /** Correlação de Pearson entre as séries de retornos normalizadas (0-1). */
  correlation: number;
  /** Semelhança em porcentagem, arredondada. */
  similarity: number;
  /**
   * Desvio máximo, vela por vela (corpo, pavios e fechamento), em fração do
   * tamanho típico da vela ao vivo. 0 = replay perfeito.
   */
  maxDeviation: number;
  /** true quando o trecho é um replay praticamente exato (não só parecido). */
  exact: boolean;
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
  /** Sequência das próximas velas projetadas (mínimo 5 quando há histórico). */
  projection: MirrorProjectedStep[];
}

export interface MirrorSearchOptions {
  /** Correlação mínima aceita (0-1). */
  minCorrelation?: number;
  /** Faixa aceita para a razão de volatilidade. */
  volatilityTolerance?: number;
  /** Máximo de coincidências devolvidas por ativo. */
  maxPerAsset?: number;
  /** Não comparar com trechos que se sobrepõem à própria janela ao vivo. */
  excludeFrom?: number | undefined;
  /** Quantas velas à frente projetar (padrão 5). */
  projectionSteps?: number;
  /** Duração da vela em segundos, para datar as velas projetadas. */
  stepSeconds?: number;
  /**
   * Só aceita replay exato: cada vela do trecho histórico tem de reproduzir a
   * vela ao vivo (corpo, máximo, mínimo e fechamento). Padrão: true.
   */
  exactOnly?: boolean;
  /**
   * Desvio máximo tolerado por vela, em fração do tamanho típico da vela ao
   * vivo. 0.03 = até 3% de diferença — ainda lido como a mesma vela.
   */
  exactTolerance?: number;
}

/**
 * Perfil da vela normalizado pelo próprio preço de abertura: descreve a forma
 * (corpo e pavios) sem depender do nível de preço do ativo, o que permite
 * reconhecer o mesmo desenho em ativos e datas diferentes.
 */
function candleShape(c: MirrorCandle): [number, number, number] {
  const base = c.open > 0 ? c.open : 1;
  return [(c.high - base) / base, (c.low - base) / base, (c.close - base) / base];
}

/** A mesma vela lida de trás pra frente: abertura e fechamento trocam de papel. */
function reverseCandle(c: MirrorCandle): MirrorCandle {
  return { ...c, open: c.close, close: c.open };
}

/** A mesma vela refletida no eixo de preço: máximo e mínimo trocam de papel. */
function invertCandle(c: MirrorCandle, pivot: number): MirrorCandle {
  return {
    ...c,
    open: 2 * pivot - c.open,
    close: 2 * pivot - c.close,
    high: 2 * pivot - c.low,
    low: 2 * pivot - c.high,
  };
}

/**
 * Compara vela por vela o trecho histórico (já na leitura escolhida) com a
 * janela ao vivo e devolve o maior desvio encontrado, em fração do tamanho
 * típico da vela ao vivo. Valores próximos de 0 significam replay exato.
 */
function replayDeviation(
  live: MirrorCandle[],
  window: MirrorCandle[],
  transform: MirrorTransform,
): number {
  if (live.length !== window.length || live.length === 0) return Number.POSITIVE_INFINITY;

  const readsBackwards = transform === "TIME_REVERSED" || transform === "BOTH";
  const invertsPrice = transform === "PRICE_INVERTED" || transform === "BOTH";
  let seq = readsBackwards ? [...window].reverse().map(reverseCandle) : [...window];
  if (invertsPrice) {
    const pivot = seq[0]!.open > 0 ? seq[0]!.open : 1;
    seq = seq.map((c) => invertCandle(c, pivot));
  }

  // Tamanho típico da vela ao vivo: escala de referência para o desvio.
  let amplitude = 0;
  for (const c of live) amplitude += c.open > 0 ? (c.high - c.low) / c.open : 0;
  amplitude = amplitude / live.length;
  if (!(amplitude > 0)) return Number.POSITIVE_INFINITY;

  let worst = 0;
  for (let i = 0; i < live.length; i++) {
    const a = candleShape(live[i]!);
    const b = candleShape(seq[i]!);
    for (let j = 0; j < 3; j++) {
      const diff = Math.abs(a[j]! - b[j]!) / amplitude;
      if (diff > worst) worst = diff;
    }
  }
  return worst;
}



const TRANSFORMS: MirrorTransform[] = ["DIRECT", "TIME_REVERSED", "PRICE_INVERTED", "BOTH"];

/** Duração da vela deduzida dos horários da janela ao vivo (fallback: 60s). */
export function inferStepSeconds(candles: MirrorCandle[]): number {
  if (candles.length < 2) return 60;
  const diff = candles[candles.length - 1]!.time - candles[candles.length - 2]!.time;
  return diff > 0 ? diff : 60;
}


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

/**
 * Caminho projetado: as próximas `steps` velas da sequência histórica,
 * já convertidas para a leitura atual (espelho de tempo / inversão de preço).
 */
function projectedPath(
  hist: MirrorCandle[],
  startIndex: number,
  windowLength: number,
  transform: MirrorTransform,
  steps: number,
): { value: number; candle: MirrorCandle; path: Array<{ ret: number; source: MirrorCandle }> } | null {
  const readsBackwards = transform === "TIME_REVERSED" || transform === "BOTH";
  const firstIdx = nextIndexFor(startIndex, windowLength, transform);
  const first = hist[firstIdx];
  if (!first) return null;

  let anchorClose = readsBackwards
    ? hist[firstIdx + 1]!.close
    : hist[startIndex + windowLength - 1]!.close;
  if (!(anchorClose > 0)) return null;

  const path: Array<{ ret: number; source: MirrorCandle }> = [];
  for (let i = 0; i < steps; i++) {
    const idx = readsBackwards ? firstIdx - i : firstIdx + i;
    const candle = hist[idx];
    if (!candle || !(anchorClose > 0)) break;
    let raw = (candle.close - anchorClose) / anchorClose;
    if (transform === "TIME_REVERSED") raw = -raw; // espelho de tempo inverte o sinal
    if (transform === "PRICE_INVERTED") raw = -raw;
    // BOTH: dupla inversão se cancela.
    path.push({ ret: raw, source: candle });
    anchorClose = candle.close;
  }
  if (path.length === 0) return null;
  return { value: path[0]!.ret, candle: first, path };
}

/** Monta a sequência projetada aplicada à escala e ao horário do mercado ao vivo. */
function buildProjection(
  path: Array<{ ret: number; source: MirrorCandle }>,
  ratio: number,
  liveLastClose: number,
  liveLastTime: number,
  stepSeconds: number,
): MirrorProjectedStep[] {
  const out: MirrorProjectedStep[] = [];
  let close = liveLastClose;
  path.forEach((item, i) => {
    const scaled = item.ret / (ratio || 1);
    close = close * (1 + scaled);
    out.push({
      step: i + 1,
      time: liveLastTime + (i + 1) * stepSeconds,
      ret: scaled,
      direction: scaled >= 0 ? "CALL" : "PUT",
      close,
      source: item.source,
    });
  });
  return out;
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
  const exactOnly = options.exactOnly ?? true;
  const exactTolerance = options.exactTolerance ?? 0.05;
  const minCorrelation = options.minCorrelation ?? (exactOnly ? 0.995 : 0.93);
  const tolerance = options.volatilityTolerance ?? (exactOnly ? 1.15 : 2.4);
  const maxPerAsset = options.maxPerAsset ?? 3;
  const steps = Math.max(1, options.projectionSteps ?? 5);
  const stepSeconds = options.stepSeconds ?? inferStepSeconds(live);

  const liveReturns = closeReturns(live);
  const k = liveReturns.length;
  if (k < 6 || hist.length < k + 3) return [];
  const liveVol = stdev(liveReturns);
  if (!(liveVol > 0)) return [];
  const liveLastClose = live[live.length - 1]!.close;
  const liveLastTime = live[live.length - 1]!.time;

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
      // Filtro de replay: descarta o que é apenas "parecido".
      const deviation = replayDeviation(live, window, transform);
      const exact = deviation <= exactTolerance;
      if (exactOnly && !exact) continue;
      const projection = projectedPath(hist, start, k + 1, transform, steps);
      if (!projection) continue;

      // Reescala o movimento projetado para a volatilidade atual do ativo ao vivo.
      const scaled = projection.value / (ratio || 1);
      found.push({
        asset,
        timeframe,
        transform,
        correlation: r,
        similarity: Math.round(r * 1000) / 10,
        maxDeviation: deviation,
        exact,
        startTime: window[0]!.time,
        endTime: last.time,
        volatilityRatio: Math.round(ratio * 100) / 100,
        predictedReturn: scaled,
        direction: scaled >= 0 ? "CALL" : "PUT",
        projectedClose: liveLastClose * (1 + scaled),
        window,
        nextCandle: projection.candle,
        projection: buildProjection(projection.path, ratio, liveLastClose, liveLastTime, stepSeconds),
      });
    }
  }

  // Mantém apenas as melhores e evita janelas praticamente idênticas (vizinhas).
  found.sort((a, b) => a.maxDeviation - b.maxDeviation || b.correlation - a.correlation);
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

// ---------------------------------------------------------------------------
// Caminho rápido: usado na varredura global (todos os ativos contra todos).
// Pré-calcula os retornos e somas acumuladas do histórico uma única vez, para
// que cada deslocamento custe apenas produtos escalares — sem recortar arrays.
// ---------------------------------------------------------------------------

export interface MirrorSeriesIndex {
  /** Retornos entre fechamentos consecutivos (tamanho = velas - 1). */
  rets: Float64Array;
  /** Soma acumulada dos retornos. */
  s1: Float64Array;
  /** Soma acumulada dos quadrados. */
  s2: Float64Array;
}

export function buildSeriesIndex(hist: MirrorCandle[]): MirrorSeriesIndex {
  const m = Math.max(hist.length - 1, 0);
  const rets = new Float64Array(m);
  const s1 = new Float64Array(m + 1);
  const s2 = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) {
    const prev = hist[i]!.close;
    const curr = hist[i + 1]!.close;
    const r = prev > 0 ? (curr - prev) / prev : 0;
    rets[i] = r;
    s1[i + 1] = s1[i]! + r;
    s2[i + 1] = s2[i]! + r * r;
  }
  return { rets, s1, s2 };
}

function popStats(sum: number, sumSq: number, n: number): { mean: number; sd: number } {
  const mean = sum / n;
  const variance = Math.max(sumSq / n - mean * mean, 0);
  return { mean, sd: Math.sqrt(variance) };
}

/** Mesma busca de `findMatchesInSeries`, porém sobre um índice pré-calculado. */
export function findMatchesFast(
  asset: string,
  timeframe: string,
  live: MirrorCandle[],
  hist: MirrorCandle[],
  index: MirrorSeriesIndex,
  options: MirrorSearchOptions = {},
): MirrorMatch[] {
  const minCorrelation = options.minCorrelation ?? 0.93;
  const tolerance = options.volatilityTolerance ?? 2.4;
  const maxPerAsset = options.maxPerAsset ?? 3;
  const steps = Math.max(1, options.projectionSteps ?? 5);
  const stepSeconds = options.stepSeconds ?? inferStepSeconds(live);

  const liveReturns = closeReturns(live);
  const k = liveReturns.length;
  const m = index.rets.length;
  if (k < 6 || m < k + 3) return [];

  const liveStats = popStats(
    liveReturns.reduce((a, v) => a + v, 0),
    liveReturns.reduce((a, v) => a + v * v, 0),
    k,
  );
  if (!(liveStats.sd > 0)) return [];
  const liveLastClose = live[live.length - 1]!.close;
  const liveLastTime = live[live.length - 1]!.time;


  // Transforma a janela ao vivo (não o histórico): 4 vetores fixos por ativo.
  const variants = TRANSFORMS.map((transform) => ({
    transform,
    vector: Float64Array.from(transformReturns(liveReturns, transform)),
  }));

  const found: MirrorMatch[] = [];
  const rets = index.rets;

  for (let start = 1; start + k + 1 < hist.length; start++) {
    // Índices de retorno da janela: start .. start + k - 1
    const from = start;
    const to = start + k;
    if (to > m) break;
    if (options.excludeFrom != null && hist[start + k]!.time >= options.excludeFrom) break;

    const winStats = popStats(index.s1[to]! - index.s1[from]!, index.s2[to]! - index.s2[from]!, k);
    if (!(winStats.sd > 0)) continue;
    const ratio = winStats.sd / liveStats.sd;
    if (ratio > tolerance || ratio < 1 / tolerance) continue;

    for (const { transform, vector } of variants) {
      // r = (E[xy] - mx·my) / (sx·sy) — mesma escala do Pearson clássico.
      let dot = 0;
      for (let j = 0; j < k; j++) dot += vector[j]! * rets[from + j]!;
      const vStats = popStats(
        vector.reduce((a, v) => a + v, 0),
        vector.reduce((a, v) => a + v * v, 0),
        k,
      );
      if (!(vStats.sd > 0)) continue;
      const r = (dot / k - vStats.mean * winStats.mean) / (vStats.sd * winStats.sd);
      if (!Number.isFinite(r) || r < minCorrelation) continue;

      const projection = projectedPath(hist, start, k + 1, transform, steps);
      if (!projection) continue;
      const window = hist.slice(start, start + k + 1);
      const scaled = projection.value / (ratio || 1);
      found.push({
        asset,
        timeframe,
        transform,
        correlation: r,
        similarity: Math.round(r * 1000) / 10,
        startTime: window[0]!.time,
        endTime: window[window.length - 1]!.time,
        volatilityRatio: Math.round(ratio * 100) / 100,
        predictedReturn: scaled,
        direction: scaled >= 0 ? "CALL" : "PUT",
        projectedClose: liveLastClose * (1 + scaled),
        window,
        nextCandle: projection.candle,
        projection: buildProjection(projection.path, ratio, liveLastClose, liveLastTime, stepSeconds),
      });

    }
  }

  found.sort((a, b) => b.correlation - a.correlation);
  const kept: MirrorMatch[] = [];
  for (const match of found) {
    const overlapping = kept.some(
      (mm) =>
        mm.transform === match.transform &&
        Math.abs(mm.startTime - match.startTime) < (match.endTime - match.startTime) / 2,
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
