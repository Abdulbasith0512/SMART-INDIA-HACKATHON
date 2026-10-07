-- JanSanket M1 hardening: trigger functions must not be directly executable by API roles.
-- Triggers keep firing: EXECUTE is checked when a trigger is created, not when it fires.
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.audit_user_roles() from public, anon, authenticated;
