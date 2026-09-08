// Server-only IQ Option upstream access. The SSID never leaves the server.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const IQ_WS_URL = "wss://iqoption.com/echo/websocket";
const IQ_LOGIN_URL = "https://auth.iqoption.com/api/v2/login";

// IQ Option sessions normally outlive a worker instance by days. Refreshing
// them every few hours caused avoidable login bursts from serverless workers.
const SSID_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Keep the authenticated upstream socket for as long as the worker lives; a
// heartbeat keeps it warm so no re-login is ever needed for normal usage.
const SESSION_IDLE_MS = 30 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const LOGIN_LEASE_SECONDS = 25;
const LOGIN_WAIT_ATTEMPTS = 15;


let cachedSsid: { value: string; expiresAt: number } | null = null;
let ssidPromise: Promise<string> | null = null;
let loginFailures = 0;
let loginBlockedUntil = 0;
let loginBlockedReason = "";
let activeIdCache: { map: Record<string, number>; expiresAt: number } | null = null;
let activeIdPromise: Promise<Record<string, number>> | null = null;

export class IqOptionBackoffError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "IqOptionBackoffError";
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1_000, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1_000, date - Date.now()) : null;
}

function registerLoginFailure(status: number, response?: Response) {
  loginFailures += 1;
  const providerDelay = response ? retryAfterMs(response) : null;
  // A 429 is account/IP protection, not a transient socket failure. Retrying
  // every minute extends the provider block, so start at one hour.
  const base = status === 429 ? 60 * 60 * 1000 : 15_000;
  const exponential = Math.min(base * 2 ** Math.min(loginFailures - 1, 4), MAX_BACKOFF_MS);
  const delay = Math.min(Math.max(providerDelay ?? 0, exponential), MAX_BACKOFF_MS);
  loginBlockedUntil = Date.now() + delay;
  loginBlockedReason = status === 429 ? "IQ Option login rate limited" : "IQ Option login temporarily unavailable";
  return delay;
}

interface SharedLoginState {
  claimed: boolean;
  ssid: string | null;
  ssid_expires_at: string | null;
  login_blocked_until: string | null;
  login_blocked_reason: string | null;
  login_failures: number;
}

async function claimSharedLogin(): Promise<SharedLoginState> {
  const { data, error } = await supabaseAdmin.rpc("claim_iqoption_login", {
    claim_for_seconds: LOGIN_LEASE_SECONDS,
  });
  if (error) throw new Error(`Unable to coordinate IQ Option login: ${error.message}`);
  const state = data?.[0];
  if (!state) throw new Error("IQ Option shared login state is unavailable");
  return state;
}

async function saveSharedLoginSuccess(ssid: string) {
  const expiresAt = new Date(Date.now() + SSID_TTL_MS).toISOString();
  const { error } = await supabaseAdmin
    .from("iqoption_connection_state")
    .update({
      ssid,
      ssid_expires_at: expiresAt,
      login_blocked_until: null,
      login_blocked_reason: null,
      login_failures: 0,
      updated_at: new Date().toISOString(),
    })
    .eq("singleton", true);
  if (error) throw new Error(`Unable to save IQ Option session: ${error.message}`);
  cachedSsid = { value: ssid, expiresAt: Date.parse(expiresAt) };
}

