import type { CandleData, Timeframe } from "@/lib/iqoption/mapping";
import { atr, detectTrend, rsi, type TrendInfo } from "./indicators";
import { detectPatterns, patternScore, type PatternHit } from "./patterns";
import { analysePriceAction, type PriceActionAnalysis } from "./priceAction";

export type SignalDirection = "CALL" | "PUT";

export interface AnalysisResult {
  asset: string;
  timeframe: string;
  higherTimeframe: string;
  direction: SignalDirection | null;
  confidence: number;
  entryPrice: number | null;
  expirationMinutes: number;
  summary: string;
  reasons: string[];
  warnings: string[];
  metrics: {
    rsi: number | null;
    trend: TrendInfo["direction"];
    higherTrend: TrendInfo["direction"];
    atr: number | null;
    patterns: PatternHit[];
    priceAction: PriceActionAnalysis | null;
  };
  generatedAt: string;
}

/** Higher timeframe used for confirmation of each entry timeframe. */
export const CONFIRMATION_TF: Record<string, { label: string; seconds: number }> = {
  M1: { label: "M5", seconds: 300 },
  M5: { label: "M15", seconds: 900 },
  M15: { label: "H1", seconds: 3600 },
};

const EXPIRATION_MINUTES: Record<string, number> = { M1: 1, M5: 5, M15: 15 };

/**
 * Combined methodology:
 *  1. Trend (EMA9/EMA21) + RSI momentum on the entry timeframe.
 *  2. Multi-timeframe confirmation on the higher timeframe.
 *  3. Candlestick patterns (engulfing, hammer, shooting star, wick rejection).
 */
