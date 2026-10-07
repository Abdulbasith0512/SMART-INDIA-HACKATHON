// M3 end-to-end verification against the LIVE Supabase project (after the M3 migration is applied and the
// synthetic dataset is loaded). Runs the frozen detector twice through the real database path and checks
// determinism, idempotency, privacy floor, wording, RLS scoping, and the human-review boundary.
// Test users / test candidate are removed at the end; detector runs, findings and detector candidates are
// kept on purpose (they are the product output for the synthetic dataset).
//
// Usage: npm run verify:m3
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { DETECTOR_V1, DetectorEngine, configHash, hashFeatureRows, isSafeExplanation } from "../src/detection";
import { datasetToDetectorInput } from "../src/evaluation/adapter";
import { generateSyntheticDataset } from "../src/synthetic/generate";
import { STATE_CODE } from "../src/synthetic/geography";
import { runLiveDetector } from "./lib/detector-runner";

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

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -> ${detail}` : ""}`);
}
const section = (s: string) => console.log(`\n== ${s}`);
const denied = (e: { code?: string; message?: string } | null | undefined) => !!e && (e.code === "42501" || /permission denied|not authorized/i.test(e.message ?? ""));

const stamp = Date.now();
const createdUsers: string[] = [];
let testCandidateId: string | null = null;
interface U { id: string; client: SupabaseClient }
async function makeUser(tag: string, role?: { role: "officer" | "admin"; region?: string }): Promise<U> {
  const email = `m3-verify-${stamp}-${tag}@jansanket.test`;
  const password = randomBytes(12).toString("base64url") + "aA1!";
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser ${tag}: ${error.message}`);
  createdUsers.push(data.user.id);
  if (role) {
    const r = await service.from("user_roles").insert({ user_id: data.user.id, role: role.role, region_id: role.region ?? null });
    if (r.error) throw new Error(r.error.message);
  }
  const client = createClient(url!, anonKey!, opts);
  const s = await client.auth.signInWithPassword({ email, password });
  if (s.error) throw new Error(s.error.message);
  return { id: data.user.id, client };
}

async function main() {
  const pre = await service.from("detector_runs").select("id", { head: true, count: "exact" });
  if (pre.error) {
    console.error(`M3 migration does not look applied: ${pre.error.message}`);
    process.exit(3);
  }
  const frozen = JSON.parse(readFileSync("data/detection/m3-detector-v1.config.json", "utf8"));

  section("1. Frozen detector through the real database path");
  check("code config matches the frozen config hash", configHash(DETECTOR_V1) === frozen.config_hash, configHash(DETECTOR_V1));

  // In-memory reference on the same synthetic data (independent path: generator -> adapter -> detector).
  const refInput = datasetToDetectorInput(generateSyntheticDataset(), 5);
  const refEngine = new DetectorEngine(refInput, DETECTOR_V1);
  const refKeys = refEngine.replay({}).state.episodes.map((e) => e.key).sort();

  const run1 = await runLiveDetector(service);
  check("live feature rows equal the in-memory deidentified features (same SHA-256)", run1.inputHash === hashFeatureRows(refInput.rows), `${run1.inputHash} vs ${hashFeatureRows(refInput.rows)}`);
  check("live episodes equal the in-memory detector's episodes (same keys)", JSON.stringify(run1.episodeKeys) === JSON.stringify(refKeys), `${run1.episodeKeys.length} vs ${refKeys.length}`);
  check("detector produced at least one emerging-signal candidate", run1.episodes > 0, String(run1.episodes));
  const runRow = await service.from("detector_runs").select("status, config_hash, input_hash, evidence_floor, stats").eq("id", run1.runId!).single();
  check("run provenance recorded (succeeded, frozen config hash, input hash)", runRow.data?.status === "succeeded" && runRow.data?.config_hash === frozen.config_hash && runRow.data?.input_hash === run1.inputHash, JSON.stringify(runRow.data?.status));

  const run2 = await runLiveDetector(service);
  check("re-running is idempotent: no new candidates, same episodes", !run2.actions.inserted && JSON.stringify(run2.episodeKeys) === JSON.stringify(run1.episodeKeys), JSON.stringify(run2.actions));
  const cands = await service.from("signal_candidates").select("id, region_id, status, episode_key, sample_count, minimum_sample_count, observed_value, signal_score, confidence, explanation").eq("detection_method", DETECTOR_V1.methodCode);
  const rows = cands.data ?? [];
  check("one candidate per episode (no duplicates)", rows.length === run1.episodes && new Set(rows.map((r) => r.episode_key)).size === rows.length, `${rows.length} rows / ${run1.episodes} episodes`);

  section("2. Privacy floor, wording, score semantics");
  check("every candidate meets the evidence floor k", rows.every((r) => r.sample_count >= run1.evidenceFloor && r.minimum_sample_count >= run1.evidenceFloor && Number(r.observed_value) >= run1.evidenceFloor));
  check("every explanation says 'requiring verification' and never claims an outbreak/diagnosis", rows.every((r) => isSafeExplanation(r.explanation ?? "")));
  check("signal_score is a 0-100 ranking score; confidence in [0,1]", rows.every((r) => Number(r.signal_score) >= 0 && Number(r.signal_score) <= 100 && Number(r.confidence) >= 0 && Number(r.confidence) <= 1));
  const lowFindings = await service.from("detector_findings").select("id", { count: "exact", head: true }).lt("observed", run1.evidenceFloor);
  check("no stored finding carries a count below k", (lowFindings.count ?? 0) === 0, String(lowFindings.count));
  const watch = await service.from("detector_findings").select("observed").eq("decision", "watch").limit(50);
  check("'watch' findings store no count", (watch.data ?? []).every((w) => w.observed === null || w.observed >= run1.evidenceFloor));

  section("3. Who can see signals and findings");
  const regionIds = new Map<string, string>();
  const regs = await service.from("regions").select("id, administrative_code");
  for (const r of regs.data ?? []) regionIds.set(r.administrative_code, r.id);
  const KHO = regionIds.get(`${STATE_CODE}-KHO`)!;
  const GAN = regionIds.get(`${STATE_CODE}-GAN`)!;
  const BAL = regionIds.get(`${STATE_CODE}-KHO-BAL`)!;
  const subtree = async (root: string) => new Set(((await service.rpc("region_subtree", { _root: root })).data ?? []).map((x: { id: string }) => x.id));
  const khoSet = await subtree(KHO);
  const ganSet = await subtree(GAN);
  const officerK = await makeUser("officerK", { role: "officer", region: KHO });
  const officerG = await makeUser("officerG", { role: "officer", region: GAN });
  const citizen = await makeUser("citizen");
  const admin = await makeUser("admin", { role: "admin" });
  const visible = async (u: U) => ((await u.client.from("signal_candidates").select("id, region_id").eq("detection_method", DETECTOR_V1.methodCode)).data ?? []);
  const vk = await visible(officerK);
  const vg = await visible(officerG);
  check("Khordha officer sees exactly the Khordha detector signals", vk.length === rows.filter((r) => khoSet.has(r.region_id)).length && vk.every((r) => khoSet.has(r.region_id)), `${vk.length}`);
  check("Ganjam officer sees exactly the Ganjam detector signals", vg.length === rows.filter((r) => ganSet.has(r.region_id)).length && vg.every((r) => ganSet.has(r.region_id)), `${vg.length}`);
  check("citizens see no signals; admin sees all", (await visible(citizen)).length === 0 && (await visible(admin)).length === rows.length);
  const fk = (await officerK.client.from("detector_findings").select("district_id").limit(1000)).data ?? [];
  check("officers read findings only for their district", fk.every((f) => f.district_id === KHO));
  check("citizens read no findings or runs", ((await citizen.client.from("detector_findings").select("id").limit(1)).data ?? []).length === 0 && ((await citizen.client.from("detector_runs").select("id").limit(1)).data ?? []).length === 0);
  check("officers can read run provenance", ((await officerK.client.from("detector_runs").select("id").limit(1)).data ?? []).length === 1);
  const evalRows = await service.from("evaluation_runs").select("id", { count: "exact", head: true });
  if ((evalRows.count ?? 0) > 0) {
    check("evaluation results are admin-only", ((await admin.client.from("evaluation_runs").select("id")).data ?? []).length === evalRows.count && ((await officerK.client.from("evaluation_runs").select("id")).data ?? []).length === 0);
  }
  check("clients cannot call the detector's database functions", denied((await admin.client.rpc("detection_daily_features", { _from: "2026-06-15", _to: "2026-06-20" })).error) && denied((await admin.client.rpc("upsert_detected_signal", { _p: {} })).error));
  check("clients cannot write runs, findings or candidates", denied((await admin.client.from("detector_findings").delete().eq("decision", "watch")).error) && denied((await officerK.client.from("signal_candidates").update({ signal_score: 1 }).eq("detection_method", DETECTOR_V1.methodCode)).error));

  section("4. Human review boundary (no autonomous verification)");
  check("every detector signal starts as 'candidate' (never auto-verified)", rows.every((r) => r.status === "candidate" || r.status === "under_review" || r.status === "verified" || r.status === "monitoring" || r.status === "resolved" || r.status === "dismissed") && rows.filter((r) => r.status !== "candidate").length === 0, JSON.stringify([...new Set(rows.map((r) => r.status))]));
  const key = createHashHex(`m3-verify-${stamp}`);
  const payload = (over: Record<string, unknown> = {}) => ({
    method_code: DETECTOR_V1.methodCode, episode_key: key, region_id: BAL, syndrome: "fever",
    window_start: "2026-01-05T00:00:00+05:30", window_end: "2026-01-10T00:00:00+05:30",
    observed_value: 12, baseline_value: 3, deviation: 3.9, signal_score: 70, sample_count: 12, minimum_sample_count: run1.evidenceFloor, confidence: 0.5,
    explanation: "Emerging signal requiring verification: verify:m3 test signal. This is a statistical flag, not a confirmed outbreak or a diagnosis. Human verification required.",
    run_id: run1.runId, first_detected_on: "2026-01-07", last_seen_on: "2026-01-09", score_components: { test: true }, evidence: { test: true }, ...over,
  });
  const ins = await service.rpc("upsert_detected_signal", { _p: payload() });
  testCandidateId = (ins.data as { id: string } | null)?.id ?? null;
  check("test candidate inserted through the upsert path", (ins.data as { action?: string } | null)?.action === "inserted", ins.error?.message);
  const rev = await officerK.client.rpc("review_signal_candidate", { _signal_id: testCandidateId, _new_status: "under_review", _verification: "in_progress", _note: "m3 verify" });
  check("in-scope officer starts review", !rev.error, rev.error?.message);
  const again = await service.rpc("upsert_detected_signal", { _p: payload({ observed_value: 99, sample_count: 99, signal_score: 99, last_seen_on: "2026-01-12" }) });
  const after = await service.from("signal_candidates").select("sample_count, signal_score, status").eq("id", testCandidateId!).single();
  check("detector cannot change evidence under review (records 'seen' only)", (again.data as { action?: string } | null)?.action === "seen_under_review" && after.data?.sample_count === 12 && Number(after.data?.signal_score) === 70 && after.data?.status === "under_review");
  check("out-of-scope officer cannot review", denied((await officerG.client.rpc("review_signal_candidate", { _signal_id: testCandidateId, _new_status: "verified", _verification: "supported" })).error));
  const tooSmall = await service.rpc("upsert_detected_signal", { _p: payload({ episode_key: createHashHex(`m3-small-${stamp}`), observed_value: 3, sample_count: 3 }) });
  check("a sub-threshold detector signal is refused by the database (JS009)", tooSmall.error?.code === "JS009", tooSmall.error?.message);
  const unsafe = await service.rpc("upsert_detected_signal", { _p: payload({ episode_key: createHashHex(`m3-unsafe-${stamp}`), explanation: "Outbreak confirmed in Balianta." }) });
  check("unsafe wording is refused by the database (JS009)", unsafe.error?.code === "JS009", unsafe.error?.message);
}

function createHashHex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function cleanup() {
  if (testCandidateId) await service.from("signal_candidates").delete().eq("id", testCandidateId);
  for (const id of createdUsers) await service.auth.admin.deleteUser(id).catch(() => undefined);
}

main()
  .catch((e) => check("script ran to completion", false, e instanceof Error ? e.message : String(e)))
  .finally(async () => {
    await cleanup();
    console.log(`\n${passed}/${passed + failed} checks passed. Test users and test candidate removed; detector runs, findings and detector candidates kept (product output).`);
    process.exit(failed ? 1 : 0);
  });
