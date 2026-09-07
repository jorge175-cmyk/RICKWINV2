import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { timeframeSeconds } from "@/lib/iqoption/mapping";
import { analyze, CONFIRMATION_TF, type AnalysisResult } from "./strategy";

const inputSchema = z.object({
  asset: z.string().min(3),
  timeframe: z.enum(["M1", "M5", "M15"]),
});

/** Runs the combined strategy (trend+RSI, multi-timeframe, candle patterns). */
export const analyzeAsset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => inputSchema.parse(input))
  .handler(async ({ data }): Promise<{ result: AnalysisResult | null; error?: string; retryAfterMs?: number }> => {
    const { fetchCandles, IqOptionBackoffError } = await import("@/lib/iqoption/iqoption.server");
    const entrySize = timeframeSeconds(data.timeframe);
    const higher = CONFIRMATION_TF[data.timeframe] ?? CONFIRMATION_TF['M5']!;
    try {
      const [entryCandles, higherCandles] = await Promise.all([
        fetchCandles(data.asset, entrySize, 120),
        fetchCandles(data.asset, higher.seconds, 80),
      ]);
      if (entryCandles.length === 0) {
        return { result: null, error: "Sem dados de mercado para este ativo." };
      }
      return { result: analyze(data.asset, data.timeframe, entryCandles, higherCandles) };
    } catch (error) {
      console.error("[analysis] failed", error);
      if (error instanceof IqOptionBackoffError) {
        return {
          result: null,
          error: "Conexão com a IQ Option em recuperação. A análise retomará automaticamente.",
          retryAfterMs: error.retryAfterMs,
        };
      }
      return { result: null, error: "Análise temporariamente indisponível." };
    }
  });
