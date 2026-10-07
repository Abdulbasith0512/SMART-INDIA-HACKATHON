// @vitest-environment node
// Regression: the M1 auth foundation must keep working after the M2 migrations.
import { beforeAll, describe, expect, it } from "vitest";
import { IDS, asAnon, asUser, createDb, run, seedFixture, type Db } from "./harness";

let db: Db;
beforeAll(async () => {
  db = await createDb();
  await seedFixture(db);
}, 120_000);

const code = (o: { error?: { code?: string } }) => o.error?.code;

describe("M1 auth foundation (regression)", () => {
  it("signup trigger creates a profile and exactly one citizen role; hostile metadata is ignored", async () => {
    await run(db, `insert into auth.users (id, email, raw_user_meta_data) values
      ('00000000-0000-0000-0000-0000000d0001', 'new@test.invalid', '{"display_name":"  New  ","role":"admin","roles":["admin"],"preferred_language":"xx"}')`);
    const p = (await run<{ display_name: string; preferred_language: string }>(db, `select * from public.profiles where id = '00000000-0000-0000-0000-0000000d0001'`)).rows[0];
    expect(p.display_name).toBe("New");
    expect(p.preferred_language).toBe("en");
    const roles = (await run<{ role: string }>(db, `select role from public.user_roles where user_id = '00000000-0000-0000-0000-0000000d0001'`)).rows.map((r) => r.role);
    expect(roles).toEqual(["citizen"]);
  });

  it("a citizen cannot grant, change or delete roles, or call admin functions", async () => {
    expect(code(await asUser(db, IDS.citizenA, () => run(db, `insert into public.user_roles (user_id, role) values ('${IDS.citizenA}', 'admin')`)))).toBe("42501");
    expect(code(await asUser(db, IDS.citizenA, () => run(db, `update public.user_roles set role = 'admin' where user_id = '${IDS.citizenA}'`)))).toBe("42501");
    expect(code(await asUser(db, IDS.citizenA, () => run(db, `delete from public.user_roles where user_id = '${IDS.citizenA}'`)))).toBe("42501");
    expect(code(await asUser(db, IDS.citizenA, () => run(db, `select public.admin_set_user_role('${IDS.citizenA}', 'admin', true)`)))).toBe("42501");
    expect(code(await asUser(db, IDS.citizenA, () => run(db, `select * from public.admin_list_users()`)))).toBe("42501");
  });

  it("a citizen reads only their own profile and roles", async () => {
    const p = await asUser(db, IDS.citizenA, () => run<{ id: string }>(db, `select id from public.profiles`));
    expect(p.rows.map((r) => r.id)).toEqual([IDS.citizenA]);
    const r = await asUser(db, IDS.citizenA, () => run(db, `select * from public.user_roles where user_id = '${IDS.citizenB}'`));
    expect(r.rows).toHaveLength(0);
  });

  it("an admin can grant/revoke other users' roles but never their own; changes are audited", async () => {
    const grant = await asUser(db, IDS.admin, () => run(db, `select public.admin_set_user_role('${IDS.citizenB}', 'clinician', true)`));
    expect(grant.error).toBeUndefined();
    expect(code(await asUser(db, IDS.admin, () => run(db, `select public.admin_set_user_role('${IDS.admin}', 'officer', true)`)))).toBe("42501");
    expect(code(await asUser(db, IDS.admin, () => run(db, `select public.admin_set_user_role('${IDS.citizenB}', 'citizen', false)`)))).toBe("42501");
    await asUser(db, IDS.admin, () => run(db, `select public.admin_set_user_role('${IDS.citizenB}', 'clinician', false)`));
    const a = await run<{ action: string }>(db, `select action from public.audit_log where entity = 'user_roles' and entity_id = '${IDS.citizenB}' and action like 'role.%' and metadata ->> 'role' = 'clinician' order by id`);
    expect(a.rows.map((r) => r.action)).toEqual(["role.granted", "role.revoked"]);
  });

  it("the audit log is append-only, even for the table owner, and unreadable to non-admins", async () => {
    expect((await run(db, `update public.audit_log set action = 'x'`)).error?.message).toMatch(/append-only/);
    expect((await run(db, `delete from public.audit_log`)).error?.message).toMatch(/append-only/);
    expect((await asUser(db, IDS.citizenA, () => run(db, `select * from public.audit_log`))).rows).toHaveLength(0);
    expect(code(await asUser(db, IDS.citizenA, () => run(db, `insert into public.audit_log (action, entity) values ('x','y')`)))).toBe("42501");
  });

  it("anon has no access to profiles or the role functions; trigger functions are not executable", async () => {
    expect(code(await asAnon(db, () => run(db, `select * from public.profiles`)))).toBe("42501");
    expect(code(await asAnon(db, () => run(db, `select public.has_role('${IDS.admin}', 'admin')`)))).toBe("42501");
    expect(code(await asUser(db, IDS.admin, () => run(db, `select public.handle_new_user()`)))).toBe("42501");
    expect(code(await asUser(db, IDS.admin, () => run(db, `select public.audit_user_roles()`)))).toBe("42501");
  });

  it("deleting an auth user cascades without tripping the immutable audit trigger", async () => {
    const r = await run(db, `delete from auth.users where id = '00000000-0000-0000-0000-0000000d0001'`);
    expect(r.error).toBeUndefined();
  });
});
