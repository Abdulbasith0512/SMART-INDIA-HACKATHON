// M4.2 verification against the LIVE Supabase project. Ingests the SYNTHETIC development corpus, then runs the
// retrieval engine against the REAL detector candidates already stored by M3 (so the real score_components /
// evidence JSON shapes are exercised), and checks determinism, eligibility, geography, privacy of the signal
// facts, and that row-level security can only narrow what retrieval sees. Everything it creates (evidence rows,
// snapshots, helper regions, test users) is removed at the end; detector candidates are only READ.
//
// Usage: npm run verify:m42
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { ingestCorpus } from "../src/evidence/ingest/ingest";
import { buildCorpus } from "../src/evidence/ingest/loader";
import { RETRIEVAL_CONFIG_DEV, RETRIEVAL_CONFIG_V1, retrievalConfigHash } from "../src/evidence/retrieval/config";
import { loadCorpusView } from "../src/evidence/retrieval/corpus";
import { retrieveCandidates, retrieveFromCorpus } from "../src/evidence/retrieval/retrieve";
import { loadSignalFacts } from "../src/evidence/retrieval/signal";
import { supabaseEvidenceDb } from "./lib/evidence-db";
import { CORPUS_NAME, DEFAULT_ALLOWLIST, DEFAULT_CORPUS_DIR, loadEnvFile } from "./lib/evidence-cli";

loadEnvFile();
const url = process.env.VITE_SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anonKey || !serviceKey) {
  console.error("Need VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in .env.local.");
  process.exit(2);
}
const opts = { auth: { autoRefreshToken: false, persistSession: false } };
const service = createClient(url, serviceKey, opts);
const edb = supabaseEvidenceDb(service);

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -> ${detail}` : ""}`);
}
const section = (s: string) => console.log(`\n== ${s}`);

