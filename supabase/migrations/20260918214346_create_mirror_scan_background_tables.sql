-- Suporte para a varredura de replay rodar sozinha em segundo plano (job de
-- cron), em vez de só sob demanda quando o usuário clica em "Varrer" e espera.
--
-- mirror_scan_cursor: onde o job parou (um lote de ativos ao vivo, uma fatia
-- do catálogo dentro desse lote), por timeframe. Guarda também a janela ao
-- vivo já buscada do lote atual, para não reabrir conexão com a corretora a
-- cada fatia só para reler a mesma ponta viva.
--
-- claimed_until: como o agendamento pode disparar de poucos em poucos
-- segundos, duas chamadas poderiam se sobrepor e corromper o cursor (uma
-- lendo o progresso antes da outra terminar de gravar). Mesma trava por
-- tempo já usada para coordenar o login da IQ Option (claim_iqoption_login):
-- só processa quem conseguir "reivindicar" o cursor.
CREATE TABLE public.mirror_scan_cursor (
  timeframe TEXT PRIMARY KEY,
  live_offset INTEGER NOT NULL DEFAULT 0,
  haystack_offset INTEGER NOT NULL DEFAULT 0,
  live_windows JSONB NOT NULL DEFAULT '{}'::jsonb,
  claimed_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.mirror_scan_cursor TO service_role;

ALTER TABLE public.mirror_scan_cursor ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages mirror scan cursor"
  ON public.mirror_scan_cursor
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- mirror_replay_matches: os replays encontrados pela última passada completa
-- do job para cada ativo ao vivo. Uma linha por coincidência (histAsset +
-- transform + startTime); ao começar uma passada nova para um ativo, suas
-- linhas antigas são apagadas antes de gravar as novas, então a tabela nunca
-- mistura resultados de passadas diferentes para o mesmo ativo.
CREATE TABLE public.mirror_replay_matches (
  id BIGSERIAL PRIMARY KEY,
  timeframe TEXT NOT NULL,
  live_asset TEXT NOT NULL,
  live_window JSONB NOT NULL,
  hist_asset TEXT NOT NULL,
  transform TEXT NOT NULL,
  correlation DOUBLE PRECISION NOT NULL,
  similarity DOUBLE PRECISION NOT NULL,
  max_deviation DOUBLE PRECISION NOT NULL,
  is_exact BOOLEAN NOT NULL,
  start_time BIGINT NOT NULL,
  end_time BIGINT NOT NULL,
  volatility_ratio DOUBLE PRECISION NOT NULL,
  predicted_return DOUBLE PRECISION NOT NULL,
  direction TEXT NOT NULL,
  projected_close DOUBLE PRECISION NOT NULL,
  window JSONB NOT NULL,
  next_candle JSONB,
  projection JSONB NOT NULL,
  found_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.mirror_replay_matches TO service_role;
GRANT SELECT ON public.mirror_replay_matches TO authenticated;

ALTER TABLE public.mirror_replay_matches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages mirror replay matches"
  ON public.mirror_replay_matches
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Usuários logados podem LER os replays (é o que a tela do Espelho OTC
-- mostra), mas só o service_role (servidor) grava.
CREATE POLICY "Authenticated users read mirror replay matches"
  ON public.mirror_replay_matches
  FOR SELECT
  TO authenticated
  USING (true);

CREATE INDEX mirror_replay_matches_lookup_idx
  ON public.mirror_replay_matches (timeframe, live_asset, correlation DESC);
