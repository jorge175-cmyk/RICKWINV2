-- Revoke from public (which includes anon and authenticated) explicitly.
revoke execute on function public.has_role(uuid, public.app_role) from public;

-- Confirm only postgres/database owner retains execute (used by RLS policies internally).
grant execute on function public.has_role(uuid, public.app_role) to postgres;
