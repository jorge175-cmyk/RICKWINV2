// Secure WebSocket proxy: browser <-> this route <-> IQ Option.
// The browser cannot reach IQ Option directly (Origin is rejected) and must
// never see the SSID. A valid Supabase JWT (?token=) is required before any
// upstream connection is opened.
import { createFileRoute } from "@tanstack/react-router";

async function isValidSupabaseToken(token: string): Promise<boolean> {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key || token.split(".").length !== 3) return false;
  try {
    const res = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: key, Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const Route = createFileRoute("/api/public/iqoption-ws")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return new Response("Expected a WebSocket upgrade", { status: 426 });
        }

        const Pair = (globalThis as { WebSocketPair?: new () => Record<string, WebSocket> })
          .WebSocketPair;
        if (!Pair) {
          // Local dev runtime cannot accept WebSocket upgrades; clients fall
          // back to polling the candle server function.
          return new Response("WebSocket streaming unavailable in this runtime", { status: 501 });
        }

        const token = new URL(request.url).searchParams.get("token") ?? "";
        if (!(await isValidSupabaseToken(token))) {
          return new Response("Unauthorized", { status: 401 });
        }

        const { getSsid, openUpstreamSocket, authenticate, IqOptionBackoffError } = await import(
          "@/lib/iqoption/iqoption.server"
        );

        let ssid: string;
        let upstream: WebSocket;
        try {
          ssid = await getSsid();
          upstream = await openUpstreamSocket();
        } catch (error) {
          console.error("[iqoption-ws] upstream setup failed", error);
          if (error instanceof IqOptionBackoffError) {
            return new Response("Upstream temporarily rate limited", {
              status: 503,
              headers: { "retry-after": String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))) },
            });
          }
          return new Response("Upstream authentication failed", { status: 502 });
        }

        const pair = new Pair();
        const client = pair["0"]!;
        const server = pair["1"]! as WebSocket & { accept?: () => void };
        server.accept?.();

        const pending: string[] = [];
        let upstreamReady = false;
        let closed = false;
        const authenticationTimer = setTimeout(() => closeBoth(), 20_000);

        upstream.addEventListener("open", () => {
          authenticate(upstream, ssid);
          upstream.send(JSON.stringify({ name: "setOptions", msg: { sendResults: true } }));
        });

        upstream.addEventListener("message", (event) => {
          const data = (event as MessageEvent).data;
          if (typeof data === "string") {
            try {
              const frame = JSON.parse(data) as { name?: string; msg?: unknown };
              if (!upstreamReady && frame.name === "profile" && frame.msg) {
                upstreamReady = true;
                clearTimeout(authenticationTimer);
                for (const queued of pending.splice(0)) upstream.send(queued);
                server.send(JSON.stringify({ name: "proxy-ready", msg: { ok: true } }));
              }
              // Answering the provider heartbeat keeps this channel alive for
              // hours instead of being dropped as idle.
              if (frame.name === "heartbeat") {
                const now = Date.now();
                const msg = (frame.msg ?? {}) as { serverTime?: number };
                upstream.send(
                  JSON.stringify({
                    name: "heartbeat",
                    msg: { userTime: now, heartbeatTime: msg.serverTime ?? now },
                  }),
                );
              }
              server.send(data);
            } catch {
              // client gone
            }
          }
        });

        // Keepalive towards the browser: on quiet assets no market frame may
        // arrive for minutes, and without this the client watchdog treated a
        // healthy channel as dead and reconnected constantly.
        const keepAlive = setInterval(() => {
          if (closed) return;
          try {
            server.send(JSON.stringify({ name: "proxy-keepalive", msg: { at: Date.now() } }));
          } catch {
            closeBoth();
          }
        }, 10_000);

        const closeBoth = () => {
          if (closed) return;
          closed = true;
          clearInterval(keepAlive);
          clearTimeout(authenticationTimer);
          try {
            upstream.close();
          } catch {
            /* noop */
          }
          try {
            server.close();
          } catch {
            /* noop */
          }
        };

        upstream.addEventListener("close", closeBoth);
        upstream.addEventListener("error", closeBoth);

        server.addEventListener("message", (event) => {
          const data = (event as MessageEvent).data;
          if (typeof data !== "string") return;
          // The browser must never inject credential frames.
          try {
            if ((JSON.parse(data) as { name?: string }).name === "ssid") return;
          } catch {
            return;
          }
          if (upstreamReady) upstream.send(data);
          else pending.push(data);
        });

        server.addEventListener("close", closeBoth);
        server.addEventListener("error", closeBoth);

        return new Response(null, {
          status: 101,
          webSocket: client,
        } as ResponseInit & { webSocket: WebSocket });
      },
    },
  },
});
