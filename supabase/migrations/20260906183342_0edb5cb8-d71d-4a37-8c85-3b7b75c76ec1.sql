CREATE TABLE public.iqoption_connection_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  ssid TEXT,
  ssid_expires_at TIMESTAMPTZ,
  login_blocked_until TIMESTAMPTZ,
  login_blocked_reason TEXT,
  login_failures INTEGER NOT NULL DEFAULT 0 CHECK (login_failures >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.iqoption_connection_state TO service_role;

ALTER TABLE public.iqoption_connection_state ENABLE ROW LEVEL SECURITY;

INSERT INTO public.iqoption_connection_state (singleton) VALUES (TRUE);

CREATE OR REPLACE FUNCTION public.claim_iqoption_login(
  claim_for_seconds INTEGER DEFAULT 20
)
RETURNS TABLE (
  claimed BOOLEAN,
  ssid TEXT,
  ssid_expires_at TIMESTAMPTZ,
  login_blocked_until TIMESTAMPTZ,
  login_blocked_reason TEXT,
  login_failures INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_state public.iqoption_connection_state%ROWTYPE;
BEGIN
  SELECT * INTO current_state
  FROM public.iqoption_connection_state
  WHERE singleton = TRUE
  FOR UPDATE;

  IF current_state.ssid IS NOT NULL
     AND current_state.ssid_expires_at > now() THEN
    RETURN QUERY SELECT FALSE, current_state.ssid, current_state.ssid_expires_at,
      current_state.login_blocked_until, current_state.login_blocked_reason,
      current_state.login_failures;
    RETURN;
  END IF;

  IF current_state.login_blocked_until IS NOT NULL
     AND current_state.login_blocked_until > now() THEN
    RETURN QUERY SELECT FALSE, current_state.ssid, current_state.ssid_expires_at,
      current_state.login_blocked_until, current_state.login_blocked_reason,
      current_state.login_failures;
    RETURN;
  END IF;

  UPDATE public.iqoption_connection_state
  SET login_blocked_until = now() + make_interval(secs => GREATEST(claim_for_seconds, 5)),
      login_blocked_reason = 'Login em andamento',
      updated_at = now()
  WHERE singleton = TRUE;

  RETURN QUERY SELECT TRUE, current_state.ssid, current_state.ssid_expires_at,
    now() + make_interval(secs => GREATEST(claim_for_seconds, 5)), 'Login em andamento'::TEXT,
    current_state.login_failures;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_iqoption_login(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_iqoption_login(INTEGER) TO service_role;