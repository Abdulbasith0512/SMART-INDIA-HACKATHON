// M2 end-to-end verification against a LIVE Supabase project (run AFTER the M2 migrations are applied
// and `npm run seed:synthetic` has loaded the synthetic dataset).
// Creates throwaway users (m2-verify-*), signals and evidence, and removes them at the end.
// Immutable audit rows remain by design.
//
// Usage: npm run verify:m2
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createReportingService } from "../src/features/reporting/service";
import type { HealthReportInsertRow, RegionInfo, ReportingGateway } from "../src/features/reporting/contracts";
import {
  SYNTHETIC_BATCH, canonicalReportLine, generateSyntheticDataset, type SyntheticReport,
} from "../src/synthetic/generate";
import { COUNTRY_CODE, STATE_CODE } from "../src/synthetic/geography";

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

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -> ${detail}` : ""}`);
}
const section = (s: string) => console.log(`\n== ${s}`);
const denied = (e: { code?: string; message?: string } | null | undefined) => !!e && (e.code === "42501" || /permission denied|row-level security|not authorized/i.test(e.message ?? ""));

const ds = generateSyntheticDataset();
const geo = ds.geography;
const regionId = (code: string) => geo.byCode.get(code)!.id;
const KHORDHA = regionId(`${STATE_CODE}-KHO`);
const GANJAM = regionId(`${STATE_CODE}-GAN`);
const BAL = regionId(`${STATE_CODE}-KHO-BAL`);
const ASK = regionId(`${STATE_CODE}-GAN-ASK`);
const BAL_LOC = regionId(`${STATE_CODE}-KHO-BAL-L1`);
const STATE = regionId(STATE_CODE);
const COUNTRY = regionId(COUNTRY_CODE);

const stamp = Date.now();
const pw = () => randomBytes(12).toString("base64url") + "aA1!";
const createdUsers: string[] = [];
const createdSignals: string[] = [];
const createdEvidence: string[] = [];
const createdObservations: string[] = [];

interface TestUser { id: string; email: string; password: string; client: SupabaseClient }
async function makeUser(tag: string, roles: Array<{ role: "clinician" | "officer" | "admin"; region?: string }> = []): Promise<TestUser> {
  const email = `m2-verify-${stamp}-${tag}@jansanket.test`;
  const password = pw();
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: `M2 ${tag}` } });
  if (error) throw new Error(`createUser ${tag}: ${error.message}`);
  createdUsers.push(data.user.id);
  for (const r of roles) {
    const { error: e } = await service.from("user_roles").insert({ user_id: data.user.id, role: r.role, region_id: r.region ?? null });
    if (e) throw new Error(`grant ${r.role} to ${tag}: ${e.message}`);
  }
  const client = newAnon();
  const { error: se } = await client.auth.signInWithPassword({ email, password });
  if (se) throw new Error(`sign-in ${tag}: ${se.message}`);
  return { id: data.user.id, email, password, client };
}

