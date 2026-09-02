// Global candle store: keeps candles and raw quotes alive per asset/timeframe
// even when no component is rendering them, so analysis remains stateful.
import { analyseTicks, type Tick, type TickAnalysis } from "@/lib/analysis/tick";
import { getCandles } from "./candles.functions";
import { bucketStart, type CandleData } from "./mapping";
import {
  iqOptionClient,
  type LiveQuote,
  type LiveTick,
  type StreamStatus,
} from "./iqOptionClient";

const MAX_CANDLES = 300;
const HISTORY_COUNT = 200;
const MAX_INTERPOLATED_GAP = 5;
const MAX_TICKS = 5_000;
const FRESHNESS_INTERVAL_MS = 30_000;
const POLL_INTERVAL_MS = 5_000;
const QUOTE_FALLBACK_INTERVAL_MS = 2_000;
const QUOTE_FALLBACK_COUNT = 120;

export interface CandleSnapshot {
  candles: CandleData[];
  currentPrice: number | null;
  tickAnalysis: TickAnalysis | null;
  isLive: boolean;
  status: StreamStatus;
  error?: string | undefined;
}

type Listener = (snapshot: CandleSnapshot) => void;

interface Entry {
  asset: string;
  sizeSeconds: number;
  candles: CandleData[];
  currentPrice: number | null;
  listeners: Set<Listener>;
  background: boolean;
  historyLoaded: boolean;
  historyPromise: Promise<void> | null;
  lastTickAt: number;
  error?: string | undefined;
}

interface QuoteBuffer {
  ticks: Tick[];
  bid: number | null;
  ask: number | null;
  analysis: TickAnalysis | null;
  lastAt: number;
}

function keyOf(asset: string, sizeSeconds: number) {
  return `${asset.toUpperCase()}:${sizeSeconds}`;
}

class CandleStore {
  private entries = new Map<string, Entry>();
  private quoteBuffers = new Map<string, QuoteBuffer>();
  private status: StreamStatus = "idle";
  private streamError: string | undefined;
  private timersStarted = false;
  private freshnessTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private quoteEmitFrame: number | null = null;
  private dirtyQuoteAssets = new Set<string>();

