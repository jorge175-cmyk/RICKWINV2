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
const ZOMBIE_TIMEOUT_MS = 45_000;

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

  unsubscribe(asset: string, sizeSeconds: number) {
    const normalizedAsset = asset.toUpperCase();
    const key = `${normalizedAsset}:${sizeSeconds}`;
    const entry = this.subscriptions.get(key);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    this.subscriptions.delete(key);
    this.sendCandleUnsubscribe(normalizedAsset, sizeSeconds);
    this.disconnectIfUnused();
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
    const normalizedAsset = asset.toUpperCase();
    const entry = this.quoteSubscriptions.get(normalizedAsset);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    this.quoteSubscriptions.delete(normalizedAsset);
    this.sendQuoteUnsubscribe(normalizedAsset);
    this.disconnectIfUnused();
  }

  private activeIdFor(asset: string) {
    return this.activeIds?.[asset.toUpperCase()];
  }

  private hasSubscriptions() {
    return this.subscriptions.size > 0 || this.quoteSubscriptions.size > 0;
  }

  private disconnectIfUnused() {
    if (!this.hasSubscriptions()) this.disconnect();
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

  private async connect(): Promise<void> {
    this.setStatus("connecting");
    try {
      if (!this.activeIds) {
        this.activeIds = await getActiveIds();
        this.idToName.clear();
        for (const [name, id] of Object.entries(this.activeIds)) {
          if (!this.idToName.has(id)) this.idToName.set(id, name);
        }
      }

      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) {
        this.setStatus("error", "Sign in required for live market data");
        return;
      }

      const url = `${window.location.origin.replace(/^http/, "ws")}${PROXY_PATH}?token=${encodeURIComponent(token)}`;
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(url);
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error("Streaming handshake timeout"));
        }, 12_000);

        socket.onopen = () => {
          clearTimeout(timer);
          this.socket = socket;
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
        };
        socket.onerror = () => {
          clearTimeout(timer);
          reject(new Error("Streaming connection failed"));
        };
        socket.onmessage = (event) => this.handleFrame(event.data);
        socket.onclose = () => {
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
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      if (!this.hasSubscriptions()) return;
      const stale = Date.now() - this.lastFrameAt > ZOMBIE_TIMEOUT_MS;
      if (stale || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
        this.hardReconnect();
      }
    }, 30_000);
  }

  private scheduleReconnect() {
    this.reconnectAttempts += 1;
    const delay = Math.min(1000 * 2 ** Math.min(this.reconnectAttempts, 4), 15_000);
    setTimeout(() => {
      if (this.hasSubscriptions()) void this.ensureConnected();
    }, delay);
  }

  hardReconnect() {
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