function gatewayFor(client: SupabaseClient): ReportingGateway {
  return {
    async getCurrentUserId() {
      const { data } = await client.auth.getSession();
      return data.session?.user.id ?? null;
    },
    async getRegion(id) {
      const { data } = await client.from("regions").select("id, region_type, active").eq("id", id).maybeSingle();
      return (data as RegionInfo | null) ?? null;
    },
    async insertReport(row: HealthReportInsertRow) {
      const { data, error } = await client.from("health_reports").insert(row).select("id").single();
      return error ? { error: { code: error.code, message: error.message } } : { id: data.id as string };
    },
    async findReportId(userId, csid) {
      const { data } = await client.from("health_reports").select("id").eq("submitted_by", userId).eq("client_submission_id", csid).maybeSingle();
      return (data?.id as string | undefined) ?? null;
    },
  };
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

async function pageAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  // Preflight: M2 applied?
  const pre = await service.from("health_reports").select("id", { head: true, count: "exact" });
  if (pre.error) {
    console.error(`M2 migrations do not look applied (health_reports query failed: ${pre.error.message}).`);
    process.exit(3);
  }

  // ---------------------------------------------------------------------------------------------
  section("1. Synthetic data, determinism and the RAW -> DEIDENTIFIED -> AGGREGATED pipeline");
  const regions = await pageAll<{ id: string; region_type: string; is_synthetic: boolean }>((a, b) => service.from("regions").select("id, region_type, is_synthetic").order("id").range(a, b));
  check("54 synthetic regions loaded with the expected hierarchy", regions.length >= 54
    && ["country", "state", "district", "block", "locality"].every((t) => regions.filter((r) => r.is_synthetic && r.region_type === t).length === ({ country: 1, state: 1, district: 4, block: 16, locality: 32 } as Record<string, number>)[t]));

  const live = await pageAll<Record<string, unknown>>((a, b) =>
    service.from("health_reports").select("client_submission_id, observed_at, source_type, region_id, report_type, syndrome, symptom_codes, severity, age_band, case_count, language, free_text, synthetic_batch").eq("synthetic_batch", SYNTHETIC_BATCH).order("client_submission_id").range(a, b));
  const toLine = (r: Record<string, unknown>) => canonicalReportLine({ ...(r as unknown as SyntheticReport), observed_at: new Date(r.observed_at as string).toISOString() });
  const liveLines = live.map(toLine);
  const genLines = [...ds.reports].sort((x, y) => (x.client_submission_id < y.client_submission_id ? -1 : 1)).map(canonicalReportLine);
  check(`live synthetic reports (${live.length}) are exactly the generator output (${ds.reports.length})`, liveLines.length === genLines.length && liveLines.every((l, i) => l === genLines[i]), `live=${liveLines.length} gen=${genLines.length}`);

  const pending = await service.from("health_reports").select("id", { head: true, count: "exact" }).eq("synthetic_batch", SYNTHETIC_BATCH).in("processing_status", ["received", "validated"]);
  check("all synthetic reports were processed to 'deidentified'", pending.count === 0, String(pending.count));
  const deid = await service.from("deidentified_observations").select("id", { head: true, count: "exact" }).eq("is_synthetic", true);
  check("one deidentified observation per synthetic report", deid.count === ds.reports.length, String(deid.count));
  const aggTotal = await pageAll<{ case_count: number; suppressed: boolean; region_id: string; observed_date: string; syndrome: string; min_cell_size_applied: number }>((a, b) =>
    service.from("report_aggregates").select("case_count, suppressed, region_id, observed_date, syndrome, min_cell_size_applied").gte("observed_date", ds.startDate).lte("observed_date", ds.endDate).order("id").range(a, b));
  const synthCases = ds.reports.reduce((s, r) => s + r.case_count, 0);
  check("aggregate case counts reconcile with the raw synthetic cases", aggTotal.reduce((s, c) => s + c.case_count, 0) === synthCases, `${aggTotal.reduce((s, c) => s + c.case_count, 0)} vs ${synthCases}`);
  check("small cells are suppressed using the configured threshold, large cells are not",
    aggTotal.every((c) => c.suppressed === (c.case_count < c.min_cell_size_applied)) && aggTotal.some((c) => c.suppressed) && aggTotal.some((c) => !c.suppressed));
  // Dataset sanity (NOT a detector): planted P1 window carries clearly more diarrhoeal cases in Balianta than the weeks before.
  const p1 = ds.groundTruth.find((e) => e.id === "P1")!;
  const balDiar = (from: string, to: string) => aggTotal.filter((c) => c.region_id === BAL && c.syndrome === "acute_diarrhoeal_illness" && c.observed_date >= from && c.observed_date <= to).reduce((s, c) => s + c.case_count, 0);
  check("planted cluster P1 is visible in the aggregates (dataset sanity, not detection)", balDiar(p1.start_date, p1.end_date) / 8 > 2.5 * (balDiar("2026-07-01", "2026-07-31") / 31));

  // ---------------------------------------------------------------------------------------------
  section("2. Users and roles");
  const citizenA = await makeUser("citizenA");
  const citizenB = await makeUser("citizenB");
  const clinician = await makeUser("clinician", [{ role: "clinician", region: KHORDHA }]);
  const officerK = await makeUser("officerK", [{ role: "officer", region: KHORDHA }]);
  const officerG = await makeUser("officerG", [{ role: "officer", region: GANJAM }]);
  const officerNone = await makeUser("officerNone", [{ role: "officer" }]);
  const admin = await makeUser("admin", [{ role: "admin" }]);
  check("test users created and signed in", true);

  // ---------------------------------------------------------------------------------------------
  section("3. Ingestion service (real Supabase gateway)");
  const citizenSvc = createReportingService(gatewayFor(citizenA.client));
  const base = { observedAt: hoursAgo(2), sourceType: "citizen" as const, regionId: BAL, syndrome: "acute_diarrhoeal_illness" as const, symptomCodes: ["diarrhoea", "vomiting"] as ("diarrhoea" | "vomiting")[], severity: "moderate" as const, ageBand: "age_18_44" as const, language: "or" as const };
  const csid = randomUUID();
  const r1 = await citizenSvc.submitHealthReport({ ...base, clientSubmissionId: csid, freeText: "Loose stools, call 98765 43210 please" });
  check("valid report accepted (status received) and free text sanitised", r1.status === "accepted" && r1.processingStatus === "received" && r1.redactions === 1, JSON.stringify(r1));
  const r1id = r1.status === "accepted" ? r1.reportId : "";
  const stored = await citizenA.client.from("health_reports").select("*").eq("id", r1id).single();
  check("stored row is raw/received, owned by the submitter, with redacted text", stored.data?.privacy_level === "raw" && stored.data?.processing_status === "received" && stored.data?.submitted_by === citizenA.id && stored.data?.free_text === "Loose stools, call [number removed] please", JSON.stringify(stored.data));
  const dup = await citizenSvc.submitHealthReport({ ...base, clientSubmissionId: csid });
  check("repeating the idempotency key is a duplicate returning the original id", dup.status === "duplicate" && dup.reportId === r1id, JSON.stringify(dup));
  const rLoc = await citizenSvc.submitHealthReport({ ...base, regionId: BAL_LOC });
  check("locality-level report accepted", rLoc.status === "accepted", JSON.stringify(rLoc));
  const code = (r: Awaited<ReturnType<typeof citizenSvc.submitHealthReport>>) => (r.status === "rejected" ? r.error.code : r.status);
  check("unknown region rejected", code(await citizenSvc.submitHealthReport({ ...base, regionId: randomUUID() })) === "REGION_NOT_FOUND");
  check("district/state/country regions rejected", (await Promise.all([KHORDHA, STATE, COUNTRY].map((id) => citizenSvc.submitHealthReport({ ...base, regionId: id })))).every((r) => code(r) === "REGION_LEVEL_INVALID"));
  check("invalid severity rejected", code(await citizenSvc.submitHealthReport({ ...base, severity: "extreme" })) === "VALIDATION_FAILED");
  check("client-supplied processing_status rejected", code(await citizenSvc.submitHealthReport({ ...base, processingStatus: "deidentified" })) === "PRIVACY_VIOLATION");
  check("exact location / identifiers rejected", (await Promise.all([{ latitude: 20.2 }, { phone: "9876543210" }, { address: "x" }].map((p) => citizenSvc.submitHealthReport({ ...base, ...p })))).every((r) => code(r) === "PRIVACY_VIOLATION"));
  check("future timestamp rejected", code(await citizenSvc.submitHealthReport({ ...base, observedAt: new Date(Date.now() + 3 * 3_600_000).toISOString() })) === "VALIDATION_FAILED");
  check("too-old timestamp rejected", code(await citizenSvc.submitHealthReport({ ...base, observedAt: new Date(Date.now() - 100 * 86_400_000).toISOString() })) === "VALIDATION_FAILED");
  check("unauthenticated submission rejected", code(await createReportingService(gatewayFor(newAnon())).submitHealthReport(base)) === "UNAUTHENTICATED");
  check("citizen posing as a clinician is FORBIDDEN by RLS", code(await citizenSvc.submitHealthReport({ ...base, sourceType: "clinician" })) === "FORBIDDEN");
  const clinSvc = createReportingService(gatewayFor(clinician.client));
  const facility = await clinSvc.submitHealthReport({ ...base, sourceType: "health_facility", reportType: "aggregate_count", caseCount: 7 });
  check("clinician facility aggregate accepted inside scope (Khordha)", facility.status === "accepted", JSON.stringify(facility));
  check("clinician submission outside scope (Ganjam) is FORBIDDEN", code(await clinSvc.submitHealthReport({ ...base, sourceType: "clinician", regionId: ASK })) === "FORBIDDEN");
  check("officer without a regional scope cannot submit officer observations", code(await createReportingService(gatewayFor(officerNone.client)).submitHealthReport({ ...base, sourceType: "public_health_officer" })) === "FORBIDDEN");

  section("3b. Bypassing the service (direct REST) is still safe");
  const raw = citizenA.client;
  const rawRow = { observed_at: hoursAgo(1), source_type: "citizen", region_id: BAL, syndrome: "fever", symptom_codes: ["fever"] };
  check("invalid enum rejected by the database", !!(await raw.from("health_reports").insert({ ...rawRow, severity: "extreme" })).error);
  check("setting processing_status is denied", denied((await raw.from("health_reports").insert({ ...rawRow, processing_status: "deidentified" })).error));
  check("setting privacy_level / synthetic_batch is denied", denied((await raw.from("health_reports").insert({ ...rawRow, privacy_level: "aggregated" })).error) && denied((await raw.from("health_reports").insert({ ...rawRow, synthetic_batch: "x" })).error));
  check("submitting as another user is denied", denied((await raw.from("health_reports").insert({ ...rawRow, submitted_by: citizenB.id })).error));
  check("a GPS column does not exist", !!(await raw.from("health_reports").insert({ ...rawRow, latitude: 20.2 })).error);
  check("phone number in free text is rejected by the database", (await raw.from("health_reports").insert({ ...rawRow, free_text: "ring 9876543210" })).error?.code === "23514");
  check("coarse-region rule enforced by the database", (await raw.from("health_reports").insert({ ...rawRow, region_id: KHORDHA })).error?.code === "JS003");
  check("submitted report cannot be modified by the client", denied((await raw.from("health_reports").update({ severity: "severe" }).eq("id", r1id)).error));

  // ---------------------------------------------------------------------------------------------
  section("4. RLS: raw reports are private to their submitter");
  const seeOf = async (u: TestUser) => (await u.client.from("health_reports").select("id").in("id", [r1id, rLoc.status === "accepted" ? rLoc.reportId : ""])).data?.length ?? -1;
  check("submitter reads their own reports", (await seeOf(citizenA)) === 2);
  check("another citizen reads none", (await seeOf(citizenB)) === 0);
  check("clinician reads none", (await seeOf(clinician)) === 0);
  check("officer (in scope) reads none", (await seeOf(officerK)) === 0);
  check("admin reads none (least privilege)", (await seeOf(admin)) === 0);
  const adminAny = await admin.client.from("health_reports").select("id", { count: "exact", head: true });
  check("admin sees zero raw reports in total", adminAny.count === 0, String(adminAny.count));
  const officerAny = await officerK.client.from("health_reports").select("id", { count: "exact", head: true });
  check("officer sees zero raw reports in total, even with 4,893 synthetic reports in their region", officerAny.count === 0, String(officerAny.count));
  const anonRead = await newAnon().from("regions").select("id").limit(1);
  check("not-signed-in clients cannot read regions or reports", denied(anonRead.error) && denied((await newAnon().from("health_reports").select("id").limit(1)).error));

  section("4b. RLS: deidentified/aggregate tiers are not client-readable");
  for (const [who, u] of [["citizen", citizenA], ["clinician", clinician], ["officer", officerK], ["admin", admin]] as const) {
    check(`${who} cannot read deidentified_observations or report_aggregates directly`, denied((await u.client.from("deidentified_observations").select("id").limit(1)).error) && denied((await u.client.from("report_aggregates").select("id").limit(1)).error));
  }
  const pipelineFns: Array<[string, Record<string, unknown>]> = [["deidentify_pending_reports", { _limit: 1 }], ["refresh_report_aggregates", { _from: ds.startDate, _to: ds.startDate }], ["apply_report_retention", {}]];
  check("pipeline functions are not callable by clients (even admin)", (await Promise.all(pipelineFns.map(([fn, args]) => admin.client.rpc(fn, args)))).every((r) => denied(r.error)));

  section("4c. Regional aggregate access for officers (suppression + scope)");
  const qAgg = (u: TestUser, region: string) => u.client.rpc("get_report_aggregates", { _region_id: region, _from: ds.startDate, _to: ds.endDate });
  const k = await qAgg(officerK, KHORDHA);
  const kRows = (k.data ?? []) as Array<{ region_id: string; case_count: number | null; report_count: number | null; suppressed: boolean }>;
  check("officer reads aggregates for their district", !k.error && kRows.length > 0, k.error?.message);
  check("suppressed cells reveal no counts; others do", kRows.some((r) => r.suppressed) && kRows.filter((r) => r.suppressed).every((r) => r.case_count === null && r.report_count === null) && kRows.filter((r) => !r.suppressed).every((r) => (r.case_count ?? 0) > 0));
  const khoBlocks = new Set(geo.blocks.filter((b) => b.districtCode === "KHO").map((b) => b.region.id));
  check("officer receives only blocks inside their district", kRows.every((r) => khoBlocks.has(r.region_id)));
  check("officer is denied another district and broader regions", denied((await qAgg(officerK, GANJAM)).error) && denied((await qAgg(officerK, STATE)).error));
  check("officer scoped to Ganjam sees Ganjam only", !(await qAgg(officerG, GANJAM)).error && denied((await qAgg(officerG, KHORDHA)).error));
  check("officer with no regional scope is denied", denied((await qAgg(officerNone, KHORDHA)).error));
  check("citizen and clinician are denied", denied((await qAgg(citizenA, KHORDHA)).error) && denied((await qAgg(clinician, KHORDHA)).error));
  const adm = await qAgg(admin, STATE);
  check("admin reads state-level aggregates", !adm.error && (adm.data ?? []).length > kRows.length, adm.error?.message);
  check("over-long date ranges are rejected", !!(await officerK.client.rpc("get_report_aggregates", { _region_id: KHORDHA, _from: "2020-01-01", _to: "2026-12-31" })).error);

  // ---------------------------------------------------------------------------------------------
  section("5. Signal candidates: scoped visibility, lifecycle, audit");
  const win = (n: number) => ({ time_window_start: new Date(Date.UTC(2020, 0, 1, 0, 0, 0) + (stamp % 86_400_000) + n * 1000).toISOString(), time_window_end: new Date(Date.UTC(2020, 0, 3, 0, 0, 0) + (stamp % 86_400_000) + n * 1000).toISOString() });
  const mkSignal = async (region: string, n: number) => {
    const { data, error } = await service.from("signal_candidates").insert({ region_id: region, syndrome: "acute_diarrhoeal_illness", observed_value: 30, detection_method: "unspecified", ...win(n) }).select("id").single();
    if (error) throw new Error(`signal: ${error.message}`);
    createdSignals.push(data.id);
    return data.id as string;
  };
  const sK = await mkSignal(BAL, 1);
  const sG = await mkSignal(ASK, 2);
  const sK2 = await mkSignal(BAL, 3);
  const ids = async (u: TestUser) => ((await u.client.from("signal_candidates").select("id").in("id", [sK, sG, sK2])).data ?? []).map((r) => r.id as string);
  check("officer (Khordha) sees only Khordha signals", (await ids(officerK)).sort().join() === [sK, sK2].sort().join());
  check("officer (Ganjam) sees only the Ganjam signal", (await ids(officerG)).join() === sG);
  check("unscoped officer, citizen and clinician see none", (await ids(officerNone)).length === 0 && (await ids(citizenA)).length === 0 && (await ids(clinician)).length === 0);
  check("admin sees all", (await ids(admin)).length === 3);
  const cand = await officerK.client.from("signal_candidates").select("status, verification_status, baseline_value, signal_score").eq("id", sK).single();
  check("a new candidate is 'candidate/unverified' with no score (M2 computes nothing)", cand.data?.status === "candidate" && cand.data?.verification_status === "unverified" && cand.data?.signal_score === null && cand.data?.baseline_value === null);

  const review = (u: TestUser, id: string, status: string, ver: string) => u.client.rpc("review_signal_candidate", { _signal_id: id, _new_status: status, _verification: ver, _note: "m2 verify" });
  check("out-of-scope officer cannot review", denied((await review(officerG, sK, "under_review", "in_progress")).error));
  check("citizen/clinician cannot review", denied((await review(citizenA, sK, "under_review", "in_progress")).error) && denied((await review(clinician, sK, "under_review", "in_progress")).error));
  check("direct UPDATE of a signal is denied", denied((await officerK.client.from("signal_candidates").update({ status: "dismissed" }).eq("id", sK)).error));
  check("candidate cannot jump straight to verified", (await review(officerK, sK, "verified", "supported")).error?.code === "JS007");
  const ok1 = await review(officerK, sK, "under_review", "in_progress");
  check("in-scope officer moves candidate -> under_review", !ok1.error, ok1.error?.message);
  const ok2 = await review(officerK, sK, "verified", "supported");
  check("under_review -> verified (verification_status 'supported', not an outbreak declaration)", !ok2.error, ok2.error?.message);
  check("inconsistent status/verification is rejected", (await review(officerK, sK2, "under_review", "supported")).error?.code === "23514");
  const dismissed = await review(officerK, sK2, "dismissed", "not_supported");
  check("dismissal sets resolved_at", !dismissed.error && !!(dismissed.data as { resolved_at?: string } | null)?.resolved_at, dismissed.error?.message);
  check("terminal states cannot be reopened", (await review(officerK, sK2, "under_review", "in_progress")).error?.code === "JS007");
  const aud = await service.from("audit_log").select("action, actor_id, metadata").eq("entity", "signal_candidates").eq("entity_id", sK).eq("action", "signal.reviewed");
  check("reviews are audited with the acting officer", (aud.data ?? []).length === 2 && (aud.data ?? []).every((a) => a.actor_id === officerK.id));

  // ---------------------------------------------------------------------------------------------
  section("6. Evidence foundation");
  const ev = await admin.client.from("evidence_items").insert({ title: `M2 verify ${stamp}`, publisher: "Test", source_type: "guideline", citation: `m2-verify-${stamp}` }).select("id, created_by, trust_level").single();
  check("admin creates evidence (unreviewed)", !ev.error && ev.data?.trust_level === "unreviewed" && ev.data?.created_by === admin.id, ev.error?.message);
  if (ev.data) createdEvidence.push(ev.data.id);
  const evId = ev.data?.id as string;
  const evSees = async (u: TestUser) => ((await u.client.from("evidence_items").select("id").eq("id", evId)).data ?? []).length;
  // M4 tightened this deliberately: only CURRENT evidence is readable outside admin curation (drafts are admin-only).
  check("draft evidence hidden from citizens, officers and clinicians; visible to admin", (await evSees(citizenA)) === 0 && (await evSees(officerK)) === 0 && (await evSees(clinician)) === 0 && (await evSees(admin)) === 1);
  check("non-admins cannot create evidence", denied((await officerK.client.from("evidence_items").insert({ title: "x", publisher: "y", source_type: "other", citation: "z" })).error));
  await admin.client.from("evidence_items").update({ trust_level: "trusted", verified_at: new Date().toISOString(), source_class: "national_government_health_agency", evidence_kind: "operational_guidance", topics: ["outbreak_investigation"], geo_scope: "national", canonical_id: `m2-verify-${stamp}`, source_domain: "example.org", verification_basis: ["domain_allowlist"] }).eq("id", evId);
  await service.from("evidence_versions").insert({ evidence_item_id: evId, version_label: "1", content_hash: "b".repeat(64), is_current: true });
  const promote = await service.from("evidence_items").update({ status: "current" }).eq("id", evId);
  check("trusted, described, current evidence becomes visible to citizens and officers", !promote.error && (await evSees(citizenA)) === 1 && (await evSees(officerK)) === 1, promote.error?.message);
  await service.from("signal_evidence").insert({ signal_candidate_id: sK, evidence_item_id: evId });
  check("signal_evidence visible exactly where the signal is", ((await officerK.client.from("signal_evidence").select("signal_candidate_id").eq("signal_candidate_id", sK)).data ?? []).length === 1 && ((await officerG.client.from("signal_evidence").select("signal_candidate_id").eq("signal_candidate_id", sK)).data ?? []).length === 0);

  section("6b. report -> signal links reference aggregates, never raw reports");
  const aggRow = await service.from("report_aggregates").select("id").eq("region_id", BAL).limit(1).single();
  const link = await service.from("report_signal_links").insert({ signal_candidate_id: sK, aggregate_id: aggRow.data!.id });
  check("signal linked to an aggregate cell", !link.error, link.error?.message);
  check("links visible to in-scope officer only", ((await officerK.client.from("report_signal_links").select("id").eq("signal_candidate_id", sK)).data ?? []).length === 1 && ((await officerG.client.from("report_signal_links").select("id").eq("signal_candidate_id", sK)).data ?? []).length === 0);
  check("a link cannot target a raw report", !!(await service.from("report_signal_links").insert({ signal_candidate_id: sK, report_id: r1id } as never)).error);

  // ---------------------------------------------------------------------------------------------
  section("7. Admin: role scopes, reference data, privacy settings");
  const setScope = (caller: TestUser, target: string, role: string, region: string | null) => caller.client.rpc("admin_set_user_region_scope", { _target: target, _role: role, _region_id: region });
  check("admin narrows a clinician's scope to one block", !(await setScope(admin, clinician.id, "clinician", BAL)).error);
  const BLP = regionId(`${STATE_CODE}-KHO-BLP`);
  const clinFacility = (region: string) => clinSvc.submitHealthReport({ ...base, sourceType: "clinician", regionId: region });
  check("narrowed scope is enforced: sibling block now FORBIDDEN, scoped block accepted", code(await clinFacility(BLP)) === "FORBIDDEN" && (await clinFacility(BAL)).status === "accepted");
  await setScope(admin, clinician.id, "clinician", KHORDHA);
  check("restoring the district scope re-enables the sibling block", (await clinFacility(BLP)).status === "accepted");
  check("admin cannot scope their own role", denied((await setScope(admin, admin.id, "admin", KHORDHA)).error));
  check("non-admins cannot set scopes", denied((await setScope(officerK, officerG.id, "officer", STATE)).error));
  check("users cannot edit their own region scope directly", denied((await officerK.client.from("user_roles").update({ region_id: STATE }).eq("user_id", officerK.id).eq("role", "officer")).error));
  const ps = await officerK.client.from("privacy_settings").select("key, value_int").eq("key", "min_aggregate_cell_size").single();
  check("officers can read the (demo) suppression threshold; citizens cannot", ps.data?.value_int === 5 && ((await citizenA.client.from("privacy_settings").select("key")).data ?? []).length === 0);
  check("officers cannot change privacy settings", ((await officerK.client.from("privacy_settings").update({ value_int: 1 }).eq("key", "min_aggregate_cell_size").select()).data ?? []).length === 0);
  check("citizens read regions; inactive/other data not exposed", ((await citizenA.client.from("regions").select("id", { count: "exact", head: true })).count ?? 0) >= 54);
  const probe = async (u: TestUser, target: string, role: string) => (await u.client.rpc("has_role", { _user_id: target, _role: role })).data;
  check("users can test only their own roles: probing someone else returns false, own returns true", (await probe(citizenA, admin.id, "admin")) === false && (await probe(citizenA, officerK.id, "officer")) === false && (await probe(officerK, officerK.id, "officer")) === true && (await probe(admin, officerK.id, "officer")) === false);
  check("scope probing is also limited to the caller", (await citizenA.client.rpc("is_region_in_scope", { _user_id: officerK.id, _role: "officer", _region_id: BAL })).data === false && (await officerK.client.rpc("is_region_in_scope", { _user_id: officerK.id, _role: "officer", _region_id: BAL })).data === true);
  check("citizens cannot write regions", denied((await citizenA.client.from("regions").insert({ name: "Hack", region_type: "block", parent_region_id: KHORDHA })).error));

  section("8. Withdrawal and audit");
  const wd = await citizenSvc.submitHealthReport({ ...base, regionId: regionId(`${STATE_CODE}-PUR-NIM`), syndrome: "fever", symptomCodes: ["fever"] });
  const wdId = wd.status === "accepted" ? wd.reportId : "";
  await service.rpc("deidentify_pending_reports", { _limit: 5000 });
  const obs = await service.from("deidentified_observations").select("id").eq("report_id", wdId).single();
  check("report was deidentified by the service-side pipeline", !!obs.data, obs.error?.message);
  if (obs.data) createdObservations.push(obs.data.id);
  const del = await citizenA.client.from("health_reports").delete().eq("id", wdId).select();
  check("submitter can withdraw their own report", (del.data ?? []).length === 1);
  const after = await service.from("deidentified_observations").select("report_id").eq("id", obs.data!.id).single();
  check("deidentified row survives but is unlinked from the raw report", after.data?.report_id === null);
  const otherDel = await citizenB.client.from("health_reports").delete().eq("id", r1id).select();
  check("another user cannot delete someone else's report", (otherDel.data ?? []).length === 0);
  const audits = await service.from("audit_log").select("action").in("action", ["pipeline.deidentify", "pipeline.aggregate", "regions.insert", "role.scope_changed", "signal_candidates.insert", "evidence_items.insert", "evidence_items.update"]);
  const seen = new Set((audits.data ?? []).map((a) => a.action));
  check("pipeline, reference-data, scope and signal changes are all audited", ["pipeline.deidentify", "pipeline.aggregate", "regions.insert", "role.scope_changed", "signal_candidates.insert", "evidence_items.insert", "evidence_items.update"].every((a) => seen.has(a)), [...seen].join());
  const rlsAudit = await citizenA.client.from("audit_log").select("id").limit(1);
  check("citizens cannot read the audit log", (rlsAudit.data ?? []).length === 0);
}