  private ensureEntry(asset: string, sizeSeconds: number): Entry {
    const key = keyOf(asset, sizeSeconds);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        asset: asset.toUpperCase(),
        sizeSeconds,
        candles: [],
        currentPrice: null,
        listeners: new Set(),
        background: false,
        historyLoaded: false,
        historyPromise: null,
        lastTickAt: 0,
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private ensureQuoteBuffer(asset: string): QuoteBuffer {
    const normalizedAsset = asset.toUpperCase();
    let buffer = this.quoteBuffers.get(normalizedAsset);
    if (!buffer) {
      buffer = { ticks: [], bid: null, ask: null, analysis: null, lastAt: 0 };
      this.quoteBuffers.set(normalizedAsset, buffer);
    }
    return buffer;
  }

  snapshot(asset: string, sizeSeconds: number): CandleSnapshot {
    const entry = this.entries.get(keyOf(asset, sizeSeconds));
    const buffer = this.quoteBuffers.get(asset.toUpperCase());
    const lastActivity = Math.max(entry?.lastTickAt ?? 0, buffer?.lastAt ?? 0);
    return {
      candles: entry?.candles ?? [],
      currentPrice: entry?.currentPrice ?? null,
      tickAnalysis: buffer?.analysis ?? null,
      isLive: lastActivity > 0 && Date.now() - lastActivity < 60_000,
      status: this.status,
      error: entry?.error ?? this.streamError,
    };
  }

  /** Foreground subscription used by components/hooks. */
  subscribe(asset: string, sizeSeconds: number, listener: Listener): () => void {
    const entry = this.ensureEntry(asset, sizeSeconds);
    entry.listeners.add(listener);
    this.ensureQuoteBuffer(entry.asset);
    this.startTimers();
    this.attachStream();
    void iqOptionClient.subscribe(entry.asset, sizeSeconds);
    void iqOptionClient.subscribeQuotes(entry.asset);
    void this.loadHistory(entry);

    return () => {
      entry.listeners.delete(listener);
      iqOptionClient.unsubscribe(entry.asset, sizeSeconds);
      iqOptionClient.unsubscribeQuotes(entry.asset);
      this.collect(entry);
    };
  }

  /** Keeps a pair warm in the background (e.g. header favourites). */
  keepWarm(asset: string, sizeSeconds: number): () => void {
    const entry = this.ensureEntry(asset, sizeSeconds);
    entry.background = true;
    this.ensureQuoteBuffer(entry.asset);
    this.startTimers();
    this.attachStream();
    void iqOptionClient.subscribe(entry.asset, sizeSeconds);
    void iqOptionClient.subscribeQuotes(entry.asset);
    void this.loadHistory(entry);
    return () => {
      entry.background = false;
      iqOptionClient.unsubscribe(entry.asset, sizeSeconds);
      iqOptionClient.unsubscribeQuotes(entry.asset);
      this.collect(entry);
    };
  }

  private collect(entry: Entry) {
    if (entry.listeners.size === 0 && !entry.background) {
      this.entries.delete(keyOf(entry.asset, entry.sizeSeconds));
    }
    if (![...this.entries.values()].some((item) => item.asset === entry.asset)) {
      this.quoteBuffers.delete(entry.asset);
    }
    if (this.entries.size === 0) this.stopTimers();
  }

  private emit(entry: Entry) {
    const snapshot = this.snapshot(entry.asset, entry.sizeSeconds);
    for (const listener of [...entry.listeners]) listener(snapshot);
  }

  private emitAll() {
    for (const entry of this.entries.values()) this.emit(entry);
  }

  private scheduleQuoteEmit(asset: string) {
    this.dirtyQuoteAssets.add(asset);
    if (this.quoteEmitFrame != null || typeof window === "undefined") return;
    this.quoteEmitFrame = window.requestAnimationFrame(() => {
      this.quoteEmitFrame = null;
      const dirty = new Set(this.dirtyQuoteAssets);
      this.dirtyQuoteAssets.clear();
      for (const entry of this.entries.values()) {
        if (dirty.has(entry.asset)) this.emit(entry);
      }
    });
  }

  private async loadHistory(entry: Entry, force = false) {
    if (entry.historyPromise) return entry.historyPromise;
    if (entry.historyLoaded && !force) return;

    entry.historyPromise = (async () => {
      try {
        const result = await getCandles({
          data: { asset: entry.asset, sizeSeconds: entry.sizeSeconds, count: HISTORY_COUNT },
        });
        if (result.error) entry.error = result.error;
        else entry.error = undefined;
        if (result.candles.length > 0) {
          const live = entry.candles.filter(
            (c) => c.time > (result.candles[result.candles.length - 1]?.time ?? 0),
          );
          entry.candles = [...result.candles, ...live].slice(-MAX_CANDLES);
          entry.currentPrice = entry.candles[entry.candles.length - 1]?.close ?? entry.currentPrice;
          entry.historyLoaded = true;
        }
      } catch (error) {
        entry.error = error instanceof Error ? error.message : "Failed to load candles";
      } finally {
        entry.historyPromise = null;
        this.emit(entry);
      }
    })();

    return entry.historyPromise;
  }

  private attachStream() {
    if (this.streamAttached) return;
    this.streamAttached = true;
    iqOptionClient.onStatus((status, error) => {
      this.status = status;
      this.streamError = error;
      // Defer so a synchronous status replay never lands mid-render.
      queueMicrotask(() => this.emitAll());
    });
    iqOptionClient.onTick((tick) => this.applyTick(tick));
    iqOptionClient.onQuote((quote) => this.applyQuote(quote));
  }

  private streamAttached = false;

  private applyQuote(quote: LiveQuote) {
    const asset = quote.asset.toUpperCase();
    const buffer = this.ensureQuoteBuffer(asset);
    const now = Date.now();
    const timeMs = Number.isFinite(quote.timeMs) ? quote.timeMs : now;
    buffer.ticks.push({ t: timeMs, price: quote.value });
    if (buffer.ticks.length > MAX_TICKS) buffer.ticks.splice(0, buffer.ticks.length - MAX_TICKS);
    buffer.bid = quote.bid;
    buffer.ask = quote.ask;
    buffer.lastAt = now;
    buffer.analysis = analyseTicks(buffer.ticks, {
      now,
      bid: buffer.bid,
      ask: buffer.ask,
    });

    for (const entry of this.entries.values()) {
      if (entry.asset !== asset) continue;
      entry.lastTickAt = now;
      entry.currentPrice = quote.value;
    }
    this.scheduleQuoteEmit(asset);
  }

  private applyTick(tick: LiveTick) {
    const entry = this.entries.get(keyOf(tick.asset, tick.sizeSeconds));
    if (!entry) return;

    const time = bucketStart(tick.time, entry.sizeSeconds);
    const last = entry.candles[entry.candles.length - 1];
    entry.lastTickAt = Date.now();
    entry.currentPrice = tick.close;

    if (last && last.time === time) {
      last.high = Math.max(last.high, tick.high, tick.close);
      last.low = Math.min(last.low, tick.low, tick.close);
      last.close = tick.close;
      last.volume = tick.volume || last.volume;
    } else if (!last || time > last.time) {
      if (last) {
        const missing = (time - last.time) / entry.sizeSeconds - 1;
        if (missing > 0 && missing <= MAX_INTERPOLATED_GAP) {
          // Fill small gaps left by a silent socket with flat candles.
          for (let i = 1; i <= missing; i += 1) {
            entry.candles.push({
              time: last.time + i * entry.sizeSeconds,
              open: last.close,
              high: last.close,
              low: last.close,
              close: last.close,
              volume: 0,
            });
          }
        } else if (missing > MAX_INTERPOLATED_GAP) {
          // Large gap: refetch real history instead of inventing data.
          void this.loadHistory(entry, true);
        }
      }
      entry.candles.push({
        time,
        open: tick.open,
        high: tick.high,
        low: tick.low,
        close: tick.close,
        volume: tick.volume,
      });
      if (entry.candles.length > MAX_CANDLES) entry.candles.splice(0, entry.candles.length - MAX_CANDLES);
    }

    this.emit(entry);
  }

  private startTimers() {
    if (this.timersStarted || typeof window === "undefined") return;
    this.timersStarted = true;

    const resync = () => {
      if (document.visibilityState === "hidden") return;
      iqOptionClient.hardReconnect();
      for (const entry of this.entries.values()) void this.loadHistory(entry, true);
    };

    window.addEventListener("visibilitychange", resync);
    window.addEventListener("focus", resync);
    window.addEventListener("online", resync);

    this.freshnessTimer = setInterval(() => {
      const nowSec = Math.floor(iqOptionClient.now() / 1000);
      for (const entry of this.entries.values()) {
        const last = entry.candles[entry.candles.length - 1];
        if (!last) continue;
        const currentBucket = bucketStart(nowSec, entry.sizeSeconds);
        if (currentBucket - last.time > entry.sizeSeconds * 2) {
          void this.loadHistory(entry, true);
        }
      }
    }, FRESHNESS_INTERVAL_MS);

    // Fallback path when the realtime channel is unavailable.
    this.pollTimer = setInterval(() => {
      if (iqOptionClient.getStatus() === "live") return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      for (const entry of this.entries.values()) {
        if (entry.listeners.size === 0) continue;
        void this.loadHistory(entry, true);
      }
    }, POLL_INTERVAL_MS);
  }

  private stopTimers() {
    if (this.freshnessTimer) clearInterval(this.freshnessTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.quoteEmitFrame != null && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.quoteEmitFrame);
    }
    this.freshnessTimer = null;
    this.pollTimer = null;
    this.quoteEmitFrame = null;
    this.dirtyQuoteAssets.clear();
    this.timersStarted = false;
  }
}

export const candleStore = new CandleStore();
