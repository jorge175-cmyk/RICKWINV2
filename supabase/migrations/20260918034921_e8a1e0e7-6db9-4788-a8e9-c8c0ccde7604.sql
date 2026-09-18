CREATE TABLE public.iqoption_candle_coverage (
  asset TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  oldest_time BIGINT,
  newest_time BIGINT,
  blocks_fetched INTEGER NOT NULL DEFAULT 0,
  complete BOOLEAN NOT NULL DEFAULT FALSE,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (asset, timeframe)
);

GRANT ALL ON public.iqoption_candle_coverage TO service_role;

ALTER TABLE public.iqoption_candle_coverage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages candle coverage"
  ON public.iqoption_candle_coverage
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX iqoption_candle_coverage_pending_idx
  ON public.iqoption_candle_coverage (timeframe, complete, updated_at);

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_iqoption_candle_coverage_updated_at
  BEFORE UPDATE ON public.iqoption_candle_coverage
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();