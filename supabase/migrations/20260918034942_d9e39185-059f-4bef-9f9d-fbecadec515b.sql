REVOKE ALL ON FUNCTION public.claim_iqoption_login(integer) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.claim_iqoption_login(integer) TO service_role;

REVOKE ALL ON FUNCTION public.update_updated_at_column() FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.update_updated_at_column() TO service_role;