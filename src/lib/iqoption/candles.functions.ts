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
