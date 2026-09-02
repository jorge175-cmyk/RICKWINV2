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

        const { getSsid, openUpstreamSocket, authenticate } = await import(
          "@/lib/iqoption/iqoption.server"
        );

        let ssid: string;
        let upstream: WebSocket;
        try {
          ssid = await getSsid();
          upstream = await openUpstreamSocket();
        } catch (error) {
          console.error("[iqoption-ws] upstream setup failed", error);
          return new Response("Upstream authentication failed", { status: 502 });
        }

        const pair = new Pair();
        const client = pair["0"]!;
        const server = pair["1"]! as WebSocket & { accept?: () => void };
        server.accept?.();

        const pending: string[] = [];
        let upstreamReady = false;

        upstream.addEventListener("open", () => {
          authenticate(upstream, ssid);
          upstream.send(JSON.stringify({ name: "setOptions", msg: { sendResults: true } }));
          upstreamReady = true;
          for (const frame of pending.splice(0)) upstream.send(frame);
          server.send(JSON.stringify({ name: "proxy-ready", msg: { ok: true } }));
        });

        upstream.addEventListener("message", (event) => {
          const data = (event as MessageEvent).data;
          if (typeof data === "string") {
            try {
              server.send(data);
            } catch {
              // client gone
            }
          }
        });

        const closeBoth = () => {
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