export function analyze(
  asset: string,
  timeframe: Timeframe | string,
  entryCandles: CandleData[],
  higherCandles: CandleData[],
): AnalysisResult {
  const confirmation = CONFIRMATION_TF[timeframe] ?? CONFIRMATION_TF['M5']!;
  const reasons: string[] = [];
  const warnings: string[] = [];

  // Use closed candles only for indicator math.
  const closed = entryCandles.slice(0, -1);
  const base = closed.length >= 30 ? closed : entryCandles;
  const closes = base.map((c) => c.close);
  const rsiSeries = rsi(closes, 14);
  const rsiValue = rsiSeries[rsiSeries.length - 1] ?? null;
  const trend = detectTrend(base);
  const higherTrend = detectTrend(higherCandles.length > 25 ? higherCandles.slice(0, -1) : higherCandles);
  const patterns = detectPatterns(base);
  const pattern = patternScore(patterns);
  const atrValue = atr(base, 14);
  const priceAction = analysePriceAction(base);
  const lastPrice = entryCandles[entryCandles.length - 1]?.close ?? null;

  if (base.length < 30) {
    warnings.push("Histórico de velas insuficiente para uma leitura confiável.");
  }

  let bullish = 0;
  let bearish = 0;

  // 1. Trend + RSI
  if (trend.direction === "up") {
    bullish += 1.2;
    reasons.push(`Tendência de alta no ${timeframe} (EMA9 acima da EMA21).`);
  } else if (trend.direction === "down") {
    bearish += 1.2;
    reasons.push(`Tendência de baixa no ${timeframe} (EMA9 abaixo da EMA21).`);
  } else {
    warnings.push(`Sem tendência definida no ${timeframe} — mercado lateral.`);
  }

  if (rsiValue != null) {
    if (rsiValue < 30) {
      bullish += 1;
      reasons.push(`RSI ${rsiValue.toFixed(1)} em sobrevenda — pressão compradora provável.`);
    } else if (rsiValue > 70) {
      bearish += 1;
      reasons.push(`RSI ${rsiValue.toFixed(1)} em sobrecompra — pressão vendedora provável.`);
    } else if (rsiValue > 50 && trend.direction === "up") {
      bullish += 0.6;
      reasons.push(`RSI ${rsiValue.toFixed(1)} acima de 50 confirmando o momentum de alta.`);
    } else if (rsiValue < 50 && trend.direction === "down") {
      bearish += 0.6;
      reasons.push(`RSI ${rsiValue.toFixed(1)} abaixo de 50 confirmando o momentum de baixa.`);
    }
  }

  // 2. Multi-timeframe confirmation
  if (higherTrend.direction === "up") {
    bullish += 1;
    reasons.push(`${confirmation.label} também aponta alta — timeframes alinhados.`);
  } else if (higherTrend.direction === "down") {
    bearish += 1;
    reasons.push(`${confirmation.label} também aponta baixa — timeframes alinhados.`);
  } else {
    warnings.push(`${confirmation.label} sem direção clara — confirmação superior ausente.`);
  }

  // 3. Candlestick patterns
  if (pattern.bias === "bullish") {
    bullish += 0.6 + pattern.score;
    reasons.push(`Padrão de vela: ${patterns.filter((p) => p.bias === "bullish").map((p) => p.name).join(", ")}.`);
  } else if (pattern.bias === "bearish") {
    bearish += 0.6 + pattern.score;
    reasons.push(`Padrão de vela: ${patterns.filter((p) => p.bias === "bearish").map((p) => p.name).join(", ")}.`);
  } else {
    warnings.push("Nenhum padrão de reversão claro na última vela fechada.");
  }

  // 4. Price action (market structure, BOS/CHoCH, momentum, rejection)
  if (priceAction) {
    const weight = 0.8 + priceAction.score * 1.2;
    if (priceAction.bias === "bullish") {
      bullish += weight;
      reasons.push(`Price action de alta: ${priceAction.notes[0] ?? "estrutura favorável"}`);
    } else if (priceAction.bias === "bearish") {
      bearish += weight;
      reasons.push(`Price action de baixa: ${priceAction.notes[0] ?? "estrutura favorável"}`);
    } else {
      warnings.push("Price action indefinido — estrutura sem viés claro.");
    }
    if (priceAction.structureShift) {
      warnings.push("Mudança de caráter na estrutura (CHoCH) — cuidado com falso rompimento.");
    }
    if (priceAction.insideBar) {
      warnings.push("Inside bar na última vela — compressão reduz a previsibilidade.");
    }
    if (priceAction.rejection) {
      warnings.push(`Rejeição no ${priceAction.rejection} do range recente.`);
    }
  } else {
    warnings.push("Price action sem velas suficientes para leitura de estrutura.");
  }

  const total = bullish + bearish;
  const dominant = bullish === bearish ? null : bullish > bearish ? "CALL" : "PUT";
  const edge = total > 0 ? Math.abs(bullish - bearish) / total : 0;
  const strength = Math.max(bullish, bearish);

  // Confidence: needs both a clear edge and enough absolute confluence.
  const rawConfidence = Math.round(45 + edge * 30 + Math.min(strength / 4, 1) * 25);
  const confidence = Math.max(0, Math.min(95, rawConfidence));

  const conflictingTf =
    (dominant === "CALL" && higherTrend.direction === "down") ||
    (dominant === "PUT" && higherTrend.direction === "up");

  const conflictingPa =
    (dominant === "CALL" && priceAction?.bias === "bearish") ||
    (dominant === "PUT" && priceAction?.bias === "bullish");
  if (conflictingPa) {
    warnings.push("Price action contraria a direção da confluência.");
  }
  if (conflictingTf) {
    warnings.push(`Conflito de timeframes: ${confirmation.label} contraria a entrada.`);
  }

  const qualifies =
    dominant != null && strength >= 2.2 && edge >= 0.5 && !conflictingTf && !(conflictingPa && (priceAction?.score ?? 0) > 0.4);
  const direction = qualifies ? (dominant as SignalDirection) : null;

  const summary = direction
    ? `${direction} em ${asset} (${timeframe}): tendência ${trend.direction === "up" ? "de alta" : trend.direction === "down" ? "de baixa" : "lateral"}, RSI ${rsiValue?.toFixed(1) ?? "—"}, confirmado no ${confirmation.label}${pattern.bias ? ` com ${patterns[0]?.name.toLowerCase()}` : ""}.`
    : `Sem confluência suficiente em ${asset} (${timeframe}) — aguardar próxima vela.`;

  return {
    asset,
    timeframe: String(timeframe),
    higherTimeframe: confirmation.label,
    direction,
    confidence: direction ? confidence : Math.min(confidence, 45),
    entryPrice: lastPrice,
    expirationMinutes: EXPIRATION_MINUTES[timeframe] ?? 5,
    summary,
    reasons,
    warnings,
    metrics: {
      rsi: rsiValue,
      trend: trend.direction,
      higherTrend: higherTrend.direction,
      atr: atrValue,
      patterns,
      priceAction,
    },
    generatedAt: new Date().toISOString(),
  };
}
