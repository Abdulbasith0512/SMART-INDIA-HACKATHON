-- pgTAP tests for the M1 auth foundation. Run with: supabase test db
begin;
select plan(17);

-- Fixtures (inserted as the privileged test user; triggers create profile + citizen role)
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'citizen1@example.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'citizen2@example.test'),
  ('00000000-0000-0000-0000-0000000000ad', 'admin1@example.test'),
  ('00000000-0000-0000-0000-0000000000ae', 'admin2@example.test');

insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000ad', 'admin'),
  ('00000000-0000-0000-0000-0000000000ae', 'admin');

-- 1-2: signup trigger
select is(
  (select count(*)::int from public.user_roles where user_id = '00000000-0000-0000-0000-0000000000a1'),
  1, 'new user has exactly one role');
select is(
  (select role::text from public.user_roles where user_id = '00000000-0000-0000-0000-0000000000a1'),
  'citizen', 'that role is citizen');

-- Act as citizen1
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;

-- 3: reads own profile only
select is((select count(*)::int from public.profiles), 1, 'citizen sees only own profile');
select is((select id::text from public.profiles), '00000000-0000-0000-0000-0000000000a1', 'and it is their own');

-- 5: cannot insert a role
select throws_ok(
  $$insert into public.user_roles (user_id, role) values ('00000000-0000-0000-0000-0000000000a1', 'admin')$$,
  '42501', null, 'citizen cannot self-promote via insert');

-- 6: cannot update role (no privilege)
select throws_ok(
  $$update public.user_roles set role = 'admin' where user_id = '00000000-0000-0000-0000-0000000000a1'$$,
  '42501', null, 'citizen cannot update roles');

-- 7: cannot delete role
select throws_ok(
  $$delete from public.user_roles where user_id = '00000000-0000-0000-0000-0000000000a1'$$,
  '42501', null, 'citizen cannot delete roles');

-- 8: cannot call admin RPC
select throws_ok(
  $$select public.admin_set_user_role('00000000-0000-0000-0000-0000000000a1', 'admin', true)$$,
  '42501', 'not authorized', 'citizen cannot call admin_set_user_role');

-- 9: cannot list users
select throws_ok($$select * from public.admin_list_users()$$, '42501', 'not authorized', 'citizen cannot list users');

-- 10: cannot read audit log (RLS hides rows or no rows visible)
select is((select count(*)::int from public.audit_log), 0, 'citizen sees no audit rows');

-- 11: cannot write audit log
select throws_ok(
  $$insert into public.audit_log (action, entity) values ('x', 'y')$$,
  '42501', null, 'citizen cannot insert into audit_log');

-- 12: cannot update own profile's non-allowed columns (id)
select throws_ok(
  $$update public.profiles set created_at = now() where id = '00000000-0000-0000-0000-0000000000a1'$$,
  '42501', null, 'citizen cannot update protected profile columns');

-- Act as admin1
reset role;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000ad","role":"authenticated"}', true);
set local role authenticated;

-- 13: admin cannot change own role
select throws_ok(
  $$select public.admin_set_user_role('00000000-0000-0000-0000-0000000000ad', 'officer', true)$$,
  '42501', 'admins cannot change their own role', 'admin cannot change own role');

-- 14: admin can grant another user a role
select lives_ok(
  $$select public.admin_set_user_role('00000000-0000-0000-0000-0000000000a2', 'officer', true)$$,
  'admin can grant officer to another user');
select ok(
  exists (select 1 from public.user_roles where user_id = '00000000-0000-0000-0000-0000000000a2' and role = 'officer'), 'officer role was granted');

-- 16: grant was audited and admin can read it
select ok(
  exists (select 1 from public.audit_log where action = 'role.granted' and entity_id = '00000000-0000-0000-0000-0000000000a2'),
  'role grant is in the audit log');

-- 17: audit log is immutable even for privileged callers
reset role;
select throws_ok(
  $$delete from public.audit_log$$, 'P0001', 'audit_log is append-only', 'audit_log cannot be deleted');

select * from finish();
rollback;
