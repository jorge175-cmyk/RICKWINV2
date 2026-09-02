// Server-only IQ Option upstream access. The SSID never leaves the server.

const IQ_WS_URL = "wss://iqoption.com/echo/websocket";
const IQ_LOGIN_URL = "https://auth.iqoption.com/api/v2/login";

let cachedSsid: { value: string; expiresAt: number } | null = null;
let activeIdCache: { map: Record<string, number>; expiresAt: number } | null = null;

export async function getSsid(): Promise<string> {
  if (cachedSsid && cachedSsid.expiresAt > Date.now()) return cachedSsid.value;

  const email = process.env["IQOPTION_EMAIL"];
  const password = process.env["IQOPTION_PASSWORD"];
  if (!email || !password) throw new Error("IQ Option credentials are not configured");

  const res = await fetch(IQ_LOGIN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ identifier: email, password }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`IQ Option login failed (${res.status})`);

  let ssid: string | undefined;
  try {
    const json = JSON.parse(text) as { ssid?: string; data?: { ssid?: string } };
    ssid = json.ssid ?? json.data?.ssid;
  } catch {
    // fall through to cookie parsing
  }
  if (!ssid) ssid = /ssid=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  if (!ssid) throw new Error("IQ Option login response did not contain an SSID");

  cachedSsid = { value: ssid, expiresAt: Date.now() + 6 * 60 * 60 * 1000 };
  return ssid;
}

/**
 * Opens a raw upstream socket. On Cloudflare Workers the fetch-based upgrade is
 * used so an accepted `Origin` header can be sent; elsewhere (Node dev) the
 * standard constructor is enough because no Origin header is sent at all.
 */
export async function openUpstreamSocket(): Promise<WebSocket> {
  const workersFetch = fetch as unknown as (
    input: string,
    init: RequestInit & { headers: Record<string, string> },
  ) => Promise<Response & { webSocket?: WebSocket | null }>;

  if (typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== "undefined") {
    const res = await workersFetch(IQ_WS_URL.replace("wss://", "https://"), {
      headers: {
        Upgrade: "websocket",
        Origin: "https://iqoption.com",
        "User-Agent": "Mozilla/5.0 BinaryPulse",
      },
    });
    const socket = res.webSocket as (WebSocket & { accept?: () => void }) | null | undefined;
    if (!socket) throw new Error("Upstream refused the WebSocket upgrade");
    socket.accept?.();
    return socket;
  }

  return new WebSocket(IQ_WS_URL);
}

function waitOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Upstream connection timeout")), 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Upstream connection error"));
    });
  });
}

export function authenticate(socket: WebSocket, ssid: string) {
  socket.send(JSON.stringify({ name: "ssid", msg: ssid, request_id: "auth" }));
}

interface UpstreamFrame {
  name?: string;
  request_id?: string;
  msg?: unknown;
}

/** Opens an authenticated short-lived session, runs `fn`, then closes it. */
async function withSession<T>(
  fn: (send: (frame: unknown) => void, waitFor: (predicate: (f: UpstreamFrame) => boolean, ms?: number) => Promise<UpstreamFrame>) => Promise<T>,
): Promise<T> {
  const socket = await openUpstreamSocket();
  const listeners = new Set<(frame: UpstreamFrame) => void>();

  socket.addEventListener("message", (event) => {
    const data = (event as MessageEvent).data;
    if (typeof data !== "string") return;
    let frame: UpstreamFrame;
    try {
      frame = JSON.parse(data) as UpstreamFrame;
    } catch {
      return;
    }
    for (const listener of [...listeners]) listener(frame);
  });

  const send = (frame: unknown) => socket.send(JSON.stringify(frame));
  const waitFor = (predicate: (f: UpstreamFrame) => boolean, ms = 10_000) =>
    new Promise<UpstreamFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error("Upstream response timeout"));
      }, ms);
      const listener = (frame: UpstreamFrame) => {
        if (!predicate(frame)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(frame);
      };
      listeners.add(listener);
    });

  try {
    await waitOpen(socket);
    authenticate(socket, await getSsid());
    // IQ Option drops requests sent before the session profile is delivered.
    await waitFor((f) => f.name === "profile" && !!f.msg, 15_000);
    return await fn(send, waitFor);
  } finally {
    try {
      socket.close();
    } catch {
      // already closed
    }
  }
}

export async function getActiveIdMap(): Promise<Record<string, number>> {
  if (activeIdCache && activeIdCache.expiresAt > Date.now()) return activeIdCache.map;

  const map = await withSession(async (send, waitFor) => {
    send({
      name: "sendMessage",
      request_id: "init",
      msg: { name: "get-initialization-data", version: "3.0", body: {} },
    });
    const frame = await waitFor((f) => f.name === "initialization-data" || f.request_id === "init", 15_000);
    const msg = (frame.msg ?? {}) as Record<string, { actives?: Record<string, { name?: string }> }>;
    const result: Record<string, number> = {};
    for (const group of Object.values(msg)) {
      for (const [id, active] of Object.entries(group?.actives ?? {})) {
        const name = (active?.name ?? "").replace(/^front\./, "").toUpperCase();
        if (name && !result[name]) result[name] = Number(id);
      }
    }
    return result;
  });

  activeIdCache = { map, expiresAt: Date.now() + 60 * 60 * 1000 };
  return map;
}

export interface UpstreamCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function fetchCandles(
  iqName: string,
  sizeSeconds: number,
  count: number,
): Promise<UpstreamCandle[]> {
  const activeId = (await getActiveIdMap())[iqName.toUpperCase()];
  if (!activeId) throw new Error(`Unknown IQ Option asset: ${iqName}`);

  return withSession(async (send, waitFor) => {
    const requestId = `candles-${Date.now()}`;
    send({
      name: "sendMessage",
      request_id: requestId,
      msg: {
        name: "get-candles",
        version: "2.0",
        body: {
          active_id: activeId,
          size: sizeSeconds,
          to: Math.floor(Date.now() / 1000),
          count,
        },
      },
    });
    const frame = await waitFor((f) => f.request_id === requestId || f.name === "candles", 15_000);
    const raw = ((frame.msg ?? {}) as { candles?: Array<Record<string, number>> }).candles ?? [];
    return raw
      .map((c) => ({
        time: Number(c["from"]),
        open: Number(c["open"]),
        high: Number(c["max"]),
        low: Number(c["min"]),
        close: Number(c["close"]),
        volume: Number(c["volume"] ?? 0),
      }))
      .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close))
      .sort((a, b) => a.time - b.time);
  });
}
