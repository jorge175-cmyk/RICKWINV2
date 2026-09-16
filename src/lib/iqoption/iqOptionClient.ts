// Single shared WebSocket client for the whole application.
// Connects to the secure proxy route, never to IQ Option directly.
import { supabase } from "@/integrations/supabase/client";
import { getActiveIds } from "./candles.functions";

export type StreamStatus = "idle" | "connecting" | "live" | "polling" | "error";

export interface LiveTick {
  asset: string;
  sizeSeconds: number;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Raw quote update — the highest-frequency data IQ Option publishes. */
export interface LiveQuote {
  asset: string;
  /** epoch milliseconds */
  timeMs: number;
  value: number;
  bid: number | null;
  ask: number | null;
}

type TickHandler = (tick: LiveTick) => void;
type QuoteHandler = (quote: LiveQuote) => void;
type StatusHandler = (status: StreamStatus, error?: string) => void;

const PROXY_PATH = "/api/public/iqoption-ws";
// Quiet OTC assets can go a long while without a printable frame. The proxy
// also sends its own keepalive, so anything under a minute produced false
// "zombie" verdicts and constant channel churn.
const ZOMBIE_TIMEOUT_MS = 120_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const WATCHDOG_INTERVAL_MS = 5_000;
// Batched fan-out for the full asset catalogue over the single channel.
const QUOTE_BATCH_SIZE = 25;
const QUOTE_BATCH_DELAY_MS = 400;
// The upstream session is reused, so reconnecting is cheap: retry fast and
// cap the delay low so a dropped channel resumes within seconds.
const MAX_RECONNECT_DELAY_MS = 30_000;
// Asset catalogue tolerance: a slow provider answer must never turn into a
// failed connection. The last known catalogue is reused instead.
const CATALOGUE_WAIT_MS = 2_500;
const CATALOGUE_CACHE_KEY = "iq-active-ids";
const CATALOGUE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Zombie-socket thresholds per trigger (tab focus is the strictest).
const FRESH_ON_FOCUS_MS = 20_000;
const FRESH_BACKGROUND_MS = 60_000;

function readCachedActiveIds(): Record<string, number> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CATALOGUE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: number; map?: Record<string, number> };
    if (!parsed.map || !parsed.at || Date.now() - parsed.at > CATALOGUE_CACHE_TTL_MS) return null;
    return Object.keys(parsed.map).length > 0 ? parsed.map : null;
  } catch {
    return null;
  }
}

function writeCachedActiveIds(map: Record<string, number>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CATALOGUE_CACHE_KEY, JSON.stringify({ at: Date.now(), map }));
  } catch {
    /* storage unavailable */
  }
}

class IqOptionClient {
  private socket: WebSocket | null = null;
  private status: StreamStatus = "idle";
  private error: string | undefined;
  private connecting: Promise<void> | null = null;
  private activeIds: Record<string, number> | null = null;
  private idToName = new Map<number, string>();
  private subscriptions = new Map<string, { asset: string; sizeSeconds: number; count: number }>();
  private quoteSubscriptions = new Map<string, { asset: string; count: number }>();
  private tickHandlers = new Set<TickHandler>();
  private quoteHandlers = new Set<QuoteHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private serverTimeOffsetMs = 0;
  private lastFrameAt = 0;
  private reconnectAttempts = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private nextReconnectAt = 0;
  private catalogueRefresh: Promise<void> | null = null;

