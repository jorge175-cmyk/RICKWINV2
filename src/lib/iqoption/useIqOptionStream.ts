import { useEffect, useState } from "react";
import { candleStore, type CandleSnapshot } from "./candleStore";
import { getIqOptionName, timeframeSeconds } from "./mapping";
import { iqOptionClient, type StreamStatus } from "./iqOptionClient";

const EMPTY: CandleSnapshot = {
  candles: [],
  currentPrice: null,
  tickAnalysis: null,
  liveDominance: null,
  closedDominance: null,
  isLive: false,
  status: "idle",
};

/** Thin consumer of the global candle and quote store. */
export function useIqOptionStream(symbol: string | null | undefined, timeframe: string) {
  const asset = getIqOptionName(symbol);
  const sizeSeconds = timeframeSeconds(timeframe);
  const [snapshot, setSnapshot] = useState<CandleSnapshot>(EMPTY);

  useEffect(() => {
    if (!asset) {
      setSnapshot({ ...EMPTY, error: "Asset not available on IQ Option" });
      return;
    }
    setSnapshot(candleStore.snapshot(asset, sizeSeconds));
    return candleStore.subscribe(asset, sizeSeconds, setSnapshot);
  }, [asset, sizeSeconds]);

  return {
    data: snapshot.candles,
    currentPrice: snapshot.currentPrice,
    tickAnalysis: snapshot.tickAnalysis,
    liveDominance: snapshot.liveDominance,
    closedDominance: snapshot.closedDominance,
    isLive: snapshot.isLive,
    status: snapshot.status,
    error: snapshot.error,
  };
}

/** Keeps a pair warm in the background without rendering it. */
export function useKeepWarm(symbols: Array<string | null | undefined>, timeframe: string) {
  const sizeSeconds = timeframeSeconds(timeframe);
  const key = symbols.join(",");

  useEffect(() => {
    const cleanups = symbols
      .map((symbol) => getIqOptionName(symbol))
      .filter((asset): asset is string => !!asset)
      .map((asset) => candleStore.keepWarm(asset, sizeSeconds));
    return () => cleanups.forEach((fn) => fn());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sizeSeconds]);
}
