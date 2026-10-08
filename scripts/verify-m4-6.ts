// M4.6 verification. M4.6 adds NO migration and no production code: it is an offline evaluation harness over the unmodified
// pipeline. So this verifier has two parts.
//
//   A. OFFLINE INTEGRITY (always): the committed scenario set and judgments equal their deterministic generators; the frozen
//      configuration equals the code being run; the held-out split would REFUSE if any frozen value changed; every committed
//      artefact equals a fresh recomputation; every safety invariant passes; no production code, migration or M3 file differs from
//      the M4.5 commit.
//   B. LIVE (needs .env.local): against the LIVE Supabase project - the harness' in-memory pipeline selects exactly the evidence the
//      database path selects for REAL detector candidates (so the evaluation results transfer to the database path); the independent
//      oracle accepts every chunk the database path presents; the harness' stale-citation rule agrees with production's
//      verifyStoredBundle; and evaluation results stored in the M4.0 evaluation tables are admin-only. Everything it creates is
//      removed at the end; detector candidates are only READ.
//
// Usage: npm run verify:m46
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { buildBundleForSignal } from "../src/evidence/bundle/pipeline";
import { persistBundle, verifyStoredBundle } from "../src/evidence/bundle/persist";
import { IDENTITY } from "../src/evidence/bundle/testkit";
import { ingestCorpus } from "../src/evidence/ingest/ingest";
import { buildCorpus } from "../src/evidence/ingest/loader";
import { RETRIEVAL_CONFIG_DEV } from "../src/evidence/retrieval/config";
import { corpusDigest, loadCorpusView } from "../src/evidence/retrieval/corpus";
import { loadSignalFacts } from "../src/evidence/retrieval/signal";
import { retrieveAndRank } from "../src/evidence/ranking/pipeline";
import { PROMPT_VERSION } from "../src/evidence/llm/prompt";
import { FILES, authoredDifferences, readJson } from "../src/evidence/evaluation/artifacts";
import { detectStaleCitations, mutateItem } from "../src/evidence/evaluation/generation";
import { checkInvariants } from "../src/evidence/evaluation/invariants";
import { FrozenConfigMismatch, assertFrozen, frozenConfig, type FrozenHashes } from "../src/evidence/evaluation/manifest";
import { ineligibleReasons } from "../src/evidence/evaluation/oracle";
import { compareWithStored, load, produceAll, requireFrozen } from "../src/evidence/evaluation/produce";
import { runScenario } from "../src/evidence/evaluation/run";
import { regionId } from "../src/evidence/evaluation/scenarioCorpus";
import { supabaseEvidenceDb } from "./lib/evidence-db";
import { CORPUS_NAME, DEFAULT_ALLOWLIST, DEFAULT_CORPUS_DIR, loadEnvFile } from "./lib/evidence-cli";

loadEnvFile();
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -> ${detail}` : ""}`);
}
const section = (s: string) => console.log(`\n== ${s}`);
const denied = (e: { code?: string; message?: string } | null | undefined) => !!e && (e.code === "42501" || /permission denied|not authorized|row-level security/i.test(e.message ?? ""));
const countOf = async (q: PromiseLike<{ count: number | null; error: { message: string } | null }>): Promise<number> => {
  const r = await q;
  if (r.error) throw new Error(r.error.message);
  return r.count ?? 0;
};

// Values pinned by earlier milestones; asserted so a drift in any of them is caught here too.
const PINNED = {
  m3DetectorConfig: "23188f021f80bd84113165469456f72165be682522243f908cbb715793d104ba",
  corpusHash: "a66e0364a6b0c216381cfa9a6f0db846aa672f4b918587592cbcfe2ddfd497d2",
  corpusDigest: "cbd9f2ab2beb450d2a4813d7fa70e782ffc899f9f392d6c1f4c54da6d840014a",
  retrievalConfigDev: "029b517ac9986c47588303c98a594a2fc9819371f3f3f201f3e199894bccda7f",
  rankingConfig: "f288734e732142d6bbab1afeeb8acc6e5a47aee0fcd97a3ef07e6ccc44c19d5d",
  promptHash: "1188dfe92dd7965d78fb1ea4220c9283fec7ca591374be96af73fbf2988b00c1",
  referenceBundle: "347d388f9b4cd5aa07cf15720386a2dc3167281dd6f80a8c0e5137846f37f97b",
};
const M45_COMMIT = "ce7a6f9";
const UNCHANGED_SINCE_M45 = [
  "supabase/migrations", "src/detection", "src/evaluation", "data/detection", "data/evidence/corpus", "data/evidence/allowlist.json",
  "src/evidence/retrieval", "src/evidence/ranking", "src/evidence/bundle", "src/evidence/llm", "src/evidence/ingest", "src/evidence/net", "src/evidence/devcorpus", "src/evidence/vocab.ts", "src/evidence/hash.ts",
];

