import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { CandleData } from "./mapping";

const inputSchema = z.object({
  asset: z.string(),
  sizeSeconds: z.number(),
  count: z.number(),
});

/** History (and polling fallback) source for candles. Authenticated only. */
export const getCandles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => inputSchema.parse(input))
  .handler(async ({ data }): Promise<{ candles: CandleData[]; error?: string; retryAfterMs?: number }> => {
    const { fetchCandles, IqOptionBackoffError } = await import("./iqoption.server");
    const count = Math.min(Math.max(data.count, 1), 500);
    try {
      const candles = await fetchCandles(data.asset, data.sizeSeconds, count);
      return { candles };
    } catch (error) {
      console.error("[iqoption] candle fetch failed", error);
      if (error instanceof IqOptionBackoffError) {
        return {
          candles: [],
          error: "Conexão com a IQ Option em pausa para evitar bloqueio por excesso de acessos.",
          retryAfterMs: error.retryAfterMs,
        };
      }
      return { candles: [], error: "Market data temporarily unavailable" };
    }
  });

export interface OtcAsset {
  symbol: string;
  name: string;
  category: string;
}

function prettyName(base: string) {
  return /^[A-Z]{6}$/.test(base) ? `${base.slice(0, 3)}/${base.slice(3)}` : base;
}

/** Markets currently exposed by the IQ Option connection (real + OTC). */
export const getOtcAssets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<OtcAsset[]> => {
    const { getActiveIdMap } = await import("./iqoption.server");
    try {
      const map = await getActiveIdMap();
      return Object.keys(map)
        .filter((name) => !/-(OP|L)$/.test(name))
        .map((name) => {
          const otc = name.endsWith("-OTC");
          const base = name.replace(/-OTC$/, "");
          return {
            symbol: name,
            name: otc ? `${prettyName(base)} OTC` : prettyName(base),
            category: otc ? "OTC" : "MERCADO REAL",
          };
        })
        .sort((a, b) =>
          a.category === b.category
            ? a.symbol.localeCompare(b.symbol)
            : a.category === "MERCADO REAL"
              ? -1
              : 1,
        );
    } catch (error) {
      console.error("[iqoption] asset list failed", error);
      return [];
    }
  });


/** Asset name -> IQ Option active_id, needed for live subscriptions. */
export const getActiveIds = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<Record<string, number>> => {
    const { getActiveIdMap } = await import("./iqoption.server");
    try {
      return await getActiveIdMap();
    } catch (error) {
      console.error("[iqoption] active id map failed", error);
      return {};
    }
  });
