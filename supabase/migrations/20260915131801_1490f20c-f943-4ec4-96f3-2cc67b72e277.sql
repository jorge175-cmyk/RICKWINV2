REVOKE ALL ON FUNCTION public.claim_iqoption_login(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_iqoption_login(integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_iqoption_login(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_iqoption_login(integer) TO service_role;