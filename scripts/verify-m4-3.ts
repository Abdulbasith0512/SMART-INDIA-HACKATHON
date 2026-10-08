// M4.3 verification against the LIVE Supabase project (after migration 20261007080000_m4_3_conflict_metadata is
// applied). Ingests the SYNTHETIC development corpus, ranks the REAL detector candidates already stored by M3, and
// checks the formula, the policy tables, dedup, diversity, geography, determinism, curator-tag conflicts, gaps and
// row-level security. Everything it creates (evidence rows, snapshots, helper regions, tags, test users) is removed
// at the end; detector candidates are only READ.
//
// Usage: npm run verify:m43
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { ingestCorpus } from "../src/evidence/ingest/ingest";
import { buildCorpus } from "../src/evidence/ingest/loader";
import { RETRIEVAL_CONFIG_DEV, RETRIEVAL_CONFIG_V1 } from "../src/evidence/retrieval/config";
import { loadCorpusView } from "../src/evidence/retrieval/corpus";
import { retrieveFromCorpus } from "../src/evidence/retrieval/retrieve";
import { loadSignalFacts } from "../src/evidence/retrieval/signal";
import { rankForSignal, retrieveAndRank } from "../src/evidence/ranking/pipeline";
import { RANKING_CONFIG_V1, makeRankingConfig, rankingConfigHash, roundRank } from "../src/evidence/ranking/policy";
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
const denied = (e: { code?: string; message?: string } | null | undefined) => !!e && (e.code === "42501" || /permission denied|not authorized|row-level security/i.test(e.message ?? ""));

