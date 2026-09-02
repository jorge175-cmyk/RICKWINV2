// Maps internal BinaryPulse symbols to the names IQ Option recognises.
// Assets without a mapping simply produce no stream.

const EXPLICIT_MAP: Record<string, string> = {
  "EUR/USD": "EURUSD",
  "GBP/USD": "GBPUSD",
  "USD/JPY": "USDJPY",
  "USD/CHF": "USDCHF",
  "USD/CAD": "USDCAD",
  "AUD/USD": "AUDUSD",
  "NZD/USD": "NZDUSD",
  "EUR/JPY": "EURJPY",
  "EUR/GBP": "EURGBP",
  "GBP/JPY": "GBPJPY",
  "BTC/USD": "BTCUSD",
  "ETH/USD": "ETHUSD",
  "XRP/USD": "XRPUSD",
  "LTC/USD": "LTCUSD",
  "XAU/USD": "XAUUSD",
  "XAG/USD": "XAGUSD",
};

export function getIqOptionName(symbol: string | null | undefined): string | null {
  if (!symbol) return null;
  const raw = symbol.trim().toUpperCase();
  if (EXPLICIT_MAP[raw]) return EXPLICIT_MAP[raw];

  const normalized = raw.replace(/[^A-Z]/g, "");
  if (Object.values(EXPLICIT_MAP).includes(normalized)) return normalized;
  // Six-letter FX-style codes are passed through (e.g. EURUSD, AUDCAD).
  if (/^[A-Z]{6}$/.test(normalized)) return normalized;
  return null;
}

export const TIMEFRAMES = {
  M1: 60,
  M5: 300,
  M15: 900,
} as const;

export type Timeframe = keyof typeof TIMEFRAMES;

export const TIMEFRAME_LIST: Timeframe[] = ["M1", "M5", "M15"];

export function timeframeSeconds(timeframe: string): number {
  return TIMEFRAMES[timeframe as Timeframe] ?? 300;
}

export function bucketStart(epochSeconds: number, sizeSeconds: number): number {
  return Math.floor(epochSeconds / sizeSeconds) * sizeSeconds;
}

export interface CandleData {
  /** bucket start, epoch seconds */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
