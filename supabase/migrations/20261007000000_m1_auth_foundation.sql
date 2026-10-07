-- JanSanket M1: secure authentication foundation.
-- Tables: profiles, user_roles, audit_log. Default-deny RLS everywhere.
-- Role changes are possible ONLY through admin_set_user_role(); clients have no
-- direct write access to user_roles or audit_log.

create type public.app_role as enum ('citizen', 'clinician', 'officer', 'admin');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) <= 100),
  preferred_language text not null default 'en' check (preferred_language in ('en', 'hi', 'or')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.app_role not null,
  region_id uuid, -- FK to regions arrives in M2
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);
create index user_roles_user_id_idx on public.user_roles (user_id);

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid, -- deliberately no FK: audit rows must survive user deletion and are immutable
  action text not null,
  entity text not null,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_created_at_idx on public.audit_log (created_at desc);

-- ---------------------------------------------------------------------------
-- Privileges: start from nothing, grant back the minimum.
-- ---------------------------------------------------------------------------
revoke all on public.profiles from anon, authenticated;
revoke all on public.user_roles from anon, authenticated;
revoke all on public.audit_log from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (display_name, preferred_language) on public.profiles to authenticated;
grant select on public.user_roles to authenticated;
grant select on public.audit_log to authenticated;

-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------
create function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles ur
    where ur.user_id = _user_id and ur.role = _role
  );
$$;

revoke all on function public.has_role(uuid, public.app_role) from public, anon;
grant execute on function public.has_role(uuid, public.app_role) to authenticated;

-- Internal only: not callable by clients. Invoked from triggers/definer functions.
create function public.write_audit(_actor uuid, _action text, _entity text, _entity_id text, _metadata jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_log (actor_id, action, entity, entity_id, metadata)
  values (_actor, _action, _entity, _entity_id, coalesce(_metadata, '{}'::jsonb));
$$;

revoke all on function public.write_audit(uuid, text, text, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Append-only audit log (also blocks the service role / table owner)
-- ---------------------------------------------------------------------------
create function public.audit_log_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_log is append-only';
end;
$$;

create trigger audit_log_no_update_delete
  before update or delete on public.audit_log
  for each row execute function public.audit_log_immutable();

-- ---------------------------------------------------------------------------
-- New auth user -> profile + citizen role. Client metadata can NOT set a role.
-- ---------------------------------------------------------------------------
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _name text := nullif(left(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), 100), '');
  _lang text := coalesce(new.raw_user_meta_data ->> 'preferred_language', 'en');
begin
  if _lang not in ('en', 'hi', 'or') then
    _lang := 'en';
  end if;

  insert into public.profiles (id, display_name, preferred_language)
  values (new.id, _name, _lang);

  insert into public.user_roles (user_id, role) values (new.id, 'citizen');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- Every role grant/revoke is audited, whoever performs it (RPC, service role, SQL).
create function public.audit_user_roles()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.write_audit(auth.uid(), 'role.granted', 'user_roles', new.user_id::text,
      jsonb_build_object('role', new.role));
    return new;
  elsif tg_op = 'DELETE' then
    perform public.write_audit(auth.uid(), 'role.revoked', 'user_roles', old.user_id::text,
      jsonb_build_object('role', old.role));
    return old;
  end if;
  return null;
end;
$$;

create trigger user_roles_audit
  after insert or delete on public.user_roles
  for each row execute function public.audit_user_roles();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.audit_log enable row level security;

create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

create policy profiles_select_admin on public.profiles
  for select to authenticated
  using (public.has_role((select auth.uid()), 'admin'));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy user_roles_select_own on public.user_roles
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy user_roles_select_admin on public.user_roles
  for select to authenticated
  using (public.has_role((select auth.uid()), 'admin'));

-- Intentionally NO insert/update/delete policies on user_roles or audit_log.

create policy audit_log_select_admin on public.audit_log
  for select to authenticated
  using (public.has_role((select auth.uid()), 'admin'));

-- ---------------------------------------------------------------------------
-- Admin RPCs (the only client path to change roles / list users)
-- ---------------------------------------------------------------------------
create function public.admin_set_user_role(_target uuid, _role public.app_role, _grant boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _caller uuid := auth.uid();
begin
  if _caller is null or not public.has_role(_caller, 'admin') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if _target = _caller then
    raise exception 'admins cannot change their own role' using errcode = '42501';
  end if;
  if not exists (select 1 from auth.users where id = _target) then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  if _role = 'citizen' then
    raise exception 'the citizen role is implicit and cannot be changed' using errcode = '42501';
  end if;

  if _grant then
    insert into public.user_roles (user_id, role, granted_by)
    values (_target, _role, _caller)
    on conflict (user_id, role) do nothing;
  else
    delete from public.user_roles where user_id = _target and role = _role;
  end if;
end;
$$;

revoke all on function public.admin_set_user_role(uuid, public.app_role, boolean) from public, anon;
grant execute on function public.admin_set_user_role(uuid, public.app_role, boolean) to authenticated;

create function public.admin_list_users(_limit int default 50, _offset int default 0)
returns table (
  user_id uuid,
  email text,
  display_name text,
  roles public.app_role[],
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.has_role(auth.uid(), 'admin') then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return query
    select u.id,
           u.email::text,
           p.display_name,
           coalesce(array_agg(ur.role order by ur.role) filter (where ur.role is not null), '{}'::public.app_role[]),
           u.created_at
    from auth.users u
    left join public.profiles p on p.id = u.id
    left join public.user_roles ur on ur.user_id = u.id
    group by u.id, u.email, p.display_name, u.created_at
    order by u.created_at desc
    limit least(greatest(_limit, 1), 200)
    offset greatest(_offset, 0);
end;
$$;

revoke all on function public.admin_list_users(int, int) from public, anon;
grant execute on function public.admin_list_users(int, int) to authenticated;