async function saveSharedLoginFailure(status: number, delay: number, reason: string) {
  const { error } = await supabaseAdmin
    .from("iqoption_connection_state")
    .update({
      // A provider rejection means the persisted credential can no longer be
      // trusted. Clearing it also makes every worker honor the shared cooldown
      // instead of repeatedly opening sockets with a stale session.
      ssid: null,
      ssid_expires_at: null,
      login_blocked_until: new Date(Date.now() + delay).toISOString(),
      login_blocked_reason: reason,
      login_failures: loginFailures,
      updated_at: new Date().toISOString(),
    })
    .eq("singleton", true);
  if (error) console.error("[iqoption] failed to persist login backoff", error.message, status);
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function getSsid(): Promise<string> {
  if (cachedSsid && cachedSsid.expiresAt > Date.now()) return cachedSsid.value;
  if (ssidPromise) return ssidPromise;

  ssidPromise = (async () => {
    let claimed = false;
    for (let attempt = 0; attempt < LOGIN_WAIT_ATTEMPTS; attempt += 1) {
      const state = await claimSharedLogin();
      const sharedExpiry = state.ssid_expires_at ? Date.parse(state.ssid_expires_at) : 0;
      if (state.ssid && sharedExpiry > Date.now()) {
        cachedSsid = { value: state.ssid, expiresAt: sharedExpiry };
        loginFailures = 0;
        loginBlockedUntil = 0;
        return state.ssid;
      }
      if (state.claimed) {
        claimed = true;
        loginFailures = state.login_failures ?? 0;
        break;
      }

      const blockedUntil = state.login_blocked_until ? Date.parse(state.login_blocked_until) : 0;
      const remainingMs = Math.max(1_000, blockedUntil - Date.now());
      if (state.login_blocked_reason !== "Login em andamento") {
        loginBlockedUntil = blockedUntil;
        loginBlockedReason = state.login_blocked_reason ?? "IQ Option login temporarily unavailable";
        throw new IqOptionBackoffError(loginBlockedReason, remainingMs);
      }
      await wait(Math.min(2_000, remainingMs));
    }
    if (!claimed) {
      throw new IqOptionBackoffError("IQ Option login is already being established", 5_000);
    }

    const email = process.env["IQOPTION_EMAIL"];
    const password = process.env["IQOPTION_PASSWORD"];
    if (!email || !password) throw new Error("IQ Option credentials are not configured");

    let res: Response;
    try {
      res = await fetch(IQ_LOGIN_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ identifier: email, password }),
      });
    } catch (error) {
      const delay = registerLoginFailure(503);
      await saveSharedLoginFailure(503, delay, loginBlockedReason);
      throw new IqOptionBackoffError(
        error instanceof Error ? error.message : "IQ Option login request failed",
        delay,
      );
    }

    const text = await res.text();
    if (!res.ok) {
      const delay = registerLoginFailure(res.status, res);
      await saveSharedLoginFailure(res.status, delay, loginBlockedReason);
      throw new IqOptionBackoffError(`IQ Option login failed (${res.status})`, delay);
    }

    let ssid: string | undefined;
    try {
      const json = JSON.parse(text) as { ssid?: string; data?: { ssid?: string } };
      ssid = json.ssid ?? json.data?.ssid;
    } catch {
      // fall through to cookie parsing
    }
    if (!ssid) ssid = /ssid=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    if (!ssid) {
      const delay = registerLoginFailure(502);
      await saveSharedLoginFailure(502, delay, loginBlockedReason);
      throw new IqOptionBackoffError("IQ Option login response did not contain an SSID", delay);
    }

    loginFailures = 0;
    loginBlockedUntil = 0;
    loginBlockedReason = "";
    await saveSharedLoginSuccess(ssid);
    return ssid;
  })().finally(() => {
    ssidPromise = null;
  });

  return ssidPromise;
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
    if (!res.ok && res.status !== 101) {
      // A refused socket upgrade is a transport problem, not a credential
      // problem. Keep the stored session so recovery needs no new login.
      const delay = Math.max(retryAfterMs(res) ?? 0, res.status === 429 ? 60_000 : 3_000);
      throw new IqOptionBackoffError(`IQ Option socket unavailable (${res.status})`, delay);
    }
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

interface SharedSession {
  socket: WebSocket;
  send: (frame: unknown) => void;
  waitFor: (predicate: (frame: UpstreamFrame) => boolean, ms?: number) => Promise<UpstreamFrame>;
  touchedAt: number;
  heartbeat: ReturnType<typeof setInterval> | null;
}

let sharedSession: SharedSession | null = null;
let sharedSessionPromise: Promise<SharedSession> | null = null;
let sessionIdleTimer: ReturnType<typeof setTimeout> | null = null;

function discardSharedSession() {
  if (sessionIdleTimer) clearTimeout(sessionIdleTimer);
  sessionIdleTimer = null;
  const session = sharedSession;
  sharedSession = null;
  if (!session) return;
  if (session.heartbeat) clearInterval(session.heartbeat);
  session.heartbeat = null;
  try {
    session.socket.close();
  } catch {
    // already closed
  }
}

function armSessionIdleTimer(session: SharedSession) {
  if (sessionIdleTimer) clearTimeout(sessionIdleTimer);
  sessionIdleTimer = setTimeout(() => {
    if (sharedSession === session && Date.now() - session.touchedAt >= SESSION_IDLE_MS) {
      discardSharedSession();
    }
  }, SESSION_IDLE_MS);
}