const stamp = Date.now();
const createdUsers: string[] = [];
const createdRegions: string[] = [];
interface U { id: string; client: SupabaseClient }
async function makeUser(tag: string, role?: "officer" | "admin"): Promise<U> {
  const email = `m43-verify-${stamp}-${tag}@jansanket.test`;
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
const PAIR = ["syn-conflict-reporting-deadline-a", "syn-conflict-reporting-deadline-b"];

async function cleanup() {
  const items = await service.from("evidence_items").select("id").in("canonical_id", ids);
  const itemIds = (items.data ?? []).map((r) => r.id as string);
  if (itemIds.length) {
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

async function main() {
  const probe = await service.from("evidence_items").select("question_key", { head: true, count: "exact" });
  if (probe.error) {
    console.error(`M4.3 migration does not look applied: ${probe.error.message}`);
    process.exit(3);
  }
  await cleanup();

  section("1. Prerequisites: regions, real detector candidates (read only), synthetic corpus");
  for (const [code, name, type, parent] of [["SYN-IN", "India", "country", null], ["SYN-OD", "Odisha", "state", "SYN-IN"], ["SYN-OD-KHO", "Khordha", "district", "SYN-OD"], ["SYN-OD-GAN", "Ganjam", "district", "SYN-OD"]] as const) {
    if ((await service.from("regions").select("id").eq("administrative_code", code).maybeSingle()).data) continue;
    const parentId = parent ? (await service.from("regions").select("id").eq("administrative_code", parent).single()).data?.id ?? null : null;
    const ins = await service.from("regions").insert({ name, region_type: type, parent_region_id: parentId, administrative_code: code, is_synthetic: true }).select("id").single();
    if (ins.error) throw new Error(`region ${code}: ${ins.error.message}`);
    createdRegions.push(ins.data.id as string);
  }
  const cands = await service.from("signal_candidates").select("id").eq("origin", "system_detector").not("episode_key", "is", null).order("id").limit(6);
  const signals = (cands.data ?? []).map((c) => c.id as string);
  check("live detector candidates exist (run `npm run detect` if not)", signals.length > 0, `${signals.length}`);
  const ing = await ingestCorpus(edb, built.prepared, { corpusName: CORPUS_NAME, notes: "verify:m43 (removed afterwards)" });
  check("synthetic corpus ingested", ing.ok, ing.errors.join("; "));

  section("2. Ranking real signals");
  const view = await loadCorpusView(edb);
  const hview = await loadCorpusView(edb, { textStatuses: ["superseded", "historical"] });
  const OWN = (f: Awaited<ReturnType<typeof loadSignalFacts>>) => new Set([f!.region.id, ...f!.ancestors.map((a) => a.id)]);
  let withEvidence = 0;
  for (const id of signals) {
    const facts = (await loadSignalFacts(edb, id))!;
    const tag = `${facts.syndrome} @ ${facts.region.name}`;
    const r1 = (await rankForSignal(edb, id, RETRIEVAL_CONFIG_DEV))!;
    const r2 = (await rankForSignal(edb, id, RETRIEVAL_CONFIG_DEV))!;
    check(`${tag}: identical on a second run (JSON, ids included)`, JSON.stringify(r1) === JSON.stringify(r2));
    const pure = retrieveAndRank({ facts, view, historicalView: hview, retrievalConfig: RETRIEVAL_CONFIG_DEV });
    check(`${tag}: database path equals the pure path (ranking hash)`, r1.rankingHash === pure.rankingHash);
    check(`${tag}: M4.2 provenance unchanged (retrieval result hash matches a fresh M4.2 run)`, r1.retrieval.resultHash === retrieveFromCorpus(view, facts, RETRIEVAL_CONFIG_DEV).resultHash);
    check(`${tag}: ranking config hash is the published one`, r1.ranking.configHash === rankingConfigHash(RANKING_CONFIG_V1));

    const sel = r1.facets.flatMap((f) => f.selected);
    if (sel.length) withEvidence++;
    check(`${tag}: rank score = relevance x class x geo x temporal for every selected item`, sel.every((c) => {
      const s = c.scoreComponents;
      return s.rankScore === roundRank(s.relevance.value * s.classFactor.value * s.geoFactor.value * s.temporalFactor.value) && s.relevance.value === roundRank(c.bm25Score / s.relevance.normalisedBy);
    }));
    check(`${tag}: factors come from the published tables`, sel.every((c) => Object.values(RANKING_CONFIG_V1.classFactor.table).includes(c.scoreComponents.classFactor.value) && Object.values(RANKING_CONFIG_V1.geoFactor.table).includes(c.scoreComponents.geoFactor.value) && [1, 0.6, 0.3].includes(c.scoreComponents.temporalFactor.value)));
    check(`${tag}: at most 5 per facet, 2 per document, 3 per publisher`, r1.facets.every((f) => {
      const d = new Map<string, number>(), p = new Map<string, number>();
      for (const c of f.selected) {
        d.set(c.evidenceItemId, (d.get(c.evidenceItemId) ?? 0) + 1);
        p.set(c.metadata.publisher, (p.get(c.metadata.publisher) ?? 0) + 1);
      }
      return f.selected.length <= 5 && Math.max(0, ...d.values()) <= 2 && Math.max(0, ...p.values()) <= 3;
    }));
    const cands2 = retrieveFromCorpus(view, facts, RETRIEVAL_CONFIG_DEV);
    check(`${tag}: every retrieved candidate is selected or has a machine-readable reason (nothing silently dropped)`, r1.facets.every((f) => {
      const src = cands2.facets.find((x) => x.facet === f.facet)!.candidates.map((c) => c.chunkId).sort();
      return JSON.stringify([...f.selected.map((c) => c.chunkId), ...f.excluded.map((e) => e.candidate.chunkId)].sort()) === JSON.stringify(src) && f.excluded.every((e) => e.reason && e.family);
    }));
    check(`${tag}: nothing quarantined, draft, withdrawn, superseded, historical or unverified is selected`, sel.every((c) => c.metadata.status === "current" && c.metadata.sourceClass !== "unverified" && !/^syn-adv-|-2022$|withdrawn|forum-post|draft/.test(c.canonicalId ?? "")));
    const own = OWN(facts);
    check(`${tag}: state/district evidence belongs to the signal's own region chain`, sel.every((c) => !["state", "district"].includes(c.scoreComponents.geoFactor.evidenceScope) || (c.metadata.geoRegionId !== null && own.has(c.metadata.geoRegionId))));
    check(`${tag}: exact copies are removed as duplicates in favour of the higher-tier original`, r1.facets.every((f) => !f.selected.some((c) => c.canonicalId === "syn-ads-verification-exact-copy")) && r1.facets.every((f) => f.excluded.filter((e) => e.reason === "duplicate").every((e) => e.detail.retained && e.detail.rule && e.detail.basis)));
    check(`${tag}: the synthetic corpus is flagged as such in the gaps`, r1.gaps.some((g) => g.code === "only_synthetic_evidence") || sel.length === 0);
    check(`${tag}: no conflict is guessed from untagged documents`, r1.conflicts.length === 0);
    const prod = await rankForSignal(edb, id, RETRIEVAL_CONFIG_V1);
    check(`${tag}: the production configuration ranks nothing and reports the absence`, prod!.facets.every((f) => f.selected.length === 0) && prod!.gaps[0].code === "no_eligible_evidence");
  }
  check("at least one live signal had ranked evidence", withEvidence > 0);

  section("3. Curator-controlled conflict metadata (real database, audited)");
  const admin = await makeUser("admin", "admin");
  const officer = await makeUser("officer", "officer");
  const citizen = await makeUser("citizen");
  const pairIds = (await service.from("evidence_items").select("id, canonical_id").in("canonical_id", PAIR)).data ?? [];
  const idOf = (c: string) => pairIds.find((p) => p.canonical_id === c)!.id as string;
  const tagPatch = (q: string, pos: string) => ({ question_key: q, position: pos });
  const o1 = await officer.client.from("evidence_items").update(tagPatch("reporting_deadline", "within_24_hours")).eq("id", idOf(PAIR[0])).select("id");
  const c1 = await citizen.client.from("evidence_items").update(tagPatch("reporting_deadline", "within_24_hours")).eq("id", idOf(PAIR[0])).select("id");
  check("an officer and a citizen cannot set conflict tags", (denied(o1.error) || (o1.data ?? []).length === 0) && (denied(c1.error) || (c1.data ?? []).length === 0));
  const half = await service.from("evidence_items").update({ question_key: "reporting_deadline" }).eq("id", idOf(PAIR[0]));
  check("half a tag is rejected by the database", !!half.error && /conflict_tag_chk|check constraint/i.test(half.error.message), half.error?.message);
  const bad = await service.from("evidence_items").update(tagPatch("Has Spaces", "x")).eq("id", idOf(PAIR[0]));
  check("an uncontrolled-looking tag is rejected by the database", !!bad.error, bad.error?.message);
  const a1 = await admin.client.from("evidence_items").update(tagPatch("reporting_deadline", "within_24_hours")).eq("id", idOf(PAIR[0])).select("id");
  const a2 = await admin.client.from("evidence_items").update(tagPatch("reporting_deadline", "within_72_hours")).eq("id", idOf(PAIR[1])).select("id");
  check("an admin can tag the pair", !a1.error && (a1.data ?? []).length === 1 && !a2.error && (a2.data ?? []).length === 1, `${a1.error?.message} ${a2.error?.message}`);
  const audit = await service.from("audit_log").select("metadata").eq("entity", "evidence_items").eq("entity_id", idOf(PAIR[0])).order("created_at", { ascending: false }).limit(1);
  check("the tag change is audited by field name", JSON.stringify(audit.data?.[0]?.metadata ?? {}).includes("question_key"));

  const facts0 = (await loadSignalFacts(edb, signals[0]))!;
  const taggedView = await loadCorpusView(edb);
  check("the loader returns the tags", taggedView.items.find((i) => i.canonicalId === PAIR[0])?.questionKey === "reporting_deadline");
  const slim = { ...taggedView, items: taggedView.items.filter((i) => PAIR.includes(i.canonicalId!)) };
  const conflicted = retrieveAndRank({ facts: facts0, view: slim, retrievalConfig: RETRIEVAL_CONFIG_DEV, rankingConfig: makeRankingConfig({ relevanceFloor: 0 }) });
  check("tagged documents with different positions are reported as a conflict (curator_tags)", conflicted.conflicts.length === 1 && conflicted.conflicts[0].basis === "curator_tags" && conflicted.conflicts[0].positions.length === 2);
  const full = retrieveAndRank({ facts: facts0, view: taggedView, retrievalConfig: RETRIEVAL_CONFIG_DEV });
  const selectedSet = new Set(full.facets.flatMap((f) => f.selected).map((c) => c.canonicalId));
  check("in the full corpus a conflict appears exactly when both tagged documents are selected", (full.conflicts.length === 1) === PAIR.every((p) => selectedSet.has(p)));
  check("tagging changes no retrieval result", full.retrieval.resultHash === retrieveFromCorpus(view, facts0, RETRIEVAL_CONFIG_DEV).resultHash);
  await service.from("evidence_items").update({ question_key: null, position: null }).in("id", [idOf(PAIR[0]), idOf(PAIR[1])]);
  const cleared = retrieveAndRank({ facts: facts0, view: { ...slim, items: (await loadCorpusView(edb)).items.filter((i) => PAIR.includes(i.canonicalId!)) }, retrievalConfig: RETRIEVAL_CONFIG_DEV, rankingConfig: makeRankingConfig({ relevanceFloor: 0 }) });
  check("clearing the tags removes the conflict", cleared.conflicts.length === 0);

  section("4. Row-level security can only narrow what is ranked");
  const svc = (await rankForSignal(edb, signals[0], RETRIEVAL_CONFIG_DEV))!;
  const officerView = await loadCorpusView(supabaseEvidenceDb(officer.client));
  const off = retrieveAndRank({ facts: facts0, view: officerView, retrievalConfig: RETRIEVAL_CONFIG_DEV });
  const sig = (r: typeof svc) => JSON.stringify(r.facets.map((f) => f.selected.map((c) => [c.canonicalId, c.chunkOrdinal, c.scoreComponents.rankScore, c.rank])));
  check("an officer-level reader gets exactly the selected evidence the service reader gets", sig(off) === sig(svc));
  const citView = await loadCorpusView(supabaseEvidenceDb(citizen.client));
  const cit = retrieveAndRank({ facts: facts0, view: citView, retrievalConfig: RETRIEVAL_CONFIG_DEV });
  check("a citizen-level reader gets nothing and an explicit gap", cit.facets.every((f) => f.selected.length === 0) && cit.gaps[0].code === "no_eligible_evidence");
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
    console.log(`\n${passed}/${passed + failed} checks passed. Evidence rows, tags, snapshots, helper regions and test users removed; detector candidates untouched.`);
    process.exit(failed ? 1 : 0);
  });
