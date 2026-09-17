// Server-only Binolla upstream access.
//
// Binolla's own login form is protected by an invisible Google reCAPTCHA v3
// token, so automating the login itself is out of scope here. Instead, a
// human logs into Binolla in a real browser and supplies the resulting
// access token as the BINOLLA_ACCESS_TOKEN secret. The token is short-lived
// and must be refreshed manually (re-pasted into the secret) whenever it
// expires — there is no automatic refresh yet.
//
// Wire protocol (reverse-engineered from the web app, Sep/2026):
//   1. Connect: wss://ws2.binolla.com/socket.io/?EIO=4&transport=websocket
//   2. Server sends a *raw*, unframed JSON array: ["s_connection"]
//   3. Client replies, also raw/unframed: ["authorization",{"token":"..."}]
//   4. Server confirms, raw: ["s_authorization"]
//   5. Server then pushes the asset catalog once, raw: ["s_assets/list", [...]]
//   6. From here on the connection behaves like a normal Engine.IO/Socket.IO
//      transport: events are framed as `42["event",...args]`, payloads with
//      an attachment are framed as `45<n>-["event",{"_placeholder":true,...}]`
//      immediately followed by <n> frames carrying the real payload (sent as
//      UTF-8 JSON text, not actual binary encoding).
//   7. The server pings with a bare "2"; the client must reply with a bare
//      "3" or the connection is dropped.
//
// This has been verified against the live protocol but not yet exercised
// end-to-end against production traffic from this codebase — expect to
// iterate once the first real token is in place.

const BINOLLA_WS_URL = "wss://ws2.binolla.com/socket.io/?EIO=4&transport=websocket";
const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;

export class BinollaAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BinollaAuthError";
  }
}

function getAccessToken(): string {
  const token = process.env["BINOLLA_ACCESS_TOKEN"];
  if (!token) {
    throw new BinollaAuthError(
      "Token da Binolla não configurado (BINOLLA_ACCESS_TOKEN). Faça login em binolla.com e informe o token.",
    );
  }
  return token;
}

/**
 * Opens a raw upstream socket. On Cloudflare Workers the fetch-based upgrade is
 * used so an accepted `Origin` header can be sent; elsewhere (Node dev) the
 * standard constructor is enough. Mirrors src/lib/iqoption/iqoption.server.ts.
 */
async function openUpstreamSocket(): Promise<WebSocket> {
  const workersFetch = fetch as unknown as (
    input: string,
    init: RequestInit & { headers: Record<string, string> },
  ) => Promise<Response & { webSocket?: WebSocket | null }>;

  if (typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== "undefined") {
    const res = await workersFetch(BINOLLA_WS_URL.replace("wss://", "https://"), {
      headers: {
        Upgrade: "websocket",
        Origin: "https://binolla.com",
        "User-Agent": "Mozilla/5.0 BinaryPulse",
      },
    });
    if (!res.ok && res.status !== 101) {
      throw new Error(`Binolla socket unavailable (${res.status})`);
    }
    const socket = res.webSocket as (WebSocket & { accept?: () => void }) | null | undefined;
    if (!socket) throw new Error("Upstream refused the WebSocket upgrade");
    socket.accept?.();
    return socket;
  }

  return new WebSocket(BINOLLA_WS_URL);
}

function waitOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Binolla connection timeout")), 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Binolla connection error"));
    });
  });
}

interface ParsedEvent {
  name: string;
  args: unknown[];
}

export interface BinollaAsset {
  symbol: string;
  name: string;
  category: string;
  active: boolean;
}

interface SharedSession {
  socket: WebSocket;
  sendRaw: (text: string) => void;
  sendEvent: (name: string, ...args: unknown[]) => void;
  waitFor: (predicate: (f: ParsedEvent) => boolean, ms?: number) => Promise<ParsedEvent>;
  assets: BinollaAsset[];
  touchedAt: number;
}

let sharedSession: SharedSession | null = null;
let sharedSessionPromise: Promise<SharedSession> | null = null;
let sessionIdleTimer: ReturnType<typeof setTimeout> | null = null;
const decoder = new TextDecoder("utf-8");

function discardSharedSession() {
  if (sessionIdleTimer) clearTimeout(sessionIdleTimer);
  sessionIdleTimer = null;
  const session = sharedSession;
  sharedSession = null;
  if (!session) return;
  try {
    session.socket.close();
  } catch {
    // already closed
  }
}