async function cleanup() {
  // Reports owned by test users (submitted_by would be nulled on user deletion, so remove them first).
  // Their derived deidentified observations are removed too, so repeated runs leave no residue.
  if (createdUsers.length) {
    const { data: mine } = await service.from("health_reports").select("id").in("submitted_by", createdUsers);
    const reportIds = (mine ?? []).map((r) => r.id as string);
    if (reportIds.length) await service.from("deidentified_observations").delete().in("report_id", reportIds);
    await service.from("health_reports").delete().in("submitted_by", createdUsers);
  }
  if (createdObservations.length) await service.from("deidentified_observations").delete().in("id", createdObservations);
  // Observations derived from test reports that were deidentified but whose raw rows are now gone.
  if (createdSignals.length) await service.from("signal_candidates").delete().in("id", createdSignals);
  if (createdEvidence.length) {
    // Since M4 the evidence item has a version (on delete restrict): remove versions and chunks first.
    const vs = await service.from("evidence_versions").select("id").in("evidence_item_id", createdEvidence);
    const vIds = (vs.data ?? []).map((v) => v.id as string);
    if (vIds.length) await service.from("evidence_chunks").delete().in("version_id", vIds);
    await service.from("evidence_versions").delete().in("evidence_item_id", createdEvidence);
    const del = await service.from("evidence_items").delete().in("id", createdEvidence);
    if (del.error) {
      console.error(`CLEANUP FAILED: test evidence rows were NOT removed (${del.error.message})`);
      process.exitCode = 1;
    }
  }
  for (const id of createdUsers) await service.auth.admin.deleteUser(id).catch(() => undefined);
}

main()
  .catch((e) => check("script ran to completion", false, e instanceof Error ? e.message : String(e)))
  .finally(async () => {
    await cleanup();
    console.log(`\n${passed}/${passed + failed} checks passed. Test users, signals and evidence removed (audit rows remain by design).`);
    process.exit(failed || process.exitCode ? 1 : 0);
  });