const stamp = Date.now();
const createdUsers: string[] = [];
const createdRegions: string[] = [];
const evalRef = `verify-m46-${stamp}`;
const opts = { auth: { autoRefreshToken: false, persistSession: false } };
const url = process.env.VITE_SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const live = !!(url && anonKey && serviceKey);
const service = live ? createClient(url!, serviceKey!, opts) : (null as unknown as SupabaseClient);
const edb = live ? supabaseEvidenceDb(service) : null;

interface U { id: string; client: SupabaseClient }
async function makeUser(tag: string, role?: "officer" | "admin"): Promise<U> {
  const email = `m46-verify-${stamp}-${tag}@jansanket.test`;
  const password = randomBytes(12).toString("base64url") + "aA1!";
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser ${tag}: ${error.message}`);
  createdUsers.push(data.user.id);
  if (role) {
    const r = await service.from("user_roles").insert({ user_id: data.user.id, role, region_id: null });
    if (r.error) throw new Error(r.error.message);
  }
  const client = createClient(url!, anonKey!, opts);
  const s = await client.auth.signInWithPassword({ email, password });
  if (s.error) throw new Error(s.error.message);
  return { id: data.user.id, client };
}

const built = buildCorpus(DEFAULT_CORPUS_DIR, DEFAULT_ALLOWLIST, CORPUS_NAME);
const ids = built.prepared.map((p) => p.doc.canonical_id);

/** Remove everything this script (or an interrupted earlier run of it) created. Order matters: children before parents. */
async function cleanup() {
  await service.from("evidence_evaluation_runs").delete().like("scenario_set_ref", "verify-m46-%");
  const snaps = ((await service.from("corpus_snapshots").select("id").like("corpus_version", `${CORPUS_NAME}+%`)).data ?? []).map((r) => r.id as string);
  if (snaps.length) {
    const runIds = ((await service.from("retrieval_runs").select("id").in("corpus_snapshot_id", snaps)).data ?? []).map((r) => r.id as string);
    if (runIds.length) {
      const bundleIds = ((await service.from("evidence_bundles").select("id").in("retrieval_run_id", runIds)).data ?? []).map((r) => r.id as string);
      if (bundleIds.length) {
        const exIds = ((await service.from("generated_explanations").select("id").in("bundle_id", bundleIds)).data ?? []).map((r) => r.id as string);
        if (exIds.length) {
          await service.from("explanation_citations").delete().in("explanation_id", exIds);
          await service.from("generated_explanation_raw").delete().in("explanation_id", exIds);
        }
        await service.from("generated_explanations").delete().in("bundle_id", bundleIds);
        await service.from("evidence_bundle_items").delete().in("bundle_id", bundleIds);
        await service.from("evidence_bundles").delete().in("id", bundleIds);
      }
      await service.from("retrieval_runs").delete().in("id", runIds);
    }
  }
  const items = await service.from("evidence_items").select("id").in("canonical_id", ids);
  const itemIds = (items.data ?? []).map((r) => r.id as string);
  if (itemIds.length) {
    await service.from("signal_evidence").delete().in("evidence_item_id", itemIds);
    await service.from("evidence_items").update({ supersedes_id: null, question_key: null, position: null }).in("id", itemIds);
    const vs = await service.from("evidence_versions").select("id").in("evidence_item_id", itemIds);
    const vIds = (vs.data ?? []).map((r) => r.id as string);
    if (vIds.length) await service.from("evidence_chunks").delete().in("version_id", vIds);
    await service.from("evidence_versions").delete().in("evidence_item_id", itemIds);
    await service.from("evidence_translations").delete().in("evidence_item_id", itemIds);
    await service.from("evidence_items").delete().in("id", itemIds);
  }
  await service.from("corpus_snapshots").delete().like("corpus_version", `${CORPUS_NAME}+%`);
}

async function offline() {
  section("A1. Authored inputs, freeze and refusal");
  const l = load(process.cwd());
  check("scenario-set.json and judgments.json equal the deterministic generators' output (nothing hand-edited)", authoredDifferences(l.base, l.root).length === 0, authoredDifferences(l.base, l.root).join("; "));
  let frozenOk = true;
  try {
    requireFrozen(l);
  } catch (e) {
    frozenOk = false;
    console.log(String(e));
  }
  check("the frozen configuration equals the code and data being evaluated", frozenOk);
  const refused: string[] = [];
  for (const k of Object.keys(l.hashes) as Array<keyof FrozenHashes>) {
    try {
      assertFrozen(frozenConfig(l.hashes), { ...l.hashes, [k]: `${l.hashes[k]}!` });
    } catch (e) {
      if (e instanceof FrozenConfigMismatch && e.differences.length === 1 && e.differences[0].field === k) refused.push(k);
    }
  }
  check(`the held-out split REFUSES to run if any one of the ${Object.keys(l.hashes).length} frozen values changes (tested for each)`, refused.length === Object.keys(l.hashes).length, `${refused.length} refused`);
  const h = l.hashes;
  check("M3 detector, corpus, retrieval (dev), ranking and generation-prompt hashes are the pinned values", h.m3_detector_config_hash === PINNED.m3DetectorConfig && h.corpus_hash === PINNED.corpusHash && h.retrieval_config_hash_dev === PINNED.retrievalConfigDev && h.ranking_config_hash === PINNED.rankingConfig && h.prompt_hash === PINNED.promptHash && h.prompt_version === PROMPT_VERSION,
    JSON.stringify({ m3: h.m3_detector_config_hash === PINNED.m3DetectorConfig, corpus: h.corpus_hash === PINNED.corpusHash, ret: h.retrieval_config_hash_dev === PINNED.retrievalConfigDev, rank: h.ranking_config_hash === PINNED.rankingConfig, prompt: h.prompt_hash === PINNED.promptHash }));
  check("the reference scenario reproduces the M4.4 golden bundle hash", runScenario(l.base, l.authored.set.scenarios.find((s) => s.id === "E01")!, IDENTITY).bundle.bundle_hash === PINNED.referenceBundle);

  section("A2. Recomputation equals every committed artefact; invariants; adversarial");
  const p = await produceAll(l);
  const differ = compareWithStored(l, p);
  check("dev, test, adversarial, metrics, judge, review (JSON + CSV) and manifest equal a fresh recomputation", differ.length === 0, differ.join(", "));
  check("the recomputed split and adversarial artefacts are identical to the stored ones (determinism rerun)", p.manifest.determinism.rerun_identical === true);
  const inv = checkInvariants({ results: [...p.dev.scenarios, ...p.test.scenarios], adversarial: p.adversarial.summary });
  check(`all ${inv.length} safety / integrity invariants pass and none is left unexercised`, inv.every((i) => i.status === "pass"), inv.filter((i) => i.status !== "pass").map((i) => `${i.id}:${i.status}`).join(", "));
  check("zero adversarial outputs accepted, and every fixture challenged a defence", p.adversarial.summary.unsafe_accepted === 0 && p.adversarial.summary.fixtures_never_challenged.length === 0, `${p.adversarial.summary.unsafe_accepted}`);
  check("correct abstention and no false confidence in every no-evidence scenario of both splits", inv.filter((i) => i.id === "S08" || i.id === "S09").every((i) => i.status === "pass" && i.units > 0));
  check("the model judge is reported as not validated and human evaluation as pending", p.judge.status === "not_validated" && p.judge.reportable === false && p.manifest.human_evaluation.status === "pending");
  check("the manifest records provider mock-1, no live provider run, and the pinned prompt", p.manifest.generation.provider === "mock" && p.manifest.generation.live_provider_run === false && p.manifest.generation.prompt_hash === PINNED.promptHash);

  section("A3. Nothing in production, the migrations or M3 was changed by M4.6");
  let gitOk = true;
  try {
    execFileSync("git", ["cat-file", "-e", `${M45_COMMIT}^{commit}`], { stdio: "ignore" });
  } catch {
    gitOk = false;
  }
  if (!gitOk) console.log(`SKIPPED  git history does not contain ${M45_COMMIT}; the byte-identity check needs the repository history`);
  else {
    const out = execFileSync("git", ["diff", "--stat", M45_COMMIT, "--", ...UNCHANGED_SINCE_M45], { encoding: "utf8" }).trim();
    check(`migrations, M1-M3, the corpus and every production evidence module are byte-identical to the M4.5 commit (${M45_COMMIT})`, out === "", out);
    const added = execFileSync("git", ["diff", "--name-status", M45_COMMIT, "--", "supabase/migrations"], { encoding: "utf8" }).trim();
    check("no migration was added, changed or removed", added === "");
  }
  return l;
}

async function liveChecks(l: ReturnType<typeof load>) {
  const db = edb!;
  const probe = await service.from("evidence_bundles").select("id", { head: true, count: "exact" });
  if (probe.error) {
    console.error(`M4.0 tables do not look applied: ${probe.error.message}`);
    process.exit(3);
  }
  await cleanup();
  const foreignActive = ((await service.from("corpus_snapshots").select("id, corpus_version").eq("is_active", true)).data ?? []);
  if (foreignActive.length) {
    console.error(`An active corpus snapshot that is not this script's exists (${foreignActive.map((s) => s.corpus_version).join(", ")}); refusing to change which snapshot is active.`);
    process.exit(3);
  }

  section("B1. Prerequisites: regions, real detector candidates (read only), synthetic corpus with an active snapshot");
  for (const [code, name, type, parent] of [["SYN-IN", "India", "country", null], ["SYN-OD", "Odisha", "state", "SYN-IN"], ["SYN-OD-KHO", "Khordha", "district", "SYN-OD"], ["SYN-OD-GAN", "Ganjam", "district", "SYN-OD"]] as const) {
    if ((await service.from("regions").select("id").eq("administrative_code", code).maybeSingle()).data) continue;
    const parentId = parent ? (await service.from("regions").select("id").eq("administrative_code", parent).single()).data?.id ?? null : null;
    const ins = await service.from("regions").insert({ name, region_type: type, parent_region_id: parentId, administrative_code: code, is_synthetic: true }).select("id").single();
    if (ins.error) throw new Error(`region ${code}: ${ins.error.message}`);
    createdRegions.push(ins.data.id as string);
  }
  const cands = await service.from("signal_candidates").select("id").eq("origin", "system_detector").not("episode_key", "is", null).order("id").limit(4);
  const signals = (cands.data ?? []).map((c) => c.id as string);
  check("live detector candidates exist (run `npm run detect` if not)", signals.length > 0, `${signals.length}`);
  const ing = await ingestCorpus(db, built.prepared, { corpusName: CORPUS_NAME, notes: "verify:m46 (removed afterwards)", activate: true });
  check("synthetic corpus ingested and its snapshot activated", ing.ok && !!ing.snapshot?.activated, ing.errors.join("; "));
  const view = await loadCorpusView(db);
  const hview = await loadCorpusView(db, { textStatuses: ["superseded", "historical"] });
  check("the database corpus has exactly the content of the committed development corpus the harness evaluates (content digest)", corpusDigest(view) === PINNED.corpusDigest && corpusDigest(l.base.view) === PINNED.corpusDigest);

  section("B2. The harness' pipeline selects what the database path selects, for REAL detector candidates");
  const stored: Array<{ signal: string; bundleId: string; bundle: Awaited<ReturnType<typeof buildBundleForSignal>> }> = [];
  for (const id of signals) {
    const facts = (await loadSignalFacts(db, id))!;
    const tag = `${facts.syndrome} @ ${facts.region.name}`;
    const bundle = (await buildBundleForSignal(db, id, RETRIEVAL_CONFIG_DEV, undefined, { retrievedAt: "2026-01-01T00:00:00.000Z" }))!;
    // the live signal carries database region ids; the harness corpus uses deterministic ids derived from the SAME administrative codes
    const ids = [facts.region.id, ...facts.ancestors.map((a) => a.id), ...facts.involved_blocks.map((b) => b.id)];
    const codes = new Map(((await service.from("regions").select("id, administrative_code").in("id", ids)).data ?? []).map((r) => [r.id as string, r.administrative_code as string]));
    const toHarness = (rid: string): string => (codes.has(rid) ? regionId(codes.get(rid) as string) : rid);
    const harnessFacts = { ...facts, region: { ...facts.region, id: toHarness(facts.region.id) }, ancestors: facts.ancestors.map((a) => ({ ...a, id: toHarness(a.id) })), involved_blocks: facts.involved_blocks.map((b) => ({ ...b, id: toHarness(b.id) })) };
    check(`${tag}: every region of the live signal has an administrative code to translate by`, ids.every((rid) => codes.has(rid)));
    const mem = retrieveAndRank({ facts: harnessFacts, view: l.base.view, historicalView: l.base.historicalView, retrievalConfig: RETRIEVAL_CONFIG_DEV });
    const dbSel = bundle.facets.map((f) => f.items.map((i) => `${i.canonical_id ?? i.evidence_item_id}#${i.chunk_ordinal}`));
    const memSel = mem.facets.map((f) => f.selected.map((c) => `${c.canonicalId ?? c.evidenceItemId}#${c.chunkOrdinal}`));
    check(`${tag}: the in-memory harness pipeline and the database path select the same chunks in the same order, facet by facet`, JSON.stringify(dbSel) === JSON.stringify(memSel), `${JSON.stringify(dbSel).slice(0, 120)} vs ${JSON.stringify(memSel).slice(0, 120)}`);
    check(`${tag}: the same gaps are stated`, JSON.stringify(bundle.gaps.map((g) => g.code).sort()) === JSON.stringify(mem.gaps.map((g) => g.code).sort()));
    check(`${tag}: pinned configuration and corpus content`, bundle.config.retrieval_config_hash === PINNED.retrievalConfigDev && bundle.config.ranking_config_hash === PINNED.rankingConfig && bundle.corpus.corpus_digest === PINNED.corpusDigest);

    // the independent oracle, applied to what the DATABASE path presents
    const byId = new Map(view.items.map((i) => [i.id, i]));
    const chain = [{ id: facts.region.id, level: facts.region.level as string }, ...facts.ancestors.map((a) => ({ id: a.id, level: a.level as string }))];
    const violations = bundle.citations.filter((c) => c.section === "main").flatMap((c) => {
      const item = byId.get(c.evidence_item_id);
      return item ? ineligibleReasons(item, { asOf: bundle.config.as_of_date, chain, profile: "dev" }).map((r) => `${c.citation_id}:${r}`) : [`${c.citation_id}:not in corpus view`];
    });
    check(`${tag}: the independent safety oracle finds nothing wrong with what the database path presents (${bundle.citations.filter((c) => c.section === "main").length} cited chunks)`, violations.length === 0, violations.join(", "));
    const p = await persistBundle(db, bundle);
    stored.push({ signal: id, bundleId: p.bundleId, bundle });
  }

  section("B3. The harness' stale-citation rule agrees with production's verifyStoredBundle");
  const target = stored.find((s) => s.bundle!.citations.some((c) => c.section === "main"));
  check("a live signal with cited evidence exists", !!target);
  if (target) {
    const bundle = target.bundle!;
    const doc = bundle.citations.find((c) => c.section === "main")!.evidence_item_id;
    const cited = bundle.citations.filter((c) => c.section === "main" && c.evidence_item_id === doc).map((c) => c.citation_id).sort();
    const before = await verifyStoredBundle(db, target.bundleId);
    check("before any change production reports the stored bundle intact and nothing stale; the harness agrees", before.ok && before.stale.length === 0 && detectStaleCitations(bundle, view).length === 0, before.problems.join("; "));
    const predicted = detectStaleCitations(bundle, mutateItem(view, doc, "superseded")).sort();
    const upd = await service.from("evidence_items").update({ status: "superseded" }).eq("id", doc).select("id");
    check("the cited document is marked superseded in the database", !upd.error && (upd.data ?? []).length === 1, upd.error?.message);
    const after = await verifyStoredBundle(db, target.bundleId);
    const production = after.stale.map((s) => s.citation_id).sort();
    check(`production flags exactly the ${cited.length} citation(s) of that document: ${production.join(", ")}`, JSON.stringify(production) === JSON.stringify(cited), JSON.stringify({ production, cited }));
    check("the harness' stale-citation rule predicted exactly the same citations before the change was made", JSON.stringify(predicted) === JSON.stringify(production), JSON.stringify({ predicted, production }));
    check("a stale citation is not an integrity failure of the stored bundle (it still verifies)", after.ok, after.problems.join("; "));
  }

  section("B4. Evaluation results in the M4.0 evaluation tables are admin-only");
  const metrics = readJson<{ dev: unknown; config: { corpus_hash: string; retrieval_config_hash_dev: string } }>(l.root, FILES.metrics);
  const run = await service.from("evidence_evaluation_runs").insert({
    kind: "dev", retrieval_config_hash: metrics.config.retrieval_config_hash_dev, prompt_version: PROMPT_VERSION, corpus_hash: metrics.config.corpus_hash, scenario_set_ref: evalRef, n_scenarios: 36, metrics: { summary: metrics.dev },
  }).select("id").single();
  check("a service-role write of an M4.6 result summary succeeds", !run.error && !!run.data, run.error?.message);
  const runId = run.data?.id as string | undefined;
  if (runId) {
    const res = await service.from("evidence_evaluation_results").insert([{ run_id: runId, scenario_id: "E01", passed: true, metrics: { note: "verify:m46" } }]).select("id");
    check("and of a per-scenario result", !res.error && (res.data ?? []).length === 1, res.error?.message);
    const admin = await makeUser("admin", "admin");
    const officer = await makeUser("officer", "officer");
    const citizen = await makeUser("citizen");
    const seen = async (u: U) => [await countOf(u.client.from("evidence_evaluation_runs").select("id", { head: true, count: "exact" }).eq("id", runId)), await countOf(u.client.from("evidence_evaluation_results").select("id", { head: true, count: "exact" }).eq("run_id", runId))];
    check("an admin reads the run and its result", JSON.stringify(await seen(admin)) === JSON.stringify([1, 1]));
    check("an officer sees neither", JSON.stringify(await seen(officer)) === JSON.stringify([0, 0]));
    check("a citizen sees neither", JSON.stringify(await seen(citizen)) === JSON.stringify([0, 0]));
    let blocked = true;
    for (const [label, u] of [["admin", admin], ["officer", officer], ["citizen", citizen]] as const) {
      const tries = [
        await u.client.from("evidence_evaluation_runs").insert({ kind: "test", retrieval_config_hash: "9".repeat(64), corpus_hash: "9".repeat(64), scenario_set_ref: `${evalRef}-x`, n_scenarios: 1, metrics: {} }).select("id"),
        await u.client.from("evidence_evaluation_runs").update({ n_scenarios: 0 }).eq("id", runId).select("id"),
        await u.client.from("evidence_evaluation_runs").delete().eq("id", runId).select("id"),
        await u.client.from("evidence_evaluation_results").insert({ run_id: runId, scenario_id: "X", passed: false }).select("id"),
      ];
      const ok = tries.every((t) => denied(t.error) || (t.data ?? []).length === 0);
      if (!ok) blocked = false;
      check(`${label}: no write to an evaluation table succeeds`, ok, JSON.stringify(tries.map((t) => [t.error?.code, (t.data ?? []).length])));
    }
    check("the stored run is intact after all of those attempts", blocked && (await countOf(service.from("evidence_evaluation_runs").select("id", { head: true, count: "exact" }).eq("id", runId))) === 1);
  }
}

