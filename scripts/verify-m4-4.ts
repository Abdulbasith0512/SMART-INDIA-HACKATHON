// M4.4 verification against the LIVE Supabase project (the M4.0 tables; M4.4 needs no migration). Ingests the SYNTHETIC
// development corpus with an active snapshot, builds and stores canonical evidence bundles for the REAL detector
// candidates already stored by M3, and checks determinism, hashing, citation-id integrity, idempotency, the extractive
// fallback, the signal_evidence mirror, append-only behaviour, curator-tagged conflicts and row-level security with
// real users. Everything it creates (bundles, runs, items, explanations, citations, mirror rows, evidence rows,
// snapshots, helper regions, test users) is removed at the end; detector candidates are only READ.
//
// Usage: npm run verify:m44
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { canonicalBundleJson } from "../src/evidence/bundle/canonical";
import { buildBundle } from "../src/evidence/bundle/build";
import { ownWording, renderExtractive, validateFallback, FORBIDDEN_FALLBACK_WORDING } from "../src/evidence/bundle/fallback";
import { loadCitationMetadata, loadSignalIdentity, loadStoredBundle, mirrorTargets, persistBundle, plannedItems, verifyStoredBundle } from "../src/evidence/bundle/persist";
import { buildBundleForSignal } from "../src/evidence/bundle/pipeline";
import type { EvidenceBundle } from "../src/evidence/bundle/types";
import { sha256Hex } from "../src/evidence/hash";
import { ingestCorpus } from "../src/evidence/ingest/ingest";
import { buildCorpus } from "../src/evidence/ingest/loader";
import { RETRIEVAL_CONFIG_DEV, RETRIEVAL_CONFIG_V1 } from "../src/evidence/retrieval/config";
import { loadCorpusView } from "../src/evidence/retrieval/corpus";
import { retrieveFromCorpus } from "../src/evidence/retrieval/retrieve";
import { loadSignalFacts } from "../src/evidence/retrieval/signal";
import { retrieveAndRank } from "../src/evidence/ranking/pipeline";
import { makeRankingConfig } from "../src/evidence/ranking/policy";
import { rankEvidence } from "../src/evidence/ranking/rank";
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
const appendOnly = (e: { code?: string; message?: string } | null | undefined) => !!e && (e.code === "JS008" || /append-only|immutable/i.test(e.message ?? ""));
const countOf = async (q: PromiseLike<{ count: number | null; error: { message: string } | null }>): Promise<number> => {
  const r = await q;
  if (r.error) throw new Error(r.error.message);
  return r.count ?? 0;
};
const rows = (client: SupabaseClient, table: string) => client.from(table).select("*", { head: true, count: "exact" });

// Frozen references (asserted so a drift in any earlier milestone is caught here too).
const FROZEN = {
  corpusHash: "a66e0364a6b0c216381cfa9a6f0db846aa672f4b918587592cbcfe2ddfd497d2",
  corpusDigest: "cbd9f2ab2beb450d2a4813d7fa70e782ffc899f9f392d6c1f4c54da6d840014a",
  retrievalConfigDev: "029b517ac9986c47588303c98a594a2fc9819371f3f3f201f3e199894bccda7f",
  rankingConfig: "f288734e732142d6bbab1afeeb8acc6e5a47aee0fcd97a3ef07e6ccc44c19d5d",
};
const RETRIEVED_AT = "2026-01-01T00:00:00.000Z";

