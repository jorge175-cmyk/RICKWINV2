CREATE TABLE public.mirror_scan_cursor (
  timeframe TEXT PRIMARY KEY,
  live_offset INTEGER NOT NULL DEFAULT 0,
  haystack_offset INTEGER NOT NULL DEFAULT 0,
  live_windows JSONB NOT NULL DEFAULT '{}'::jsonb,
  claimed_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.mirror_scan_cursor TO service_role;
ALTER TABLE public.mirror_scan_cursor ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role manages scan cursor" ON public.mirror_scan_cursor FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE public.mirror_replay_matches (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  timeframe TEXT NOT NULL,
  live_asset TEXT NOT NULL,
  live_window JSONB NOT NULL,
  hist_asset TEXT NOT NULL,
  transform TEXT NOT NULL,
  correlation DOUBLE PRECISION NOT NULL,
  similarity DOUBLE PRECISION NOT NULL,
  max_deviation DOUBLE PRECISION NOT NULL,
  is_exact BOOLEAN NOT NULL DEFAULT false,
  start_time BIGINT NOT NULL,
  end_time BIGINT NOT NULL,
  volatility_ratio DOUBLE PRECISION NOT NULL,
  predicted_return DOUBLE PRECISION NOT NULL,
  direction TEXT NOT NULL,
  projected_close DOUBLE PRECISION NOT NULL,
  "window" JSONB NOT NULL,
  next_candle JSONB,
  projection JSONB,
  found_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX mirror_replay_matches_tf_asset_idx ON public.mirror_replay_matches (timeframe, live_asset);
CREATE INDEX mirror_replay_matches_corr_idx ON public.mirror_replay_matches (timeframe, correlation DESC);

GRANT SELECT ON public.mirror_replay_matches TO authenticated;
GRANT ALL ON public.mirror_replay_matches TO service_role;
ALTER TABLE public.mirror_replay_matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read replay matches" ON public.mirror_replay_matches FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role manages replay matches" ON public.mirror_replay_matches FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER update_mirror_scan_cursor_updated_at BEFORE UPDATE ON public.mirror_scan_cursor FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_mirror_replay_matches_updated_at BEFORE UPDATE ON public.mirror_replay_matches FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();