function armSessionIdleTimer(session: SharedSession) {
  if (sessionIdleTimer) clearTimeout(sessionIdleTimer);
  sessionIdleTimer = setTimeout(() => {
    if (sharedSession === session && Date.now() - session.touchedAt >= SESSION_IDLE_MS)
      discardSharedSession();
  }, SESSION_IDLE_MS);
}

/** Parses the asset catalog row shape observed live: index/symbol/name/category/.../active(15). */
function parseAssetRow(row: unknown): BinollaAsset | null {
  if (!Array.isArray(row)) return null;
  const symbol = String(row[1] ?? "");
  if (!symbol) return null;
  return {
    symbol,
    name: String(row[2] ?? symbol),
    category: String(row[3] ?? ""),
    active: row[15] === true,
  };
}

async function createSharedSession(): Promise<SharedSession> {
  const token = getAccessToken();
  const socket = await openUpstreamSocket();
  const listeners = new Set<(f: ParsedEvent) => void>();

  // A "45<n>-[...]" frame announces n attachment frames that follow; each one
  // is UTF-8 JSON text (not real binary encoding) that fills the placeholder.
  let pendingBinary: { name: string; remaining: number; args: unknown[] } | null = null;

  function emit(name: string, args: unknown[]) {
    const frame: ParsedEvent = { name, args };
    for (const l of [...listeners]) l(frame);
  }

  async function handleRaw(data: string | Blob | ArrayBuffer) {
    if (pendingBinary) {
      let text: string;
      if (typeof data === "string") text = data;
      else {
        const buf = data instanceof Blob ? await data.arrayBuffer() : data;
        text = decoder.decode(buf);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
      pendingBinary.args.push(payload);
      pendingBinary.remaining--;
      if (pendingBinary.remaining <= 0) {
        emit(pendingBinary.name, pendingBinary.args);
        pendingBinary = null;
      }
      return;
    }
    if (typeof data !== "string") return; // stray binary frame with nothing pending
    if (data === "2") {
      try {
        socket.send("3");
      } catch {
        // socket died; the close listener handles recovery
      }
      return;
    }
    if (data === "3" || data === "") return;

    const binMatch = /^45(\d+)-(.*)$/s.exec(data);
    if (binMatch) {
      const count = Number(binMatch[1]);
      let arr: unknown[];
      try {
        arr = JSON.parse(binMatch[2]!);
      } catch {
        return;
      }
      const name = String(arr[0]);
      const args = arr
        .slice(1)
        .filter(
          (a) => !(a && typeof a === "object" && (a as { _placeholder?: boolean })._placeholder),
        );
      if (count > 0) pendingBinary = { name, remaining: count, args };
      else emit(name, args);
      return;
    }

    const evMatch = /^42(.*)$/s.exec(data);
    if (evMatch) {
      let arr: unknown[];
      try {
        arr = JSON.parse(evMatch[1]!);
      } catch {
        return;
      }
      emit(String(arr[0]), arr.slice(1));
      return;
    }

    if (data.startsWith("[")) {
      let arr: unknown[];
      try {
        arr = JSON.parse(data);
      } catch {
        return;
      }
      if (Array.isArray(arr) && typeof arr[0] === "string") emit(String(arr[0]), arr.slice(1));
      return;
    }
    // Engine.IO open ("0{...}") / connect-ack ("40{...}") frames: not needed here.
  }

  socket.addEventListener("message", (event) => {
    void handleRaw((event as MessageEvent).data);
  });

  const sendRaw = (text: string) => socket.send(text);
  const sendEvent = (name: string, ...args: unknown[]) =>
    socket.send("42" + JSON.stringify([name, ...args]));
  const waitFor = (predicate: (f: ParsedEvent) => boolean, ms = 15_000) =>
    new Promise<ParsedEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error("Binolla response timeout"));
      }, ms);
      const listener = (frame: ParsedEvent) => {
        if (!predicate(frame)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(frame);
      };
      listeners.add(listener);
    });

  let assets: BinollaAsset[] = [];
  try {
    await waitOpen(socket);
    await waitFor((f) => f.name === "s_connection", 10_000);
    sendRaw(JSON.stringify(["authorization", { token }]));
    await waitFor((f) => f.name === "s_authorization", 10_000);
    // Pushed once automatically right after auth; capture it now since there
    // is no known on-demand "refetch catalog" request.
    const catalogFrame = await waitFor((f) => f.name === "s_assets/list", 10_000).catch(() => null);
    if (catalogFrame) {
      const rows = (catalogFrame.args[0] as unknown[]) ?? [];
      assets = rows.map(parseAssetRow).filter((a): a is BinollaAsset => a != null);
    }
  } catch (error) {
    try {
      socket.close();
    } catch {
      // already closed
    }
    throw error;
  }

  const session: SharedSession = {
    socket,
    sendRaw,
    sendEvent,
    waitFor,
    assets,
    touchedAt: Date.now(),
  };
  const invalidate = () => {
    if (sharedSession === session) discardSharedSession();
  };
  socket.addEventListener("close", invalidate);
  socket.addEventListener("error", invalidate);
  return session;
}