/** One authenticated upstream socket shared by all server requests in this worker. */
async function createSharedSession(): Promise<SharedSession> {
  // Resolve the coordinated credential before opening a socket. During a
  // provider cooldown this avoids creating a fresh upstream connection for
  // every candle/analysis request.
  const ssid = await getSsid();
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
    authenticate(socket, ssid);
    // IQ Option drops requests sent before the session profile is delivered.
    await waitFor((f) => f.name === "profile" && !!f.msg, 15_000);
  } catch (error) {
    try {
      socket.close();
    } catch {
      // already closed
    }
    throw error;
  }

  const session: SharedSession = { socket, send, waitFor, touchedAt: Date.now(), heartbeat: null };
  // A periodic heartbeat keeps the authenticated socket alive, so the session
  // survives quiet periods and never needs a fresh login.
  session.heartbeat = setInterval(() => {
    if (socket.readyState !== 1) return;
    try {
      const now = Date.now();
      send({ name: "heartbeat", msg: { userTime: now, heartbeatTime: now } });
    } catch {
      // socket died; the close listener handles recovery
    }
  }, HEARTBEAT_INTERVAL_MS);
  const invalidate = () => {
    if (sharedSession === session) discardSharedSession();
    else if (session.heartbeat) {
      clearInterval(session.heartbeat);
      session.heartbeat = null;
    }
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

async function withSession<T>(
  fn: (send: SharedSession["send"], waitFor: SharedSession["waitFor"]) => Promise<T>,
): Promise<T> {
  const session = await getSharedSession();
  session.touchedAt = Date.now();
  armSessionIdleTimer(session);
  try {
    return await fn(session.send, session.waitFor);
  } catch (error) {
    // Do not log in again here. Drop only the failed socket; getSsid remains
    // cached, so the next request reconnects without hitting the login API.
    discardSharedSession();
    throw error;
  }
}

export async function getActiveIdMap(): Promise<Record<string, number>> {
  if (activeIdCache && activeIdCache.expiresAt > Date.now()) return activeIdCache.map;
  if (activeIdPromise) return activeIdPromise;

  activeIdPromise = withSession(async (send, waitFor) => {
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
  }).then((map) => {
    activeIdCache = { map, expiresAt: Date.now() + 60 * 60 * 1000 };
    return map;
  }).finally(() => {
    activeIdPromise = null;
  });

  const map = await activeIdPromise;

  // IQ Option names carry suffixes (-OP for options FX, -OTC for weekend
  // synthetic markets). Expose plain base names too, preferring live markets.
  const SUFFIX_PRIORITY = ["", "-OP", "-OTC"];
  for (const name of Object.keys(map)) {
    const base = name.replace(/-(OP|OTC|L)$/, "");
    if (base === name || map[base]) continue;
    for (const suffix of SUFFIX_PRIORITY) {
      const candidate = map[`${base}${suffix}`];
      if (candidate) {
        map[base] = candidate;
        break;
      }
    }
  }

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

const candleCache = new Map<string, { candles: UpstreamCandle[]; expiresAt: number }>();
const candleRequests = new Map<string, Promise<UpstreamCandle[]>>();

export async function fetchCandles(
  iqName: string,
  sizeSeconds: number,
  count: number,
): Promise<UpstreamCandle[]> {
  const cacheKey = `${iqName.toUpperCase()}:${sizeSeconds}:${count}`;
  const cached = candleCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.candles;
  const pending = candleRequests.get(cacheKey);
  if (pending) return pending;

  const activeId = (await getActiveIdMap())[iqName.toUpperCase()];
  if (!activeId) throw new Error(`Unknown IQ Option asset: ${iqName}`);

  const request = withSession(async (send, waitFor) => {
    const requestId = `candles-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
    // The shared socket can have several candle requests in flight. Matching
    // only by request_id prevents one asset's response from resolving every
    // pending request with the wrong candle set.
    const frame = await waitFor((f) => f.request_id === requestId, 15_000);
    const raw = ((frame.msg ?? {}) as { candles?: Array<Record<string, number>> }).candles ?? [];
    const candles = raw
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
    candleCache.set(cacheKey, {
      candles,
      expiresAt: Date.now() + (sizeSeconds <= 1 ? 1_500 : 4_000),
    });
    return candles;
  }).finally(() => {
    candleRequests.delete(cacheKey);
  });
  candleRequests.set(cacheKey, request);
  return request;
}
