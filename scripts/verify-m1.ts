// M1 end-to-end verification against a LIVE Supabase project (run AFTER the migration is applied).
// Reads VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY from .env.local.
// Creates throwaway users (m1-verify-*) and deletes them at the end. Audit rows are immutable and remain.
//
// Usage: npm run verify:m1
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnvFile(".env.local");

const url = process.env.VITE_SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anonKey || !serviceKey) {
  console.error("Need VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in .env.local.");
  process.exit(2);
}

const opts = { auth: { autoRefreshToken: false, persistSession: false } };
const service = createClient(url, serviceKey, opts);
const newAnon = () => createClient(url, anonKey, opts);

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -> ${detail}` : ""}`);
}

const stamp = Date.now();
const domain = process.env.VERIFY_EMAIL_DOMAIN ?? "example.com";
const mail = (tag: string) => `m1-verify-${stamp}-${tag}@${domain}`;
const pw = () => randomBytes(12).toString("base64url") + "aA1!";
const created: string[] = [];

async function adminCreate(tag: string, name: string) {
  const email = mail(tag);
  const password = pw();
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: name },
  });
  if (error) throw new Error(`createUser ${tag}: ${error.message}`);
  created.push(data.user.id);
  return { id: data.user.id, email, password };
}

async function signedIn(email: string, password: string): Promise<SupabaseClient> {
  const c = newAnon();
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in ${email}: ${error.message}`);
  return c;
}

async function rolesOf(userId: string): Promise<string[]> {
  const { data, error } = await service.from("user_roles").select("role").eq("user_id", userId);
  if (error) throw new Error(`rolesOf: ${error.message}`);
  return (data ?? []).map((r) => r.role as string).sort();
}

async function main() {
  // Preflight: migration applied?
  const pre = await service.from("user_roles").select("id", { head: true, count: "exact" });
  if (pre.error) {
    console.error(`Migration does not look applied (user_roles query failed: ${pre.error.message}).`);
    process.exit(3);
  }

  // ---- 1. Citizen signup through the real anon signUp path, with hostile metadata -------------
  const aEmail = mail("a");
  const aPass = pw();
  const anonA = newAnon();
  const su = await anonA.auth.signUp({
    email: aEmail,
    password: aPass,
    options: {
      data: { display_name: "Verify Citizen A", role: "admin", roles: ["admin", "officer"], app_role: "admin", preferred_language: "xx" },
    },
  });
  let aId: string | undefined = su.data.user?.id;
  const signupViaAnon =!su.error && !!aId;
  check("citizen signup via anon signUp creates auth.users", signupViaAnon, su.error?.message);
  if (!signupViaAnon) {
    console.log("      (falling back to admin createUser so the remaining checks can run)");
    const fallback = await service.auth.admin.createUser({
      email: aEmail,
      password: aPass,
      email_confirm: true,
      user_metadata: { display_name: "Verify Citizen A", role: "admin", roles: ["admin", "officer"], preferred_language: "xx" },
    });
    if (fallback.error) throw new Error(`fallback createUser: ${fallback.error.message}`);
    aId = fallback.data.user.id;
  }
  created.push(aId!);
  // If email confirmation is on, signUp returns no session: confirm via admin so we can sign in.
  await service.auth.admin.updateUserById(aId!, { email_confirm: true });

  const prof = await service.from("profiles").select("*").eq("id", aId!).maybeSingle();
  check("signup creates profiles row", !!prof.data, prof.error?.message);
  check("profile display_name taken from metadata", prof.data?.display_name === "Verify Citizen A");
  check("invalid preferred_language in metadata falls back to 'en'", prof.data?.preferred_language === "en", String(prof.data?.preferred_language));
  const aRoles = await rolesOf(aId!);
  check("signup auto-creates exactly the citizen role", aRoles.length === 1 && aRoles[0] === "citizen", JSON.stringify(aRoles));
  check("client cannot choose officer/admin via signup metadata", !aRoles.includes("admin") && !aRoles.includes("officer"), JSON.stringify(aRoles));

  // ---- 2. Citizen A cannot escalate or read others --------------------------------------------
  const b = await adminCreate("b", "Verify Citizen B");
  const a = await signedIn(aEmail, aPass);

  const ins = await a.from("user_roles").insert({ user_id: aId!, role: "admin" });
  check("citizen cannot insert own admin role", !!ins.error, "insert succeeded");
  const upd = await a.from("user_roles").update({ role: "admin" }).eq("user_id", aId!).select();
  check("citizen cannot update roles", !!upd.error || (upd.data ?? []).length === 0, "update affected rows");
  const del = await a.from("user_roles").delete().eq("user_id", aId!).select();
  check("citizen cannot delete roles", !!del.error || (del.data ?? []).length === 0, "delete affected rows");
  check("citizen role still intact after attacks", (await rolesOf(aId!)).join() === "citizen");

  const rpcSelf = await a.rpc("admin_set_user_role", { _target: aId!, _role: "admin", _grant: true });
  check("citizen cannot self-promote via admin_set_user_role", !!rpcSelf.error);
  const rpcOther = await a.rpc("admin_set_user_role", { _target: b.id, _role: "officer", _grant: true });
  check("citizen cannot promote another user via RPC", !!rpcOther.error);
  const list = await a.rpc("admin_list_users", { _limit: 10, _offset: 0 });
  check("citizen cannot call admin_list_users", !!list.error);

  const profs = await a.from("profiles").select("id");
  check("citizen sees only their own profile (cannot read another user's)", !profs.error && (profs.data ?? []).length === 1 && profs.data![0].id === aId, JSON.stringify(profs.data));
  const otherProf = await a.from("profiles").select("id").eq("id", b.id);
  check("direct read of another user's profile returns nothing", !otherProf.error && (otherProf.data ?? []).length === 0);
  const otherRoles = await a.from("user_roles").select("role").eq("user_id", b.id);
  check("citizen cannot read another user's roles", !otherRoles.error && (otherRoles.data ?? []).length === 0);

  const aud = await a.from("audit_log").select("id").limit(5);
  check("citizen cannot read audit_log", !aud.error && (aud.data ?? []).length === 0);
  const audIns = await a.from("audit_log").insert({ action: "x", entity: "y" });
  check("citizen cannot write audit_log", !!audIns.error);
  const rpcAudit = await a.rpc("write_audit" as never, { _actor: aId, _action: "x", _entity: "y", _entity_id: "z", _metadata: {} } as never);
  check("write_audit is not callable by clients", !!rpcAudit.error);

  const ownUpd = await a.from("profiles").update({ display_name: "Renamed A" }).eq("id", aId!).select();
  check("citizen can update own display_name", !ownUpd.error && (ownUpd.data ?? []).length === 1, ownUpd.error?.message);
  const protUpd = await a.from("profiles").update({ created_at: new Date().toISOString() } as never).eq("id", aId!);
  check("citizen cannot update protected profile columns", !!protUpd.error);
  const othUpd = await a.from("profiles").update({ display_name: "hacked" }).eq("id", b.id).select();
  check("citizen cannot update another user's profile", !!othUpd.error || (othUpd.data ?? []).length === 0);

  // ---- 3. Officer role (granted by service role, as the bootstrap path) ------------------------
  const o = await adminCreate("o", "Verify Officer");
  const grantO = await service.from("user_roles").insert({ user_id: o.id, role: "officer" });
  check("service role can bootstrap an officer role", !grantO.error, grantO.error?.message);
  const oClient = await signedIn(o.email, o.password);
  const oRoles = await oClient.from("user_roles").select("role").eq("user_id", o.id);
  const oList = (oRoles.data ?? []).map((r) => r.role).sort();
  check("officer sees officer + citizen roles (so /officer guard passes)", oList.join() === "citizen,officer", oList.join());
  const aRolesSeen = (await a.from("user_roles").select("role").eq("user_id", aId!)).data?.map((r) => r.role) ?? [];
  check("citizen sees no officer role (so /officer guard rejects)", !aRolesSeen.includes("officer"));
  const oAdminCall = await oClient.rpc("admin_list_users", { _limit: 5, _offset: 0 });
  check("officer cannot call admin RPCs", !!oAdminCall.error);

  // ---- 4. Admin -------------------------------------------------------------------------------
  const ad = await adminCreate("ad", "Verify Admin");
  const grantAd = await service.from("user_roles").insert({ user_id: ad.id, role: "admin" });
  check("service role can bootstrap an admin role", !grantAd.error, grantAd.error?.message);
  const adClient = await signedIn(ad.email, ad.password);

  const adList = await adClient.rpc("admin_list_users", { _limit: 200, _offset: 0 });
  const listedIds = new Set((adList.data ?? []).map((u: { user_id: string }) => u.user_id));
  check("admin can list users (admin/users page data)", !adList.error && listedIds.has(aId!) && listedIds.has(b.id), adList.error?.message);

  const grant = await adClient.rpc("admin_set_user_role", { _target: aId!, _role: "officer", _grant: true });
  check("admin can grant a role to another user", !grant.error, grant.error?.message);
  check("granted role is persisted", (await rolesOf(aId!)).join() === "citizen,officer");

  const self = await adClient.rpc("admin_set_user_role", { _target: ad.id, _role: "officer", _grant: true });
  check("self-role-change is rejected", !!self.error && /own role/i.test(self.error.message), self.error?.message);
  const selfRevoke = await adClient.rpc("admin_set_user_role", { _target: ad.id, _role: "admin", _grant: false });
  check("admin cannot revoke their own admin role", !!selfRevoke.error);
  check("admin role still intact after self-change attempts", (await rolesOf(ad.id)).includes("admin"));
  const cit = await adClient.rpc("admin_set_user_role", { _target: b.id, _role: "citizen", _grant: false });
  check("citizen role cannot be revoked", !!cit.error);

  const revoke = await adClient.rpc("admin_set_user_role", { _target: aId!, _role: "officer", _grant: false });
  check("admin can revoke a role from another user", !revoke.error && (await rolesOf(aId!)).join() === "citizen", revoke.error?.message);

  // ---- 5. Audit -------------------------------------------------------------------------------
  const log = await adClient.from("audit_log").select("*").eq("entity_id", aId!).order("id", { ascending: true });
  const actions = (log.data ?? []).map((r) => `${r.action}:${(r.metadata as { role?: string })?.role}`);
  check("admin can read audit_log", !log.error && (log.data ?? []).length > 0, log.error?.message);
  check("role grant was audited (role.granted:officer)", actions.includes("role.granted:officer"), actions.join());
  check("role revoke was audited (role.revoked:officer)", actions.includes("role.revoked:officer"), actions.join());
  const grantRow = (log.data ?? []).find((r) => r.action === "role.granted" && (r.metadata as { role?: string })?.role === "officer");
  check("audit record carries the acting admin id", grantRow?.actor_id === ad.id, String(grantRow?.actor_id));

  const adUpd = await adClient.from("audit_log").update({ action: "tampered" }).eq("entity_id", aId!).select();
  check("admin cannot update audit_log", !!adUpd.error || (adUpd.data ?? []).length === 0);
  const adDel = await adClient.from("audit_log").delete().eq("entity_id", aId!).select();
  check("admin cannot delete audit_log", !!adDel.error || (adDel.data ?? []).length === 0);
  const svcUpd = await service.from("audit_log").update({ action: "tampered" }).eq("entity_id", aId!);
  check("audit_log is append-only even for the service role (update)", !!svcUpd.error && /append-only/i.test(svcUpd.error.message), svcUpd.error?.message);
  const svcDel = await service.from("audit_log").delete().eq("entity_id", aId!);
  check("audit_log is append-only even for the service role (delete)", !!svcDel.error && /append-only/i.test(svcDel.error.message), svcDel.error?.message);
  const still = await service.from("audit_log").select("id", { count: "exact", head: true }).eq("entity_id", aId!);
  check("audit rows still present after tamper attempts", (still.count ?? 0) >= 2, String(still.count));
}

main()
  .catch((e) => {
    check("script ran to completion", false, e instanceof Error ? e.message : String(e));
  })
  .finally(async () => {
    for (const id of created) await service.auth.admin.deleteUser(id).catch(() => undefined);
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed. Test users removed (${created.length}).`);
    process.exit(failed.length ? 1 : 0);
  });