const stamp = Date.now();
const createdUsers: string[] = [];
const createdRegions: string[] = [];
interface U { id: string; client: SupabaseClient }
async function makeUser(tag: string, role?: "officer"): Promise<U> {
  const email = `m42-verify-${stamp}-${tag}@jansanket.test`;
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

async function cleanup() {
  const items = await service.from("evidence_items").select("id").in("canonical_id", ids);
  const itemIds = (items.data ?? []).map((r) => r.id as string);
  if (itemIds.length) {
    await service.from("evidence_items").update({ supersedes_id: null }).in("id", itemIds);
    const vs = await service.from("evidence_versions").select("id").in("evidence_item_id", itemIds);
    const vIds = (vs.data ?? []).map((r) => r.id as string);
    if (vIds.length) await service.from("evidence_chunks").delete().in("version_id", vIds);
    await service.from("evidence_versions").delete().in("evidence_item_id", itemIds);
    await service.from("evidence_translations").delete().in("evidence_item_id", itemIds);
    await service.from("evidence_items").delete().in("id", itemIds);
  }
  await service.from("corpus_snapshots").delete().like("corpus_version", `${CORPUS_NAME}+%`);
}

async function main() {
  const probe = await service.from("evidence_versions").select("source_hash", { head: true, count: "exact" });
  if (probe.error) {
    console.error(`M4.1 migration does not look applied: ${probe.error.message}`);
    process.exit(3);
  }
  await cleanup();

  section("1. Prerequisites: regions and real detector candidates (read only)");
  for (const [code, name, type, parent] of [["SYN-IN", "India", "country", null], ["SYN-OD", "Odisha", "state", "SYN-IN"], ["SYN-OD-KHO", "Khordha", "district", "SYN-OD"], ["SYN-OD-GAN", "Ganjam", "district", "SYN-OD"]] as const) {
    if ((await service.from("regions").select("id").eq("administrative_code", code).maybeSingle()).data) continue;
    const parentId = parent ? (await service.from("regions").select("id").eq("administrative_code", parent).single()).data?.id ?? null : null;
    const ins = await service.from("regions").insert({ name, region_type: type, parent_region_id: parentId, administrative_code: code, is_synthetic: true }).select("id").single();
    if (ins.error) throw new Error(`region ${code}: ${ins.error.message}`);
    createdRegions.push(ins.data.id as string);
  }
  const cands = await service.from("signal_candidates").select("id, syndrome, region_id").eq("origin", "system_detector").not("episode_key", "is", null).order("id").limit(6);
  const signals = cands.data ?? [];
  check("live detector candidates exist (run `npm run detect` if not)", signals.length > 0, `${signals.length}`);

  section("2. Ingest the synthetic corpus");
  const ing = await ingestCorpus(edb, built.prepared, { corpusName: CORPUS_NAME, notes: "verify:m42 (removed afterwards)" });
  check("synthetic corpus ingested", ing.ok, ing.errors.join("; "));

  section("3. Signal facts are minimal and real shapes are handled");
  const factsList = [];
  for (const s of signals) {
    const f = await loadSignalFacts(edb, s.id as string);
    if (f) factsList.push(f);
  }
  check("every live candidate projects onto SignalFacts", factsList.length === signals.length, `${factsList.length}/${signals.length}`);
  const hasNumbers = (v: unknown): boolean => (typeof v === "number" ? true : Array.isArray(v) ? v.some(hasNumbers) : v && typeof v === "object" ? Object.values(v).some(hasNumbers) : false);
  check("facts contain no counts, scores or other numbers", factsList.every((f) => !hasNumbers(f)));
  const expl = await service.from("signal_candidates").select("explanation").in("id", signals.map((s) => s.id as string));
  check("no explanation text leaks into the facts", factsList.every((f) => (expl.data ?? []).every((e) => !JSON.stringify(f).includes(String(e.explanation).slice(0, 30)))));

  section("4. Retrieval against live data");
  const view = await loadCorpusView(edb);
  check("corpus view loaded (60 documents, text only for current ones)", view.items.length === 60 && view.items.every((i) => (i.status === "current" ? i.chunks.length > 0 : i.chunks.length === 0)));
  let nonEmpty = 0;
  for (const f of factsList) {
    const r1 = await retrieveCandidates(edb, f, RETRIEVAL_CONFIG_DEV);
    const r2 = await retrieveCandidates(edb, f, RETRIEVAL_CONFIG_DEV);
    const pure = retrieveFromCorpus(view, f, RETRIEVAL_CONFIG_DEV);
    const tag = `${f.syndrome} @ ${f.region.name}`;
    check(`${tag}: identical on a second run (JSON, ids included)`, JSON.stringify(r1) === JSON.stringify(r2));
    check(`${tag}: database path equals the pure path`, r1.resultHash === pure.resultHash);
    const cs = r1.facets.flatMap((x) => x.candidates);
    if (cs.length) nonEmpty++;
    check(`${tag}: only current, synthetic, English, trusted evidence compete`, cs.every((c) => c.metadata.status === "current" && c.metadata.isSynthetic && c.chunkLanguage === "en" && c.metadata.trustLevel !== "unreviewed"));
    check(`${tag}: no quarantined/draft/withdrawn/superseded/historical or unverified document`, cs.every((c) => !/^syn-adv-|-2022$|withdrawn|forum-post|draft|historical/.test(c.canonicalId ?? "")));
    check(`${tag}: other syndromes' specific documents are absent`, cs.every((c) => c.metadata.syndromes.length === 0 || c.metadata.syndromes.includes(f.syndrome)));
    const own = new Set([f.region.id, ...f.ancestors.map((a) => a.id)]);
    check(`${tag}: state/district evidence belongs to the signal's own region chain`, cs.every((c) => !["state", "district"].includes(c.metadata.geoMatch) || (c.metadata.geoRegionId !== null && own.has(c.metadata.geoRegionId))));
    const prod = await retrieveCandidates(edb, f, RETRIEVAL_CONFIG_V1);
    check(`${tag}: production configuration admits no synthetic evidence`, prod.facets.every((x) => x.candidates.length === 0));
  }
  check("at least one live signal retrieved candidates", nonEmpty > 0);
  console.log(`   config ${retrievalConfigHash(RETRIEVAL_CONFIG_DEV)}`);

  section("5. Row-level security can only narrow what retrieval sees");
  const officer = await makeUser("officer", "officer");
  const citizen = await makeUser("citizen");
  if (factsList.length) {
    const f = factsList[0];
    const service1 = await retrieveCandidates(edb, f, RETRIEVAL_CONFIG_DEV);
    const off = await retrieveCandidates(supabaseEvidenceDb(officer.client), f, RETRIEVAL_CONFIG_DEV);
    const cit = await retrieveCandidates(supabaseEvidenceDb(citizen.client), f, RETRIEVAL_CONFIG_DEV);
    const sig = (r: typeof off) => JSON.stringify(r.facets.map((x) => x.candidates.map((c) => [c.canonicalId, c.chunkOrdinal, c.bm25Score, c.rank])));
    check("an officer-level reader retrieves exactly what the service reader does", sig(off) === sig(service1));
    check("the officer cannot even load non-current documents", off.corpus.documents === built.manifest.counts.by_status.current, `${off.corpus.documents}`);
    check("a citizen-level reader retrieves nothing (no synthetic evidence is visible)", cit.facets.every((x) => x.candidates.length === 0) && cit.corpus.documents === 0);
  }
}

main()
  .catch((e) => {
    failed++;
    console.error("verification crashed:", e instanceof Error ? e.message : e);
  })
  .finally(async () => {
    try {
      await cleanup();
      for (const id of createdUsers) await service.auth.admin.deleteUser(id).catch(() => undefined);
      if (createdRegions.length) await service.from("regions").delete().in("id", createdRegions);
    } catch (e) {
      console.error("cleanup problem:", e instanceof Error ? e.message : e);
      failed++;
    }
    console.log(`\n${passed}/${passed + failed} checks passed. Evidence rows, snapshots, helper regions and test users removed; detector candidates untouched.`);
    process.exit(failed ? 1 : 0);
  });