  constructor() {
    if (typeof window === "undefined") return;
    // Browsers freeze background tabs: the socket stays OPEN while no frame
    // arrives. These triggers prove liveness the moment the user comes back.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.ensureFresh(FRESH_ON_FOCUS_MS);
    });
    window.addEventListener("focus", () => this.ensureFresh(FRESH_ON_FOCUS_MS));
    window.addEventListener("online", () => this.ensureFresh(0));
  }

  /**
   * Forces recovery when no frame (market data OR heartbeat) arrived within
   * `maxIdleMs`. Anything fresher is treated as a healthy channel.
   */
  ensureFresh(maxIdleMs: number) {
    if (!this.hasSubscriptions()) return;
    if (this.connecting || this.reconnectTimer) return;
    if (this.socket?.readyState === WebSocket.CONNECTING) return;
    const idle = Date.now() - this.lastFrameAt;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || idle > maxIdleMs) {
      this.hardReconnect(true);
    }
  }

  getStatus() {
    return this.status;
  }

  getError() {
    return this.error;
  }

  /** Server-synced clock, used for correct bucket math. */
  now() {
    return Date.now() + this.serverTimeOffsetMs;
  }

  onTick(handler: TickHandler) {
    this.tickHandlers.add(handler);
    return () => this.tickHandlers.delete(handler);
  }

  onQuote(handler: QuoteHandler) {
    this.quoteHandlers.add(handler);
    return () => this.quoteHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler) {
    this.statusHandlers.add(handler);
    handler(this.status, this.error);
    return () => this.statusHandlers.delete(handler);
  }

  private setStatus(status: StreamStatus, error?: string) {
    this.status = status;
    this.error = error;
    for (const handler of [...this.statusHandlers]) handler(status, error);
  }

  async subscribe(asset: string, sizeSeconds: number) {
    const normalizedAsset = asset.toUpperCase();
    const key = `${normalizedAsset}:${sizeSeconds}`;
    const entry = this.subscriptions.get(key);
    if (entry) {
      entry.count += 1;
      return;
    }
    this.subscriptions.set(key, { asset: normalizedAsset, sizeSeconds, count: 1 });
    await this.ensureConnected();
    this.sendCandleSubscribe(normalizedAsset, sizeSeconds);
  }

  /**
   * Subscriptions are kept for the whole session: dropping and re-adding them
   * whenever a component unmounts caused constant channel churn upstream.
   */
  unsubscribe(asset: string, sizeSeconds: number) {
    const entry = this.subscriptions.get(`${asset.toUpperCase()}:${sizeSeconds}`);
    if (entry && entry.count > 0) entry.count -= 1;
  }

  async subscribeQuotes(asset: string) {
    const normalizedAsset = asset.toUpperCase();
    const entry = this.quoteSubscriptions.get(normalizedAsset);
    if (entry) {
      entry.count += 1;
      return;
    }
    this.quoteSubscriptions.set(normalizedAsset, { asset: normalizedAsset, count: 1 });
    await this.ensureConnected();
    this.sendQuoteSubscribe(normalizedAsset);
  }

  unsubscribeQuotes(asset: string) {
    const entry = this.quoteSubscriptions.get(asset.toUpperCase());
    if (entry && entry.count > 0) entry.count -= 1;
  }

  /**
   * Streams every tradable asset through the single existing channel. Frames go
   * out in small batches so the provider never sees a burst.
   */
  async subscribeAllAssets(assets: string[]) {
    await this.ensureConnected();
    if (!this.activeIds) return;
    const pending = assets
      .map((asset) => asset.toUpperCase())
      .filter((asset) => this.activeIdFor(asset) && !this.quoteSubscriptions.has(asset));
    if (pending.length === 0) return;

    for (const asset of pending) {
      this.quoteSubscriptions.set(asset, { asset, count: 0 });
    }
    for (let index = 0; index < pending.length; index += QUOTE_BATCH_SIZE) {
      const batch = pending.slice(index, index + QUOTE_BATCH_SIZE);
      for (const asset of batch) this.sendQuoteSubscribe(asset);
      if (index + QUOTE_BATCH_SIZE < pending.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, QUOTE_BATCH_DELAY_MS));
      }
    }
  }

  private activeIdFor(asset: string) {
    return this.activeIds?.[asset.toUpperCase()];
  }

  private hasSubscriptions() {
    return this.subscriptions.size > 0 || this.quoteSubscriptions.size > 0;
  }


  private sendFrame(frame: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
      return true;
    }
    return false;
  }

  private sendCandleSubscribe(asset: string, sizeSeconds: number) {
    const activeId = this.activeIdFor(asset);
    if (!activeId) return;
    this.sendFrame({
      name: "subscribeMessage",
      msg: {
        name: "candle-generated",
        params: { routingFilters: { active_id: activeId, size: sizeSeconds } },
      },
    });
  }

  private sendCandleUnsubscribe(asset: string, sizeSeconds: number) {
    const activeId = this.activeIdFor(asset);
    if (!activeId) return;
    this.sendFrame({
      name: "unsubscribeMessage",
      msg: {
        name: "candle-generated",
        params: { routingFilters: { active_id: activeId, size: sizeSeconds } },
      },
    });
  }

  private sendQuoteSubscribe(asset: string) {
    const activeId = this.activeIdFor(asset);
    if (!activeId) return;
    this.sendFrame({
      name: "subscribeMessage",
      msg: {
        name: "quote-generated",
        params: { routingFilters: { active_id: activeId } },
      },
    });
  }

  private sendQuoteUnsubscribe(asset: string) {
    const activeId = this.activeIdFor(asset);
    if (!activeId) return;
    this.sendFrame({
      name: "unsubscribeMessage",
      msg: {
        name: "quote-generated",
        params: { routingFilters: { active_id: activeId } },
      },
    });
  }

  async ensureConnected(): Promise<void> {
    if (typeof window === "undefined") return;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private applyCatalogue(map: Record<string, number>) {
    if (Object.keys(map).length === 0) return false;
    this.activeIds = map;
    this.idToName.clear();
    for (const [name, id] of Object.entries(map)) {
      if (!this.idToName.has(id)) this.idToName.set(id, name);
    }
    return true;
  }

  /** Re-sends every subscription; used after reconnects and catalogue refreshes. */
  private resubscribeAll() {
    for (const { asset, sizeSeconds } of this.subscriptions.values()) {
      this.sendCandleSubscribe(asset, sizeSeconds);
    }
    for (const { asset } of this.quoteSubscriptions.values()) this.sendQuoteSubscribe(asset);
  }

  /**
   * Tolerant catalogue load: waits a short moment for the provider, otherwise
   * falls back to the last known map so a slow answer never becomes an error
   * loop. The refresh keeps running and re-subscribes when it lands.
   */
  private async ensureCatalogue(): Promise<void> {
    if (this.activeIds && Object.keys(this.activeIds).length > 0) return;

    if (!this.catalogueRefresh) {
      this.catalogueRefresh = getActiveIds()
        .then((map) => {
          if (this.applyCatalogue(map)) {
            writeCachedActiveIds(map);
            if (this.socket?.readyState === WebSocket.OPEN) this.resubscribeAll();
          }
        })
        .catch(() => {
          /* handled by the fallback below */
        })
        .finally(() => {
          this.catalogueRefresh = null;
        });
    }

    await Promise.race([
      this.catalogueRefresh,
      new Promise<void>((resolve) => setTimeout(resolve, CATALOGUE_WAIT_MS)),
    ]);

    if (this.activeIds && Object.keys(this.activeIds).length > 0) return;
    const cached = readCachedActiveIds();
    if (cached) this.applyCatalogue(cached);
  }

  private async connect(): Promise<void> {
    this.setStatus("connecting");
    try {
      await this.ensureCatalogue();

      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) {
        this.setStatus("error", "Sign in required for live market data");
        return;
      }

      const url = `${window.location.origin.replace(/^http/, "ws")}${PROXY_PATH}?token=${encodeURIComponent(token)}`;
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(url);
        let proxyReady = false;
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error("Streaming authentication timeout"));
        }, 25_000);

        socket.onopen = () => {
          this.socket = socket;
          this.lastFrameAt = Date.now();
        };
        socket.onmessage = (event) => {
          if (!proxyReady && typeof event.data === "string") {
            try {
              const frame = JSON.parse(event.data) as { name?: string };
              if (frame.name === "proxy-ready") {
                proxyReady = true;
                clearTimeout(timer);
                this.lastFrameAt = Date.now();
                this.reconnectAttempts = 0;
                this.setStatus("live");
                for (const { asset, sizeSeconds } of this.subscriptions.values()) {
                  this.sendCandleSubscribe(asset, sizeSeconds);
                }
                for (const { asset } of this.quoteSubscriptions.values()) {
                  this.sendQuoteSubscribe(asset);
                }
                this.startWatchdog();
                resolve();
              }
            } catch {
              // Non-JSON frames are ignored by the market-data parser too.
            }
          }
          this.handleFrame(event.data);
        };
        socket.onerror = () => {
          clearTimeout(timer);
          reject(new Error("Streaming connection failed"));
        };
        socket.onclose = () => {
          clearTimeout(timer);
          if (!proxyReady) reject(new Error("Streaming closed before authentication"));
          if (this.socket === socket) {
            this.socket = null;
            if (this.hasSubscriptions()) this.scheduleReconnect();
          }
        };
      });
    } catch (error) {
      // No realtime channel available (e.g. local dev runtime) — consumers
      // keep working through periodic history refreshes.
      this.setStatus("polling", error instanceof Error ? error.message : "Streaming unavailable");
      this.scheduleReconnect();
    }
  }

  private handleFrame(raw: unknown) {
    if (typeof raw !== "string") return;
    this.lastFrameAt = Date.now();

    let frame: { name?: string; msg?: unknown };
    try {
      frame = JSON.parse(raw) as { name?: string; msg?: unknown };
    } catch {
      return;
    }

    if (frame.name === "timeSync" && typeof frame.msg === "number") {
      this.serverTimeOffsetMs = frame.msg - Date.now();
      return;
    }

    const msg = frame.msg as Record<string, unknown> | undefined;
    if (!msg) return;

    if (["quote-generated", "quotation", "quote", "ticker"].includes(frame.name ?? "")) {
      const activeId = Number(msg["active_id"] ?? msg["activeId"]);
      const value = Number(msg["quote"] ?? msg["value"] ?? msg["price"] ?? msg["close"]);
      const rawTime = Number(msg["at"] ?? msg["time"] ?? msg["timestamp"] ?? Date.now());
      const asset = this.idToName.get(activeId);
      if (!asset || !Number.isFinite(value)) return;
      const timeMs = rawTime < 10_000_000_000 ? rawTime * 1000 : rawTime;
      const bid = Number(msg["bid"] ?? msg["best_bid"]);
      const ask = Number(msg["ask"] ?? msg["best_ask"]);
      for (const handler of [...this.quoteHandlers]) {
        handler({
          asset,
          timeMs: Number.isFinite(timeMs) ? timeMs : Date.now(),
          value,
          bid: Number.isFinite(bid) ? bid : null,
          ask: Number.isFinite(ask) ? ask : null,
        });
      }
      return;
    }

    if (frame.name !== "candle-generated") return;
    const candle = msg as Record<string, number>;
    const asset = this.idToName.get(Number(candle["active_id"]));
    if (!asset) return;

    for (const handler of [...this.tickHandlers]) {
      handler({
        asset,
        sizeSeconds: Number(candle["size"]),
        time: Number(candle["from"]),
        open: Number(candle["open"]),
        high: Number(candle["max"] ?? candle["high"] ?? candle["close"]),
        low: Number(candle["min"] ?? candle["low"] ?? candle["close"]),
        close: Number(candle["close"]),
        volume: Number(candle["volume"] ?? 0),
      });
    }
  }

  /** Detects zombie sockets and reconnects when the tab regains focus. */
  private startWatchdog() {
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        if (this.socket?.readyState !== WebSocket.OPEN) return;
        const now = Date.now();
        this.sendFrame({ name: "heartbeat", msg: { userTime: now, heartbeatTime: now } });
      }, HEARTBEAT_INTERVAL_MS);
    }
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      if (!this.hasSubscriptions()) return;
      // Never interfere with a handshake in flight or a scheduled retry:
      // doing so aborted healthy connections and looped forever.
      if (this.connecting || this.reconnectTimer) return;
      if (this.socket?.readyState === WebSocket.CONNECTING) return;
      const stale = Date.now() - this.lastFrameAt > ZOMBIE_TIMEOUT_MS;
      if (stale || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
        this.hardReconnect();
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || !this.hasSubscriptions()) return;
    this.reconnectAttempts += 1;
    const exponential = Math.min(1_000 * 2 ** Math.min(this.reconnectAttempts - 1, 8), MAX_RECONNECT_DELAY_MS);
    const delay = exponential + Math.floor(Math.random() * Math.min(1_000, exponential / 4));
    this.nextReconnectAt = Date.now() + delay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.hasSubscriptions()) void this.ensureConnected();
    }, delay);
  }

  /** Immediate recovery: used by the watchdog and on tab focus / network back. */
  hardReconnect(force = false) {
    if (!force && (this.connecting || Date.now() < this.nextReconnectAt)) return;
    if (force) {
      this.nextReconnectAt = 0;
      this.reconnectAttempts = 0;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    }
    try {
      this.socket?.close();
    } catch {
      /* noop */
    }
    this.socket = null;
    if (this.hasSubscriptions()) void this.ensureConnected();
  }

  disconnect() {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.nextReconnectAt = 0;
    try {
      this.socket?.close();
    } catch {
      /* noop */
    }
    this.socket = null;
    this.setStatus("idle");
  }
}

export const iqOptionClient = new IqOptionClient();
