INSERT INTO public.iqoption_connection_state (singleton, login_failures, updated_at)
VALUES (TRUE, 0, now())
ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION public.claim_iqoption_login(claim_for_seconds integer DEFAULT 20)
RETURNS TABLE(
  claimed boolean,
  ssid text,
  ssid_expires_at timestamptz,
  login_blocked_until timestamptz,
  login_blocked_reason text,
  login_failures integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_state public.iqoption_connection_state%ROWTYPE;
BEGIN
  INSERT INTO public.iqoption_connection_state (singleton, login_failures, updated_at)
  VALUES (TRUE, 0, now())
  ON CONFLICT (singleton) DO NOTHING;

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
    now() + make_interval(secs => GREATEST(claim_for_seconds, 5)),
    'Login em andamento'::TEXT,
    current_state.login_failures;
END;
$$;