async function main() {
  const l = await offline();
  if (!live) {
    console.log("\nSKIPPED  live checks: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are not all set in .env.local.");
    return;
  }
  await liveChecks(l);
}

main()
  .catch((e) => {
    failed++;
    console.error("verification crashed:", e instanceof Error ? e.message : e);
  })
  .finally(async () => {
    if (live) {
      try {
        await cleanup();
        for (const id of createdUsers) {
          await service.from("user_roles").delete().eq("user_id", id);
          await service.auth.admin.deleteUser(id).catch(() => undefined);
        }
        if (createdRegions.length) await service.from("regions").delete().in("id", createdRegions);
        const left = {
          evidence_items: await countOf(service.from("evidence_items").select("id", { head: true, count: "exact" }).in("canonical_id", ids)),
          snapshots: await countOf(service.from("corpus_snapshots").select("id", { head: true, count: "exact" }).like("corpus_version", `${CORPUS_NAME}+%`)),
          bundles_total: await countOf(service.from("evidence_bundles").select("id", { head: true, count: "exact" })),
          runs_total: await countOf(service.from("retrieval_runs").select("id", { head: true, count: "exact" })),
          explanations_total: await countOf(service.from("generated_explanations").select("id", { head: true, count: "exact" })),
          mirror_total: await countOf(service.from("signal_evidence").select("signal_candidate_id", { head: true, count: "exact" })),
          evaluation_runs: await countOf(service.from("evidence_evaluation_runs").select("id", { head: true, count: "exact" })),
          evaluation_results: await countOf(service.from("evidence_evaluation_results").select("id", { head: true, count: "exact" })),
        };
        const clean = Object.values(left).every((n) => n === 0);
        console.log(`\nleftover check: ${JSON.stringify(left)}`);
        if (!clean) {
          failed++;
          console.error("cleanup left rows behind");
        }
      } catch (e) {
        console.error("cleanup problem:", e instanceof Error ? e.message : e);
        failed++;
      }
    }
    console.log(`\n${passed}/${passed + failed} checks passed.${live ? " Evidence rows, bundles, evaluation rows, helper regions and test users removed; detector candidates untouched." : ""}`);
    process.exit(failed ? 1 : 0);
  });
