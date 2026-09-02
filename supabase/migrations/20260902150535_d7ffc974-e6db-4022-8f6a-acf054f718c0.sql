-- Revoke direct execution of the security definer helper from API roles.
-- RLS policies still invoke it internally with the definer's privileges.
revoke execute on function public.has_role(uuid, public.app_role) from anon, authenticated;

-- Also restrict the user_roles table so only service_role and the helper can read it directly.
-- (SELECT grant for authenticated was already restricted via the policy; this removes direct API access.)
revoke select on public.user_roles from authenticated;

-- Re-run linter to confirm.
