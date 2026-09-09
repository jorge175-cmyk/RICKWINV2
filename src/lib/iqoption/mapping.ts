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

  // Preserve IQ Option market suffixes (-OTC weekend markets, -OP options FX).
  const suffix = /-(OTC|OP|L)$/.exec(raw)?.[1];
  const base = suffix ? raw.replace(/-(OTC|OP|L)$/, "") : raw;
  const mappedBase = EXPLICIT_MAP[base] ?? base.replace(/[^A-Z0-9]/g, "");
  const known = Object.values(EXPLICIT_MAP).includes(mappedBase);
  if (known || /^[A-Z]{6}$/.test(mappedBase) || (suffix && /^[A-Z0-9]{3,12}$/.test(mappedBase))) {
    return suffix ? `${mappedBase}-${suffix}` : mappedBase;
  }
  // Símbolos vindos direto da IQ Option (ações, índices, cripto) já são nomes válidos.
  if (!raw.includes("/") && /^[A-Z0-9][A-Z0-9._-]{1,19}$/.test(raw)) return raw;
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
