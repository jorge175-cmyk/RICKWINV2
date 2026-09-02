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
  .handler(async ({ data }): Promise<{ candles: CandleData[]; error?: string }> => {
    const { fetchCandles } = await import("./iqoption.server");
    const count = Math.min(Math.max(data.count, 1), 500);
    try {
      const candles = await fetchCandles(data.asset, data.sizeSeconds, count);
      return { candles };
    } catch (error) {
      console.error("[iqoption] candle fetch failed", error);
      return { candles: [], error: "Market data temporarily unavailable" };
    }
  });

export interface OtcAsset {
  symbol: string;
  name: string;
  category: string;
}

/** OTC markets currently exposed by the IQ Option connection. */
export const getOtcAssets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<OtcAsset[]> => {
    const { getActiveIdMap } = await import("./iqoption.server");
    try {
      const map = await getActiveIdMap();
      return Object.keys(map)
        .filter((name) => name.endsWith("-OTC"))
        .map((name) => {
          const base = name.replace(/-OTC$/, "");
          const isForex = /^[A-Z]{6}$/.test(base);
          const pretty = isForex ? `${base.slice(0, 3)}/${base.slice(3)}` : base;
          return {
            symbol: name,
            name: `${pretty} OTC`,
            category: isForex ? "FOREX OTC" : "OUTROS OTC",
          };
        })
        .sort((a, b) =>
          a.category === b.category
            ? a.symbol.localeCompare(b.symbol)
            : a.category === "FOREX OTC"
              ? -1
              : 1,
        );
    } catch (error) {
      console.error("[iqoption] otc asset list failed", error);
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
