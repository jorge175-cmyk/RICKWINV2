-- Persistent candle cache for the mirror/replay scan: avoids re-downloading
-- the full history from IQ Option on every scan. Only the server (service
-- role, via supabaseAdmin) ever reads or writes this table, same pattern as
-- iqoption_connection_state.
CREATE TABLE IF NOT EXISTS public.iqoption_candles (
  asset TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  "time" BIGINT NOT NULL,
  open DOUBLE PRECISION NOT NULL,
  high DOUBLE PRECISION NOT NULL,
  low DOUBLE PRECISION NOT NULL,
  close DOUBLE PRECISION NOT NULL,
  volume DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  PRIMARY KEY (asset, timeframe, "time")
);

CREATE INDEX IF NOT EXISTS idx_iqoption_candles_lookup
  ON public.iqoption_candles (asset, timeframe, "time" DESC);

ALTER TABLE public.iqoption_candles ENABLE ROW LEVEL SECURITY;

-- No policies: RLS with zero policies denies anon/authenticated entirely.
-- service_role (supabaseAdmin) bypasses RLS by design, which is the only
-- way this table is ever accessed.