async function getSharedSession(): Promise<SharedSession> {
  if (sharedSession?.socket.readyState === 1) {
    sharedSession.touchedAt = Date.now();
    armSessionIdleTimer(sharedSession);
    return sharedSession;
  }
  if (sharedSessionPromise) return sharedSessionPromise;
  sharedSessionPromise = createSharedSession()
    .then((session) => {
      sharedSession = session;
      armSessionIdleTimer(session);
      return session;
    })
    .finally(() => {
      sharedSessionPromise = null;
    });
  return sharedSessionPromise;
}

async function withSession<T>(fn: (session: SharedSession) => Promise<T>, attempt = 0): Promise<T> {
  const session = await getSharedSession();
  session.touchedAt = Date.now();
  armSessionIdleTimer(session);
  try {
    return await fn(session);
  } catch (error) {
    const socketDied = session.socket.readyState !== 1;
    if (socketDied) discardSharedSession();
    if (socketDied && attempt === 0 && !(error instanceof BinollaAuthError))
      return withSession(fn, attempt + 1);
    throw error;
  }
}

export async function getAssetCatalog(): Promise<BinollaAsset[]> {
  return withSession(async (session) => session.assets);
}

export interface UpstreamCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const candleCache = new Map<string, { candles: UpstreamCandle[]; expiresAt: number }>();
const candleRequests = new Map<string, Promise<UpstreamCandle[]>>();

/**
 * Fetches one page of `count` candles ending at `toEpochSeconds` (the oldest
 * edge of the window — mirrors iqoption.server.ts's `fetchCandles` shape so
 * mirror.functions.ts can use either broker interchangeably). Omit `to` for
 * "up to now".
 */
export async function fetchCandles(
  asset: string,
  sizeSeconds: number,
  count: number,
  toEpochSeconds?: number,
): Promise<UpstreamCandle[]> {
  const isHistorical = typeof toEpochSeconds === "number" && Number.isFinite(toEpochSeconds);
  const offset = sizeSeconds * count;
  const anchorTime = isHistorical
    ? Math.floor(toEpochSeconds!)
    : Math.floor(Date.now() / 1000) - offset;
  const cacheKey = `${asset}:${sizeSeconds}:${count}:${anchorTime}`;
  const cached = candleCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.candles;
  const pending = candleRequests.get(cacheKey);
  if (pending) return pending;

  const request = withSession(async (session) => {
    session.sendEvent("history/region", {
      asset,
      index: Date.now(),
      time: anchorTime,
      offset,
      period: sizeSeconds,
    });
    const frame = await session.waitFor(
      (f) =>
        f.name === "s_history/region" &&
        (f.args[0] as { asset?: string } | undefined)?.asset === asset,
      15_000,
    );
    const payload = frame.args[0] as {
      history?: Array<[number, number, number, number, number, number, number]>;
    };
    const raw = payload.history ?? [];
    const candles = raw
      .map((c) => ({
        time: c[0],
        open: c[1],
        close: c[2],
        high: c[3],
        low: c[4],
        volume: c[5] ?? 0,
      }))
      .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close))
      .sort((a, b) => a.time - b.time);
    candleCache.set(cacheKey, {
      candles,
      // Blocos históricos são imutáveis: cache longo evita reconsultas na varredura.
      expiresAt: Date.now() + (isHistorical ? 30 * 60_000 : 4_000),
    });
    return candles;
  }).finally(() => {
    candleRequests.delete(cacheKey);
  });
  candleRequests.set(cacheKey, request);
  return request;
}
