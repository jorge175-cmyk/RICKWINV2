import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getCurrencyPairs = createServerFn({ method: "GET" }).handler(async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const supabasePublic = createClient(
    process.env['SUPABASE_URL']!,
    process.env['SUPABASE_PUBLISHABLE_KEY']!,
    {
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    },
  );
  const { data, error } = await supabasePublic
    .from("currency_pairs")
    .select("id, symbol, name, category, default_timeframe, active")
    .eq("active", true)
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return data || [];
});

export const getTradingSignals = createServerFn({ method: "GET" }).handler(async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const supabasePublic = createClient(
    process.env['SUPABASE_URL']!,
    process.env['SUPABASE_PUBLISHABLE_KEY']!,
    {
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    },
  );
  const { data, error } = await supabasePublic
    .from("signals")
    .select("id, pair_id, direction, entry_price, confidence, expiration_minutes, status, timeframe, analysis_summary, created_at, expired_at")
    .in("status", ["active", "expired"])
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return data || [];
});

export const getUserProfile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("profiles")
      .select("full_name, plan, timezone")
      .eq("id", context.userId)
      .maybeSingle();
    if (error) throw error;
    return data || { full_name: null, plan: null, timezone: null };
  });
