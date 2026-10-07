-- JanSanket M2 hardening: signed-in users must not be able to probe OTHER users' roles or regional scopes.
-- has_role() and is_region_in_scope() must stay executable by `authenticated` (RLS policies call them as the
-- invoking user), but they accept an arbitrary user id. Restrict evaluation to the caller's own id.
-- A NULL auth.uid() (service role / internal definer contexts / the table owner) is unaffected.

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (auth.uid() is null or auth.uid() = _user_id)
     and exists (
       select 1 from public.user_roles ur
       where ur.user_id = _user_id and ur.role = _role
     );
$$;

create or replace function public.is_region_in_scope(_user_id uuid, _role public.app_role, _region_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (auth.uid() is null or auth.uid() = _user_id)
     and exists (
       select 1
       from public.user_roles ur
       where ur.user_id = _user_id
         and ur.role = _role
         and ur.region_id is not null
         and _region_id in (select s.id from public.region_subtree(ur.region_id) s)
     );
$$;