const stamp = Date.now();
const createdUsers: string[] = [];
const createdRegions: string[] = [];
interface U { id: string; client: SupabaseClient }
async function makeUser(tag: string, role?: "officer" | "admin", regionId: string | null = null): Promise<U> {
  const email = `m44-verify-${stamp}-${tag}@jansanket.test`;
  const password = randomBytes(12).toString("base64url") + "aA1!";
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser ${tag}: ${error.message}`);
  createdUsers.push(data.user.id);
  if (role) {
    const r = await service.from("user_roles").insert({ user_id: data.user.id, role, region_id: regionId });
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

/** Remove everything this script (or an interrupted earlier run of it) created. Order matters: children before parents. */
async function cleanup() {
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

async function main() {
  const probe = await service.from("evidence_bundles").select("id", { head: true, count: "exact" });
  if (probe.error) {
    console.error(`M4.0 bundle tables do not look applied: ${probe.error.message}`);
    process.exit(3);
  }
  await cleanup();
  const foreignActive = ((await service.from("corpus_snapshots").select("id, corpus_version").eq("is_active", true)).data ?? []);
  if (foreignActive.length) {
    console.error(`An active corpus snapshot that is not this script's exists (${foreignActive.map((s) => s.corpus_version).join(", ")}); refusing to change which snapshot is active.`);
    process.exit(3);
  }

  section("1. Prerequisites: regions, real detector candidates (read only), synthetic corpus with an active snapshot");
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
  const ing = await ingestCorpus(edb, built.prepared, { corpusName: CORPUS_NAME, notes: "verify:m44 (removed afterwards)", activate: true });
  check("synthetic corpus ingested and its snapshot activated", ing.ok && !!ing.snapshot?.activated, ing.errors.join("; "));
  const snapshotId = ing.snapshot?.id ?? null;
  const view = await loadCorpusView(edb);
  const hview = await loadCorpusView(edb, { textStatuses: ["superseded", "historical"] });
  check("the loaded corpus view carries the active snapshot", view.activeSnapshot?.id === snapshotId && view.activeSnapshot?.corpusHash === FROZEN.corpusHash);

  section("2. Bundles for real signals");
  const stored: Array<{ signal: string; bundle: EvidenceBundle; bundleId: string; explanationId: string }> = [];
  for (const id of signals) {
    const facts = (await loadSignalFacts(edb, id))!;
    const tag = `${facts.syndrome} @ ${facts.region.name}`;
    const b1 = (await buildBundleForSignal(edb, id, RETRIEVAL_CONFIG_DEV, undefined, { retrievedAt: RETRIEVED_AT }))!;
    const b2 = (await buildBundleForSignal(edb, id, RETRIEVAL_CONFIG_DEV, undefined, { retrievedAt: "2030-01-01T00:00:00.000Z" }))!;
    check(`${tag}: identical canonical bytes and hash on a second build, whatever the clock`, canonicalBundleJson(b1) === canonicalBundleJson(b2) && b1.bundle_hash === b2.bundle_hash);
    check(`${tag}: pinned configuration and corpus (retrieval, ranking, corpus hash, corpus digest)`, b1.config.retrieval_config_hash === FROZEN.retrievalConfigDev && b1.config.ranking_config_hash === FROZEN.rankingConfig && b1.corpus.corpus_hash === FROZEN.corpusHash && b1.corpus.corpus_digest === FROZEN.corpusDigest && b1.corpus.snapshot_id === snapshotId);
    const pure = retrieveAndRank({ facts, view, historicalView: hview, retrievalConfig: RETRIEVAL_CONFIG_DEV });
    check(`${tag}: provenance equals a fresh M4.2/M4.3 run (retrieval result hash, ranking hash)`, b1.provenance.retrieval_result_hash === pure.retrieval.resultHash && b1.provenance.ranking_hash === pure.rankingHash);
    check(`${tag}: the signal section carries only the officer-visible aggregate facts`, JSON.stringify(Object.keys(b1.signal).sort()) === JSON.stringify(["candidate_id", "detector_version", "episode_key", "region", "syndrome", "window"]) && !/observed_value|p_value|patient|phone/.test(JSON.stringify(b1)));

    const p1 = await persistBundle(edb, b1);
    check(`${tag}: stored (run, bundle, ${p1.items} citation rows, fallback)`, p1.created && p1.explanationCreated && p1.items === b1.citations.length);
    const p2 = await persistBundle(edb, b1);
    const p3 = (await persistBundle(edb, (await buildBundleForSignal(edb, id, RETRIEVAL_CONFIG_DEV, undefined, { retrievedAt: "2031-01-01T00:00:00.000Z" }))!));
    check(`${tag}: storing the same bundle again (or a rebuild of it) writes nothing new`, !p2.created && !p2.explanationCreated && p2.runId === null && p2.bundleId === p1.bundleId && !p3.created && p3.bundleId === p1.bundleId);
    check(`${tag}: one run, one bundle, ${b1.citations.length} items, one fallback for this signal`,
      (await countOf(rows(service, "evidence_bundles").eq("signal_candidate_id", id))) === 1 && (await countOf(rows(service, "retrieval_runs").eq("signal_candidate_id", id))) === 1
      && (await countOf(rows(service, "evidence_bundle_items").eq("bundle_id", p1.bundleId))) === b1.citations.length && (await countOf(rows(service, "generated_explanations").eq("bundle_id", p1.bundleId))) === 1);

    const rep = await verifyStoredBundle(edb, p1.bundleId);
    check(`${tag}: stored bundle verifies (hash recomputed, citation rows, chunk text, versions)`, rep.ok && rep.stale.length === 0, rep.problems.join("; "));
    const st = (await loadStoredBundle(edb, id))!;
    check(`${tag}: the stored JSON round-trips with the same bundle hash`, canonicalBundleJson(st.bundle) === canonicalBundleJson(b1) && st.bundleHash === b1.bundle_hash);

    const itemRows = (await service.from("evidence_bundle_items").select("citation_id, evidence_version_id, chunk_id").eq("bundle_id", p1.bundleId)).data ?? [];
    const planned = plannedItems(b1);
    const chunkText = new Map(((await service.from("evidence_chunks").select("id, text").in("id", planned.map((x) => x.item.chunk_id))).data ?? []).map((c) => [c.id as string, c.text as string]));
    check(`${tag}: every citation id maps to exactly its (version, chunk) and the excerpt is the stored chunk text`, planned.length > 0 && planned.every((x) => {
      const r = itemRows.find((i) => i.citation_id === x.item.citation_id);
      return !!r && r.evidence_version_id === x.item.evidence_version_id && r.chunk_id === x.item.chunk_id && chunkText.get(x.item.chunk_id) === x.item.excerpt;
    }) && new Set(itemRows.map((r) => r.citation_id)).size === itemRows.length);
    check(`${tag}: M4.3 exclusion log, gaps and (untagged) conflicts are carried over exactly`, st.bundle.excluded.length === pure.exclusions.ranking.length && JSON.stringify(st.bundle.gaps.map((g) => g.message)) === JSON.stringify(pure.gaps.map((g) => g.message)) && st.bundle.conflicts.length === 0 && pure.conflicts.length === 0);

    const meta = await loadCitationMetadata(edb, b1.citations.map((c) => c.evidence_version_id));
    const rendered = renderExtractive(b1, (x) => meta.get(x));
    const ex = (await service.from("generated_explanations").select("id, status, provider, model, input_hash, output, validation_report").eq("bundle_id", p1.bundleId)).data ?? [];
    const out = ex[0]?.output as { text?: string } | undefined;
    check(`${tag}: the fallback is stored as fallback_extractive with no provider or model, and re-renders byte-for-byte from the database`, ex.length === 1 && ex[0].status === "fallback_extractive" && ex[0].provider === "extractive" && ex[0].model === "deterministic-fallback" && ex[0].input_hash === b1.bundle_hash && out?.text === rendered.fallback.text);
    check(`${tag}: the fallback opens with the required sentence and passes every validation check`, rendered.fallback.text.startsWith("Evidence relevant to this emerging signal suggests…\n") && validateFallback(b1, rendered).every((c) => c.ok));
    check(`${tag}: the fallback's own wording has no diagnosis, cause, outbreak or treatment language`, ownWording(b1, rendered.parts).every((t) => !FORBIDDEN_FALLBACK_WORDING.test(t)));
    const cites = (await service.from("explanation_citations").select("claim_index, bundle_item_id").eq("explanation_id", ex[0].id as string)).data ?? [];
    check(`${tag}: one explanation citation per quoted passage`, cites.length === rendered.fallback.points.length);

    const mirror = ((await service.from("signal_evidence").select("evidence_item_id, relevance_note").eq("signal_candidate_id", id)).data ?? []);
    const want = mirrorTargets(b1);
    check(`${tag}: signal_evidence mirrors the documents with a current cited chunk (compact notes)`, JSON.stringify(mirror.map((m) => m.evidence_item_id).sort()) === JSON.stringify([...want.keys()].sort()) && mirror.every((m) => want.get(m.evidence_item_id as string) === m.relevance_note && (m.relevance_note as string).length <= 480));
    stored.push({ signal: id, bundle: b1, bundleId: p1.bundleId, explanationId: ex[0].id as string });
  }
  check("at least one live signal had evidence in its bundle", stored.some((s) => s.bundle.citations.length > 0));

  section("3. The production configuration (no synthetic evidence) gives an empty bundle that says so");
  if (signals.length) {
    const id = signals[0];
    const empty = (await buildBundleForSignal(edb, id, RETRIEVAL_CONFIG_V1, undefined, { retrievedAt: RETRIEVED_AT }))!;
    check("no citations, four empty facets, and the no_eligible_evidence gap", empty.citations.length === 0 && empty.facets.length === 4 && empty.facets.every((f) => f.items.length === 0) && empty.gaps.some((g) => g.code === "no_eligible_evidence"));
    const pe = await persistBundle(edb, empty);
    const exOut = ((await service.from("generated_explanations").select("output").eq("id", pe.explanationId).single()).data?.output ?? {}) as { thin?: boolean; text?: string; points?: unknown[] };
    check("stored, with a fallback that states there is nothing to quote and quotes nothing", pe.created && exOut.thin === true && (exOut.points ?? []).length === 0 && /nothing to quote/.test(exOut.text ?? "") && !/\[E\d+\]/.test(exOut.text ?? ""));
    check("the empty bundle verifies, and the mirror is emptied to match it", (await verifyStoredBundle(edb, pe.bundleId)).ok && (await countOf(rows(service, "signal_evidence").eq("signal_candidate_id", id))) === 0);
    const again = await persistBundle(edb, stored[0].bundle);
    check("persisting the evidence-bearing bundle again reuses it and restores its mirror", !again.created && again.bundleId === stored[0].bundleId && (await countOf(rows(service, "signal_evidence").eq("signal_candidate_id", id))) === mirrorTargets(stored[0].bundle).size);
  }

  section("4. Append-only (service role included)");
  if (stored.length) {
    const s = stored[0];
    const u1 = await service.from("evidence_bundles").update({ item_count: 999 }).eq("id", s.bundleId);
    const u2 = await service.from("evidence_bundle_items").update({ rank: 99 }).eq("bundle_id", s.bundleId);
    const u3 = await service.from("generated_explanations").update({ output: {} }).eq("id", s.explanationId);
    const u4 = await service.from("explanation_citations").update({ quote: "edited" }).eq("explanation_id", s.explanationId);
    check("a stored bundle cannot be edited", appendOnly(u1.error), u1.error?.message);
    check("a stored bundle item cannot be edited", appendOnly(u2.error) || (s.bundle.citations.length === 0), u2.error?.message);
    check("a stored explanation cannot be edited", appendOnly(u3.error), u3.error?.message);
    check("a stored explanation citation cannot be edited", appendOnly(u4.error) || (s.bundle.citations.length === 0), u4.error?.message);
    check("the stored bundle is unchanged after those attempts", (await verifyStoredBundle(edb, s.bundleId)).ok);
  }

  section("5. Curator-tagged conflicts are persisted exactly");
  const admin = await makeUser("admin", "admin");
  const pairIds = (await service.from("evidence_items").select("id, canonical_id").in("canonical_id", PAIR)).data ?? [];
  const idOf = (c: string) => pairIds.find((p) => p.canonical_id === c)!.id as string;
  const a1 = await admin.client.from("evidence_items").update({ question_key: "reporting_deadline", position: "within_24_hours" }).eq("id", idOf(PAIR[0])).select("id");
  const a2 = await admin.client.from("evidence_items").update({ question_key: "reporting_deadline", position: "within_72_hours" }).eq("id", idOf(PAIR[1])).select("id");
  check("an admin tags the pair", !a1.error && !a2.error && (a1.data ?? []).length === 1 && (a2.data ?? []).length === 1, `${a1.error?.message} ${a2.error?.message}`);
  if (signals.length) {
    const id = signals[0];
    const facts = (await loadSignalFacts(edb, id))!;
    const taggedView = await loadCorpusView(edb);
    const slim = { ...taggedView, items: taggedView.items.filter((i) => PAIR.includes(i.canonicalId!)) };
    const retrieval = retrieveFromCorpus(slim, facts, RETRIEVAL_CONFIG_DEV);
    const ranking = rankEvidence({ facts, retrieval, historical: null, view: slim, config: makeRankingConfig({ relevanceFloor: 0 }) });
    const cb = buildBundle({ facts, identity: await loadSignalIdentity(edb, id), retrieval, ranking, retrievedAt: RETRIEVED_AT });
    check("the bundle reports one curator-tagged conflict with both positions and cited passages", cb.conflicts.length === 1 && cb.conflicts[0].kind === "curator_tagged_conflict" && cb.conflicts[0].basis === "curator_tags" && cb.conflicts[0].positions.length === 2 && cb.conflicts[0].positions.every((p) => p.documents.some((d) => d.citation_ids.length > 0)));
    const pc = await persistBundle(edb, cb);
    const sc = (await loadStoredBundle(edb, id, cb.bundle_hash))!;
    const conflictText = String(((await service.from("generated_explanations").select("output").eq("id", pc.explanationId).single()).data?.output as { text?: string } | undefined)?.text);
    check("the conflict bundle is created, with its conflict count stored in the column", pc.created && sc.conflictCount === 1);
    check("the stored conflicts equal the built ones (canonical JSON; jsonb does not keep key order)", canonicalBundleJson({ c: sc.bundle.conflicts }) === canonicalBundleJson({ c: cb.conflicts }));
    check("the fallback reports the conflict as curator-tagged", conflictText.includes("Conflicting positions (reported only where curators tagged"), conflictText.slice(0, 200));
    check("the conflict bundle verifies and the earlier bundles are untouched", (await verifyStoredBundle(edb, pc.bundleId)).ok && (await verifyStoredBundle(edb, stored[0].bundleId)).ok);
    await service.from("evidence_items").update({ question_key: null, position: null }).in("id", [idOf(PAIR[0]), idOf(PAIR[1])]);
  }

  section("6. Row-level security with real users");
  if (stored.length) {
    const s = stored[0];
    const facts = (await loadSignalFacts(edb, s.signal))!;
    const districtId = [facts.region, ...facts.ancestors].find((r) => r.level === "district")?.id ?? null;
    check("the first live signal sits inside a district (needed for scoped officers)", !!districtId);
    const other = districtId ? ((await service.from("regions").select("id").eq("region_type", "district").neq("id", districtId).limit(1)).data ?? [])[0]?.id as string | undefined : undefined;
    check("a second, different district exists for the out-of-scope officer", !!other);
    const inScope = await makeUser("officer-in", "officer", districtId);
    const outScope = await makeUser("officer-out", "officer", other ?? null);
    const unscoped = await makeUser("officer-none", "officer", null);
    const citizen = await makeUser("citizen");
    const view6 = async (u: U) => ({
      runs: await countOf(rows(u.client, "retrieval_runs").eq("signal_candidate_id", s.signal)),
      bundles: await countOf(rows(u.client, "evidence_bundles").eq("signal_candidate_id", s.signal)),
      items: await countOf(rows(u.client, "evidence_bundle_items").eq("bundle_id", s.bundleId)),
      explanations: await countOf(rows(u.client, "generated_explanations").eq("bundle_id", s.bundleId)),
      citations: await countOf(rows(u.client, "explanation_citations").eq("explanation_id", s.explanationId)),
      mirror: await countOf(rows(u.client, "signal_evidence").eq("signal_candidate_id", s.signal)),
    });
    const all = await view6(admin);
    check("an admin sees the signal's runs, bundles, items, explanation, citations and mirror", all.bundles >= 1 && all.runs >= 1 && all.explanations === 1 && all.items === s.bundle.citations.length);
    check("an officer whose district contains the signal sees exactly the same", JSON.stringify(await view6(inScope)) === JSON.stringify(all));
    const none = { runs: 0, bundles: 0, items: 0, explanations: 0, citations: 0, mirror: 0 };
    check("an officer in another district sees none of it", JSON.stringify(await view6(outScope)) === JSON.stringify(none));
    check("an unscoped officer sees none of it", JSON.stringify(await view6(unscoped)) === JSON.stringify(none));
    check("a citizen sees none of it", JSON.stringify(await view6(citizen)) === JSON.stringify(none));
    const raw = await outScope.client.from("evidence_bundles").select("id, bundle").eq("id", s.bundleId);
    check("an out-of-scope officer cannot read the stored bundle JSON", (raw.data ?? []).length === 0);

    const bundleRow = { retrieval_run_id: (await service.from("evidence_bundles").select("retrieval_run_id").eq("id", s.bundleId).single()).data?.retrieval_run_id, signal_candidate_id: s.signal, bundle_hash: "9".repeat(64), schema_version: "evidence-bundle/1", bundle: {} };
    let writesBlocked = true;
    for (const [label, u] of [["admin", admin], ["in-scope officer", inScope], ["citizen", citizen]] as const) {
      const tries = [
        await u.client.from("evidence_bundles").insert(bundleRow).select("id"),
        await u.client.from("evidence_bundle_items").insert({ bundle_id: s.bundleId, evidence_version_id: s.bundle.citations[0]?.evidence_version_id, chunk_id: s.bundle.citations[0]?.chunk_id, facet: "case_definition", rank: 99, citation_id: "E99" }).select("id"),
        await u.client.from("generated_explanations").insert({ bundle_id: s.bundleId, provider: "x", model: "y", prompt_version: "z", input_hash: "9".repeat(64), status: "rejected" }).select("id"),
        await u.client.from("retrieval_runs").insert({ signal_candidate_id: s.signal, corpus_snapshot_id: snapshotId, retrieval_version: "v", retrieval_config_hash: "9".repeat(64), query_vocab_version: "v", as_of_date: "2025-09-07" }).select("id"),
        await u.client.from("signal_evidence").insert({ signal_candidate_id: s.signal, evidence_item_id: idOf(PAIR[0]) }).select("signal_candidate_id"),
        await u.client.from("evidence_bundles").update({ item_count: 0 }).eq("id", s.bundleId).select("id"),
        await u.client.from("evidence_bundles").delete().eq("id", s.bundleId).select("id"),
        await u.client.from("signal_evidence").delete().eq("signal_candidate_id", s.signal).select("signal_candidate_id"),
      ];
      const ok = tries.every((t) => denied(t.error) || (t.data ?? []).length === 0);
      if (!ok) writesBlocked = false;
      check(`${label}: no write to any bundle table or the mirror succeeds`, ok, JSON.stringify(tries.map((t) => [t.error?.code, (t.data ?? []).length])));
    }
    check("after all of those attempts the stored bundle, rows and mirror are intact", writesBlocked && (await verifyStoredBundle(edb, s.bundleId)).ok && (await countOf(rows(service, "evidence_bundles").eq("id", s.bundleId))) === 1);
  }

  section("7. Fallback fingerprint is reproducible");
  if (stored.length) {
    const s = stored[0];
    const meta = await loadCitationMetadata(edb, s.bundle.citations.map((c) => c.evidence_version_id));
    const a = renderExtractive(s.bundle, (x) => meta.get(x)).fallback;
    const b = renderExtractive(s.bundle, (x) => meta.get(x)).fallback;
    check("the extractive fallback text and metadata hash are identical on repeated renders", a.text === b.text && a.metadata_hash === b.metadata_hash && sha256Hex(a.text) === sha256Hex(b.text));
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
    console.log(`\n${passed}/${passed + failed} checks passed. Bundles, runs, items, explanations, citations, mirror rows, evidence rows, snapshots, helper regions and test users removed; detector candidates untouched.`);
    process.exit(failed ? 1 : 0);
  });
