// @vitest-environment node
// M4.4 against the REAL migrated schema (PGlite): bundle persistence into the M4.0 tables, citation-id <-> (version, chunk)
// integrity, append-only behaviour, idempotency and recovery, the signal_evidence mirror, the extractive fallback record,
// and row-level security for the people who may (and may not) read a signal's bundle.
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { canonicalBundleJson, bundleHashOf } from "@/evidence/bundle/canonical";
import { renderExtractive, validateFallback } from "@/evidence/bundle/fallback";
import { loadCitationMetadata, loadStoredBundle, mirrorNote, mirrorTargets, persistBundle, plannedItems, verifyStoredBundle } from "@/evidence/bundle/persist";
import { buildBundleForSignal } from "@/evidence/bundle/pipeline";
import { IDENTITY, referenceBundle, SNAPSHOT } from "@/evidence/bundle/testkit";
import type { EvidenceBundle } from "@/evidence/bundle/types";
import { hashJson, sha256Hex } from "@/evidence/hash";
import { ingestCorpus, type EvidenceDb } from "@/evidence/ingest/ingest";
import { buildCorpus } from "@/evidence/ingest/loader";
import { makeRankingConfig } from "@/evidence/ranking/policy";
import { RETRIEVAL_CONFIG_DEV } from "@/evidence/retrieval/config";
import { loadCorpusView } from "@/evidence/retrieval/corpus";
import { retrieveFromCorpus } from "@/evidence/retrieval/retrieve";
import { loadSignalFacts } from "@/evidence/retrieval/signal";
import { historicalViewFromPrepared, makeFacts, SYNDROMES, uid, viewFromPrepared } from "@/evidence/retrieval/testkit";
import { pgliteEvidenceDb } from "./evidenceDb";
import { DBR, freshEvidenceDb, ingestInOrder, insertSignal, type SignalSeed } from "./evidenceFixture";
import { asUser, IDS, run, type Db } from "./harness";

const ROOT = process.cwd();
const built = buildCorpus(join(ROOT, "data", "evidence", "corpus"), join(ROOT, "data", "evidence", "allowlist.json"), "jansanket-dev-corpus");
const SIGNAL = makeFacts().signal_id;
const PAIR = ["syn-conflict-reporting-deadline-a", "syn-conflict-reporting-deadline-b"];
const CASE_DEF = "syn-ads-case-definition";
const NOW = () => "2026-01-01T00:00:00.000Z";
const RETRIEVED_AT = "2026-01-01T00:00:00.000Z";
const GOLDEN_FALLBACK_SHA = "0f3ebd8d5c375d4b90ebe9cdd5d2c371086b5118a684299b7dcd81fc1ae659af";
const KHORDHA_OFFICER = "00000000-0000-0000-0000-000000000201";
const GANJAM_OFFICER = "00000000-0000-0000-0000-000000000202";
const sig = (name: string) => uid(`signal:bundle:${name}`);

/** Candidates are unique per (region, syndrome, window, method): give each extra signal its own window start (seconds) so its facts are otherwise identical. */
let seq = 0;
const newSignal = async (db: Db, name: string, extra: Partial<SignalSeed> = {}): Promise<string> => {
  seq += 1;
  const id = sig(name);
  await insertSignal(db, { id, start: `2025-08-31T18:30:${String(seq).padStart(2, "0")}Z`, ...extra });
  return id;
};

const shuffle = <T>(xs: readonly T[], seed: number): T[] => {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i -= 1) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const count = async (db: Db, sql: string): Promise<number> => Number((await db.query<{ n: string }>(`select count(*)::text n from ${sql}`)).rows[0].n);
const code = (r: { error?: { code?: string } }) => r.error?.code;

/** Rows a signal owns across every table the persistence layer writes. */
const shape = async (db: Db, signalId: string) => ({
  runs: await count(db, `public.retrieval_runs where signal_candidate_id = '${signalId}'`),
  bundles: await count(db, `public.evidence_bundles where signal_candidate_id = '${signalId}'`),
  items: await count(db, `public.evidence_bundle_items i join public.evidence_bundles b on b.id = i.bundle_id where b.signal_candidate_id = '${signalId}'`),
  explanations: await count(db, `public.generated_explanations g join public.evidence_bundles b on b.id = g.bundle_id where b.signal_candidate_id = '${signalId}'`),
  citations: await count(db, `public.explanation_citations c join public.generated_explanations g on g.id = c.explanation_id join public.evidence_bundles b on b.id = g.bundle_id where b.signal_candidate_id = '${signalId}'`),
  mirror: await count(db, `public.signal_evidence where signal_candidate_id = '${signalId}'`),
});

/** Database ids -> content-derived surrogates, so bundles built over different databases can be compared. */
async function dbSurrogates(db: Db): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  const items = (await db.query<{ id: string; canonical_id: string }>(`select id, canonical_id from public.evidence_items`)).rows;
  const canon = new Map(items.map((i) => [i.id, i.canonical_id]));
  for (const i of items) m.set(i.id, `item:${i.canonical_id}`);
  const versions = (await db.query<{ id: string; evidence_item_id: string }>(`select id, evidence_item_id from public.evidence_versions`)).rows;
  const versionItem = new Map(versions.map((v) => [v.id, canon.get(v.evidence_item_id)!]));
  for (const v of versions) m.set(v.id, `version:${canon.get(v.evidence_item_id)}`);
  for (const c of (await db.query<{ id: string; version_id: string; ordinal: number }>(`select id, version_id, ordinal from public.evidence_chunks`)).rows) m.set(c.id, `chunk:${versionItem.get(c.version_id)}:${c.ordinal}`);
  for (const r of (await db.query<{ id: string; name: string }>(`select id, name from public.regions`)).rows) m.set(r.id, `region:${r.name}`);
  return m;
}
function memorySurrogates(): Map<string, string> {
  const m = new Map<string, string>();
  for (const i of [...viewFromPrepared().items, ...historicalViewFromPrepared().items]) {
    m.set(i.id, `item:${i.canonicalId}`);
    m.set(i.version!.id, `version:${i.canonicalId}`);
    for (const c of i.chunks) m.set(c.id, `chunk:${i.canonicalId}:${c.ordinal}`);
  }
  const f = makeFacts();
  for (const r of [f.region, ...f.ancestors]) m.set(r.id, `region:${r.name}`);
  return m;
}
const normalised = (b: EvidenceBundle, map: Map<string, string>): string => {
  let s = canonicalBundleJson(b);
  if (b.corpus.snapshot_id) s = s.split(b.corpus.snapshot_id).join("SNAPSHOT");
  for (const [id, sur] of map) s = s.split(id).join(sur);
  return s;
};
const fallbackSha = async (db: EvidenceDb, b: EvidenceBundle): Promise<string> => {
  const m = await loadCitationMetadata(db, b.citations.map((c) => c.evidence_version_id));
  return sha256Hex(renderExtractive(b, (id) => m.get(id)).fallback.text);
};

let A: Db;
let edb: EvidenceDb;
let bundle: EvidenceBundle;
let bundleId: string;
let persisted: Awaited<ReturnType<typeof persistBundle>>;

const addOfficers = (db: Db) =>
  db.exec(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${KHORDHA_OFFICER}', 'khordha@test.invalid', '{"display_name":"Khordha officer"}'),
      ('${GANJAM_OFFICER}', 'ganjam@test.invalid', '{"display_name":"Ganjam officer"}');
    insert into public.user_roles (user_id, role, region_id) values
      ('${KHORDHA_OFFICER}', 'officer', '${DBR.khordha}'),
      ('${GANJAM_OFFICER}', 'officer', '${DBR.ganjam}');`);

beforeAll(async () => {
  A = await freshEvidenceDb();
  edb = pgliteEvidenceDb(A);
  const r = await ingestCorpus(edb, built.prepared, { corpusName: "jansanket-dev-corpus", now: NOW, activate: true });
  if (!r.ok) throw new Error(r.errors.join("; "));
  await addOfficers(A);
  await insertSignal(A, { id: SIGNAL });
  bundle = (await buildBundleForSignal(edb, SIGNAL, RETRIEVAL_CONFIG_DEV, undefined, { retrievedAt: RETRIEVED_AT }))!;
  persisted = await persistBundle(edb, bundle, { now: NOW });
  bundleId = persisted.bundleId;
}, 300_000);

describe("the bundle built from the database", () => {
  it("equals the in-memory bundle for the same corpus and signal, apart from database ids", async () => {
    const mem = referenceBundle({ identity: { episodeKey: hashJson(SIGNAL), detectorVersion: "test" } });
    expect(bundle.corpus.corpus_hash).toBe(SNAPSHOT.corpusHash);
    expect(bundle.corpus.snapshot_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(normalised(bundle, await dbSurrogates(A))).toBe(normalised(mem, memorySurrogates()));
    expect(bundle.bundle_hash).not.toBe(mem.bundle_hash); // the bundle records its database ids, so its bytes are database-specific
  });

  it("carries database-independent provenance that equals the in-memory one and the frozen M4.2/M4.3 hashes", () => {
    const mem = referenceBundle();
    expect(bundle.provenance).toEqual(mem.provenance);
    expect(bundle.provenance.query_hash).toBe("e2cc3e663c47c5b585f85685408e6641477d1e8c53d1d97a4707b4aba9bd9f76");
    expect(bundle.config.ranking_config_hash).toBe("f288734e732142d6bbab1afeeb8acc6e5a47aee0fcd97a3ef07e6ccc44c19d5d");
    expect(bundle.config.retrieval_config_hash).toBe("029b517ac9986c47588303c98a594a2fc9819371f3f3f201f3e199894bccda7f");
    expect(bundle.corpus.corpus_digest).toBe("cbd9f2ab2beb450d2a4813d7fa70e782ffc899f9f392d6c1f4c54da6d840014a");
  });

  it("leaves the M4.2 reference retrieval result (no snapshot) unchanged when read from the database", async () => {
    const facts = (await loadSignalFacts(edb, SIGNAL))!;
    const view = await loadCorpusView(edb);
    expect(retrieveFromCorpus({ ...view, activeSnapshot: null }, facts, RETRIEVAL_CONFIG_DEV).resultHash).toBe("fa55022a2264168cc0ac30878313a1e6438e818156aa30d517f3c08dbadedd5a");
  });

  it("is byte-identical on repeated builds (database ids included) and ignores the retrieval clock", async () => {
    const again = (await buildBundleForSignal(edb, SIGNAL, RETRIEVAL_CONFIG_DEV, undefined, { retrievedAt: "2030-05-05T05:05:05.000Z" }))!;
    expect(again.bundle_hash).toBe(bundle.bundle_hash);
    expect(canonicalBundleJson(again)).toBe(canonicalBundleJson(bundle));
    for (let i = 0; i < 3; i += 1) expect((await buildBundleForSignal(edb, SIGNAL, RETRIEVAL_CONFIG_DEV))!.bundle_hash).toBe(bundle.bundle_hash);
  });

  it("is unchanged after the rows are physically rewritten", async () => {
    await A.exec(`update public.evidence_items set title = title`);
    expect((await buildBundleForSignal(edb, SIGNAL, RETRIEVAL_CONFIG_DEV))!.bundle_hash).toBe(bundle.bundle_hash);
  });
});

describe("persistence in the M4.0 tables", () => {
  it("creates one run, one bundle, one item per citation, one fallback and its citations", async () => {
    expect(persisted).toMatchObject({ created: true, explanationCreated: true });
    const points = (await A.query<{ output: { points: unknown[] } }>(`select output from public.generated_explanations where bundle_id = '${bundleId}'`)).rows[0].output.points.length;
    expect(points).toBeGreaterThan(0);
    expect(await shape(A, SIGNAL)).toEqual({ runs: 1, bundles: 1, items: bundle.citations.length, explanations: 1, citations: points, mirror: mirrorTargets(bundle).size });
  });

  it("records the run's configuration and queries, and marks it succeeded", async () => {
    const r = (await A.query<Record<string, unknown>>(`select *, as_of_date::text as as_of_text from public.retrieval_runs where signal_candidate_id = '${SIGNAL}'`)).rows[0];
    expect(r).toMatchObject({
      status: "succeeded", error: null, retrieval_version: bundle.config.retrieval_version, retrieval_config_hash: bundle.config.retrieval_config_hash,
      query_vocab_version: bundle.config.query_vocab_version, corpus_snapshot_id: bundle.corpus.snapshot_id,
    });
    expect(r.as_of_text).toBe(bundle.config.as_of_date);
    expect((r.queries as Array<{ facet: string; terms: string[] }>).map((q) => q.facet)).toEqual(bundle.facets.map((f) => f.name));
    expect((r.queries as Array<{ terms: string[] }>).map((q) => q.terms)).toEqual(bundle.facets.map((f) => f.query_terms));
    expect(r.stats).toMatchObject({ bundle_hash: bundle.bundle_hash, ranking_config_hash: bundle.config.ranking_config_hash, query_hash: bundle.provenance.query_hash });
  });

  it("stores the canonical bundle JSON: it round-trips through jsonb with the same hash", async () => {
    const stored = (await loadStoredBundle(edb, SIGNAL))!;
    expect(stored.bundleHash).toBe(bundle.bundle_hash);
    expect(bundleHashOf(stored.bundle)).toBe(bundle.bundle_hash);
    expect(canonicalBundleJson(stored.bundle)).toBe(canonicalBundleJson(bundle));
    expect(stored).toMatchObject({ itemCount: bundle.citations.length, gapCount: bundle.gaps.length, conflictCount: bundle.conflicts.length });
    expect((await A.query<{ schema_version: string }>(`select schema_version from public.evidence_bundles where id = '${bundleId}'`)).rows[0].schema_version).toBe("evidence-bundle/1");
  });

  it("binds every citation id to exactly the (evidence_version_id, chunk_id) the bundle says, and the chunk text is the excerpt", async () => {
    const rows = (await A.query<{ citation_id: string; evidence_version_id: string; chunk_id: string; facet: string; rank: number; text: string; chunk_hash: string; version_id: string }>(
      `select i.citation_id, i.evidence_version_id, i.chunk_id, i.facet, i.rank, c.text, c.chunk_hash, c.version_id
         from public.evidence_bundle_items i join public.evidence_chunks c on c.id = i.chunk_id where i.bundle_id = '${bundleId}'`,
    )).rows;
    const planned = plannedItems(bundle);
    expect(rows).toHaveLength(planned.length);
    const byId = new Map(rows.map((r) => [r.citation_id, r]));
    for (const p of planned) {
      const r = byId.get(p.item.citation_id)!;
      expect(r.evidence_version_id, p.item.citation_id).toBe(p.item.evidence_version_id);
      expect(r.chunk_id).toBe(p.item.chunk_id);
      expect(r.version_id).toBe(r.evidence_version_id);
      expect(r.text).toBe(p.item.excerpt); // verbatim: the stored chunk, not a copy that could drift
      expect(r.chunk_hash).toBe(p.item.chunk_hash);
      expect([r.facet, Number(r.rank)]).toEqual([p.facet, p.rank]);
    }
    expect(new Set(rows.map((r) => r.citation_id)).size).toBe(rows.length);
    const numbers = rows.map((r) => Number(r.citation_id.slice(1))).sort((a, b) => a - b);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1)); // E1..En, no gaps, none repeated
    expect(bundle.citations.map((c) => c.citation_id)).toEqual(numbers.map((n) => `E${n}`));
  });

  it("stores the per-item score components and reasons it was built from", async () => {
    const rows = (await A.query<{ citation_id: string; score_components: Record<string, unknown>; why: string[] }>(`select citation_id, score_components, why from public.evidence_bundle_items where bundle_id = '${bundleId}'`)).rows;
    for (const r of rows) {
      const p = plannedItems(bundle).find((x) => x.item.citation_id === r.citation_id)!;
      expect(r.why).toEqual(p.item.why_relevant);
      expect(r.score_components).toMatchObject({ ...p.item.score_components });
      expect(r.score_components.appears_in).toEqual(p.citation.appears_in);
    }
  });

  it("persists the M4.3 exclusion log, gaps and conflicts inside the bundle exactly", async () => {
    const stored = (await loadStoredBundle(edb, SIGNAL))!.bundle;
    expect(stored.excluded).toEqual(bundle.excluded);
    expect(stored.excluded.length).toBeGreaterThan(30);
    expect(stored.gaps).toEqual(bundle.gaps);
    expect(stored.gaps.map((g) => g.code)).toEqual(["only_synthetic_evidence"]);
    expect(stored.retrieval_exclusions).toEqual(bundle.retrieval_exclusions);
    expect(stored.conflicts).toEqual([]); // no curator tags in the dev corpus: nothing is inferred
  });

  it("verifies against the database: hash, mapping, chunk text, versions", async () => {
    expect(await verifyStoredBundle(edb, bundleId)).toEqual({ ok: true, problems: [], stale: [] });
  });
});

describe("the extractive fallback record", () => {
  it("is stored once, deterministic, validated, and carries no provider or model", async () => {
    const g = (await A.query<Record<string, unknown>>(`select * from public.generated_explanations where bundle_id = '${bundleId}'`)).rows;
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ status: "fallback_extractive", provider: "extractive", model: "deterministic-fallback", model_version: null, input_hash: bundle.bundle_hash, language: "en", citation_status: "verified" });
    expect(g[0].prompt_version).toBe("extractive-fallback/1.0.0");
    const out = g[0].output as { text: string; bundle_hash: string; status: string; points: Array<{ citation_id: string; excerpt: string }> };
    expect(out).toMatchObject({ bundle_hash: bundle.bundle_hash, status: "fallback_extractive" });
    expect(out.text.startsWith("Evidence relevant to this emerging signal suggests…")).toBe(true);
    expect(sha256Hex(out.text)).toBe(GOLDEN_FALLBACK_SHA); // metadata read from the database renders the same text as the in-memory golden
    const report = g[0].validation_report as { checks: Array<{ ok: boolean }>; deterministic: boolean };
    expect(report.deterministic).toBe(true);
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect(report.checks.length).toBe(9);
  });

  it("has one explanation_citation per point, each bound to the right bundle item and quoting the excerpt", async () => {
    const out = (await A.query<{ output: { points: Array<{ claim_index: number; citation_id: string; excerpt: string }> } }>(`select output from public.generated_explanations where bundle_id = '${bundleId}'`)).rows[0].output;
    const rows = (await A.query<{ claim_index: number; citation_id: string; quote: string; anchor_verified: boolean; text: string }>(
      `select c.claim_index, i.citation_id, c.quote, c.anchor_verified, ch.text
         from public.explanation_citations c join public.evidence_bundle_items i on i.id = c.bundle_item_id join public.evidence_chunks ch on ch.id = i.chunk_id
        where i.bundle_id = '${bundleId}' order by c.claim_index`,
    )).rows;
    expect(rows).toHaveLength(out.points.length);
    for (const [k, r] of rows.entries()) {
      expect(Number(r.claim_index)).toBe(out.points[k].claim_index);
      expect(r.citation_id).toBe(out.points[k].citation_id);
      expect(r.quote).toBe(out.points[k].excerpt.slice(0, 600));
      expect(r.text.startsWith(r.quote)).toBe(true);
      expect(r.anchor_verified).toBe(true);
    }
  });

  it("uses titles, publishers and URLs from the database, not from the bundle", async () => {
    const out = (await A.query<{ output: { text: string } }>(`select output from public.generated_explanations where bundle_id = '${bundleId}'`)).rows[0].output;
    const first = plannedItems(bundle)[0].item;
    const title = (await A.query<{ title: string }>(`select i.title from public.evidence_versions v join public.evidence_items i on i.id = v.evidence_item_id where v.id = '${first.evidence_version_id}'`)).rows[0].title;
    expect(out.text).toContain(title);
    expect(JSON.stringify(bundle)).not.toContain(title);
  });

  it("is valid under the same checks when re-validated from the stored bundle", async () => {
    const stored = (await loadStoredBundle(edb, SIGNAL))!.bundle;
    const m = await loadCitationMetadata(edb, stored.citations.map((c) => c.evidence_version_id));
    const r = renderExtractive(stored, (id) => m.get(id));
    expect(validateFallback(stored, r).every((c) => c.ok)).toBe(true);
    expect(sha256Hex(r.fallback.text)).toBe(GOLDEN_FALLBACK_SHA);
  });
});

describe("idempotency and recovery", () => {
  it("persisting the same bundle again (even rebuilt with a new clock) creates nothing", async () => {
    const before = await shape(A, SIGNAL);
    const again = (await buildBundleForSignal(edb, SIGNAL, RETRIEVAL_CONFIG_DEV, undefined, { retrievedAt: "2031-01-01T00:00:00.000Z" }))!;
    const second = await persistBundle(edb, again, { now: NOW });
    expect(second).toMatchObject({ created: false, bundleId, runId: null, explanationCreated: false, items: before.items, explanationId: persisted.explanationId });
    expect(await shape(A, SIGNAL)).toEqual(before);
    const third = await persistBundle(edb, bundle, { now: NOW });
    expect(third.created).toBe(false);
    expect(await shape(A, SIGNAL)).toEqual(before);
  });

  it("two simultaneous persists converge on one bundle", async () => {
    const id = await newSignal(A, "concurrent");
    const b = (await buildBundleForSignal(edb, id, RETRIEVAL_CONFIG_DEV, undefined, { retrievedAt: RETRIEVED_AT }))!;
    const results = await Promise.allSettled([persistBundle(edb, b, { now: NOW }), persistBundle(edb, b, { now: NOW })]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    await persistBundle(edb, b, { now: NOW }); // whatever one writer left undone, a later call completes
    const s = await shape(A, id);
    expect(s).toMatchObject({ bundles: 1, explanations: 1, items: b.citations.length });
    expect(await verifyStoredBundle(edb, (await loadStoredBundle(edb, id))!.id)).toMatchObject({ ok: true });
  });

  const failing = (inner: EvidenceDb, table: string, nth: number): EvidenceDb => {
    let n = 0;
    return {
      ...inner,
      insert: async (t, rows) => {
        if (t === table) {
          n += 1;
          if (n === nth) throw new Error(`simulated outage inserting into ${table}`);
        }
        return inner.insert(t, rows);
      },
    };
  };

  it.each([
    ["evidence_bundles", 1],
    ["evidence_bundle_items", 1],
    ["evidence_bundle_items", 3],
    ["generated_explanations", 1],
    ["explanation_citations", 2],
    ["signal_evidence", 1],
  ])("an interruption while inserting into %s (call %i) is repaired by running the same persist again", async (table, nth) => {
    const clean = sig("clean");
    if (!(await count(A, `public.evidence_bundles where signal_candidate_id = '${clean}'`))) {
      await newSignal(A, "clean");
      await persistBundle(edb, (await buildBundleForSignal(edb, clean, RETRIEVAL_CONFIG_DEV, undefined, { retrievedAt: RETRIEVED_AT }))!, { now: NOW });
    }
    const id = await newSignal(A, `recover:${table}:${nth}`);
    const b = (await buildBundleForSignal(edb, id, RETRIEVAL_CONFIG_DEV, undefined, { retrievedAt: RETRIEVED_AT }))!;
    await expect(persistBundle(failing(edb, table, nth), b, { now: NOW })).rejects.toThrow(/simulated outage/);
    const repaired = await persistBundle(edb, b, { now: NOW });
    expect(repaired.bundleId).toBeTruthy();
    const got = await shape(A, id);
    const want = await shape(A, clean);
    expect(got).toEqual({ ...want, runs: got.runs }); // identical end state to a clean write
    if (table === "evidence_bundles") expect(got.runs).toBe(2); // the failed attempt's run stays on record, marked failed
    else expect(got.runs).toBe(1);
    const runs = (await A.query<{ status: string; error: string | null }>(`select status, error from public.retrieval_runs where signal_candidate_id = '${id}'`)).rows;
    if (table === "evidence_bundles") expect(runs.map((r) => r.status).sort()).toEqual(["failed", "succeeded"]);
    else expect(runs).toEqual([{ status: "succeeded", error: null }]);
    expect(await verifyStoredBundle(edb, (await loadStoredBundle(edb, id))!.id)).toMatchObject({ ok: true });
    const again = await persistBundle(edb, b, { now: NOW });
    expect(again).toMatchObject({ created: false, explanationCreated: false });
    expect(await shape(A, id)).toEqual(got);
  }, 120_000);

  it("refuses a bundle with no corpus snapshot, a tampered bundle, and an unreadable source, writing nothing", async () => {
    const id = await newSignal(A, "refuse");
    const before = await shape(A, id);
    await expect(persistBundle(edb, referenceBundle({ snapshot: null }), { now: NOW })).rejects.toThrow(/snapshot/);
    const b = (await buildBundleForSignal(edb, id, RETRIEVAL_CONFIG_DEV))!;
    const bad = structuredClone(b);
    bad.gaps = [];
    await expect(persistBundle(edb, bad, { now: NOW })).rejects.toThrow(/bundle_hash does not match/);
    await expect(persistBundle(edb, b, { now: NOW, resolveMetadata: () => undefined })).rejects.toThrow(/no database metadata/);
    expect((await shape(A, id)).explanations).toBe(0);
    expect(before.bundles).toBe(0);
  });
});

describe("append-only", () => {
  it("rejects updates to bundles, bundle items, explanations (except citation_status) and explanation citations", async () => {
    expect(code(await run(A, `update public.evidence_bundles set item_count = item_count + 1 where id = '${bundleId}'`))).toBe("JS008");
    expect(code(await run(A, `update public.evidence_bundles set bundle = '{}'::jsonb where id = '${bundleId}'`))).toBe("JS008");
    expect(code(await run(A, `update public.evidence_bundle_items set rank = rank + 1 where bundle_id = '${bundleId}'`))).toBe("JS008");
    expect(code(await run(A, `update public.evidence_bundle_items set chunk_id = chunk_id where bundle_id = '${bundleId}'`))).toBe("JS008");
    expect(code(await run(A, `update public.generated_explanations set output = '{}'::jsonb where bundle_id = '${bundleId}'`))).toBe("JS008");
    expect(code(await run(A, `update public.generated_explanations set status = 'validated' where bundle_id = '${bundleId}'`))).toBe("JS008");
    expect(code(await run(A, `update public.explanation_citations set quote = 'x' where explanation_id = '${persisted.explanationId}'`))).toBe("JS008");
    const text = (await A.query<{ s: string }>(`select output->>'text' as s from public.generated_explanations where bundle_id = '${bundleId}'`)).rows[0].s;
    expect(sha256Hex(text)).toBe(GOLDEN_FALLBACK_SHA);
  });

  it("allows only the one defined transition: a citation_status flag when a source later goes stale", async () => {
    expect((await run(A, `update public.generated_explanations set citation_status = 'stale' where bundle_id = '${bundleId}'`)).error).toBeUndefined();
    expect((await run(A, `update public.generated_explanations set citation_status = 'verified' where bundle_id = '${bundleId}'`)).error).toBeUndefined();
  });

  it("a second bundle for the same signal is a new row; the first is never edited", async () => {
    const id = await newSignal(A, "append");
    const first = (await buildBundleForSignal(edb, id, RETRIEVAL_CONFIG_DEV, undefined, { retrievedAt: RETRIEVED_AT }))!;
    const second = (await buildBundleForSignal(edb, id, RETRIEVAL_CONFIG_DEV, makeRankingConfig({ topK: 1 }), { retrievedAt: RETRIEVED_AT }))!;
    expect(second.bundle_hash).not.toBe(first.bundle_hash);
    const p1 = await persistBundle(edb, first, { now: NOW });
    const p2 = await persistBundle(edb, second, { now: NOW });
    expect(p1.bundleId).not.toBe(p2.bundleId);
    const s = await shape(A, id);
    expect(s).toMatchObject({ runs: 2, bundles: 2, explanations: 2, items: first.citations.length + second.citations.length });
    expect(await verifyStoredBundle(edb, p1.bundleId)).toMatchObject({ ok: true });
    expect(await verifyStoredBundle(edb, p2.bundleId)).toMatchObject({ ok: true });
    expect((await loadStoredBundle(edb, id))!.bundleHash).toBe(second.bundle_hash); // latest
    expect((await loadStoredBundle(edb, id, first.bundle_hash))!.bundleHash).toBe(first.bundle_hash);
  });
});

describe("signal_evidence is a compact mirror of the latest bundle, never the source of truth", () => {
  it("lists exactly the documents with a current cited chunk, with a short note naming the citation ids", async () => {
    const rows = (await A.query<{ evidence_item_id: string; relevance_note: string }>(`select evidence_item_id, relevance_note from public.signal_evidence where signal_candidate_id = '${SIGNAL}' order by evidence_item_id`)).rows;
    const want = mirrorTargets(bundle);
    expect(rows.map((r) => r.evidence_item_id)).toEqual([...want.keys()].sort());
    for (const r of rows) {
      expect(r.relevance_note).toBe(want.get(r.evidence_item_id));
      expect(r.relevance_note.length).toBeLessThanOrEqual(480);
      expect(r.relevance_note).toMatch(/^Cited in evidence bundle [0-9a-f]{12}: E\d+ \(/);
      expect(r.relevance_note).toBe(mirrorNote(bundle, r.evidence_item_id));
    }
    const historicalOnly = bundle.citations.filter((c) => c.section !== "main").map((c) => c.evidence_item_id).filter((id) => !bundle.citations.some((c) => c.section === "main" && c.evidence_item_id === id));
    for (const id of historicalOnly) expect(rows.map((r) => r.evidence_item_id)).not.toContain(id);
  });

  it("follows the bundle that was persisted last: a narrower bundle replaces it, and persisting the earlier one again restores it", async () => {
    const id = await newSignal(A, "mirror");
    const wide = (await buildBundleForSignal(edb, id, RETRIEVAL_CONFIG_DEV, undefined, { retrievedAt: RETRIEVED_AT }))!;
    const narrow = (await buildBundleForSignal(edb, id, RETRIEVAL_CONFIG_DEV, makeRankingConfig({ topK: 1 }), { retrievedAt: RETRIEVED_AT }))!;
    expect(mirrorTargets(narrow).size).toBeLessThan(mirrorTargets(wide).size);
    const first = await persistBundle(edb, wide, { now: NOW });
    expect(first.mirror).toEqual({ inserted: mirrorTargets(wide).size, updated: 0, deleted: 0 });
    const second = await persistBundle(edb, narrow, { now: NOW });
    expect(second.mirror!.deleted).toBe(mirrorTargets(wide).size - [...mirrorTargets(wide).keys()].filter((k) => mirrorTargets(narrow).has(k)).length);
    const ids = async () => (await A.query<{ evidence_item_id: string }>(`select evidence_item_id from public.signal_evidence where signal_candidate_id = '${id}' order by evidence_item_id`)).rows.map((r) => r.evidence_item_id);
    expect(await ids()).toEqual([...mirrorTargets(narrow).keys()].sort());
    const replay = await persistBundle(edb, wide, { now: NOW });
    expect(replay).toMatchObject({ created: false, bundleId: first.bundleId });
    expect(replay.mirror.inserted).toBe(mirrorTargets(wide).size - [...mirrorTargets(wide).keys()].filter((k) => mirrorTargets(narrow).has(k)).length);
    expect(await ids()).toEqual([...mirrorTargets(wide).keys()].sort());
  });

  it("is repairable from the bundle and its absence never affects the bundle", async () => {
    const id = sig("mirror");
    const latest = (await loadStoredBundle(edb, id))!;
    await A.exec(`delete from public.signal_evidence where signal_candidate_id = '${id}'`);
    expect(await count(A, `public.signal_evidence where signal_candidate_id = '${id}'`)).toBe(0);
    expect(await verifyStoredBundle(edb, latest.id)).toMatchObject({ ok: true }); // the bundle never depended on the mirror
    const fixed = await persistBundle(edb, latest.bundle, { now: NOW });
    expect(fixed.created).toBe(false);
    expect(fixed.mirror!.inserted).toBe(mirrorTargets(latest.bundle).size);
    await A.exec(`update public.signal_evidence set relevance_note = 'edited by hand' where signal_candidate_id = '${id}'`);
    const healed = await persistBundle(edb, latest.bundle, { now: NOW });
    expect(healed.mirror!.updated).toBe(mirrorTargets(latest.bundle).size);
    expect((await A.query<{ relevance_note: string }>(`select relevance_note from public.signal_evidence where signal_candidate_id = '${id}'`)).rows.every((r) => r.relevance_note.startsWith("Cited in evidence bundle"))).toBe(true);
  });

  it("is audited (the generic signal_evidence audit trigger sees inserts and deletes)", async () => {
    expect(await count(A, `public.audit_log where entity = 'signal_evidence'`)).toBeGreaterThan(0);
  });
});

describe("historical context", () => {
  it("shows superseded editions in their own section, with a successor, and never in the mirror", async () => {
    const id = await newSignal(A, "history");
    const b = (await buildBundleForSignal(edb, id, RETRIEVAL_CONFIG_DEV, makeRankingConfig({ topK: 40 }), { retrievedAt: RETRIEVED_AT }))!;
    expect(b.historical_context.length).toBeGreaterThan(0);
    const h = b.historical_context.find((x) => x.canonical_id === "syn-ads-verification-guidance-2022")!;
    expect(h.relation.status).toBe("superseded");
    expect(h.relation.superseded_by).toEqual(["syn-ads-verification-guidance-2025"]);
    const p = await persistBundle(edb, b, { now: NOW });
    const items = (await A.query<{ facet: string; citation_id: string }>(`select facet, citation_id from public.evidence_bundle_items where bundle_id = '${p.bundleId}'`)).rows;
    const hist = new Set(b.historical_context.map((x) => x.citation_id));
    for (const i of items.filter((x) => hist.has(x.citation_id))) expect(i.facet).toBe("historical_context");
    expect(items.filter((x) => x.facet === "historical_context").length).toBe(hist.size);
    expect(await verifyStoredBundle(edb, p.bundleId)).toMatchObject({ ok: true });
    const mirror = (await A.query<{ evidence_item_id: string }>(`select evidence_item_id from public.signal_evidence where signal_candidate_id = '${id}'`)).rows.map((r) => r.evidence_item_id);
    expect(mirror).not.toContain(h.evidence_item_id);
    expect((await loadStoredBundle(edb, id))!.bundle.historical_context).toEqual(b.historical_context);
  });

  it("the default configuration shows none, and says why in the exclusion log", () => {
    expect(bundle.historical_context).toEqual([]);
    expect(bundle.excluded.some((e) => e.section === "historical_context" && e.reason === "superseded")).toBe(true);
  });
});

describe("determinism across databases", () => {
  it("a database loaded in another order, with other ids, gives the same bundle content and the same fallback text", async () => {
    const B = await freshEvidenceDb();
    await ingestInOrder(B, shuffle(built.prepared, 424242));
    const eb = pgliteEvidenceDb(B);
    const act = await ingestCorpus(eb, built.prepared, { corpusName: "jansanket-dev-corpus", now: NOW, activate: true });
    expect(act.ok).toBe(true);
    await insertSignal(B, { id: SIGNAL });
    const fromB = (await buildBundleForSignal(eb, SIGNAL, RETRIEVAL_CONFIG_DEV, undefined, { retrievedAt: RETRIEVED_AT }))!;
    const idsOf = (x: EvidenceBundle) => new Set(x.citations.map((c) => c.chunk_id));
    expect([...idsOf(fromB)].some((c) => idsOf(bundle).has(c))).toBe(false); // genuinely different ids
    expect(fromB.corpus.corpus_hash).toBe(bundle.corpus.corpus_hash);
    expect(fromB.corpus.corpus_digest).toBe(bundle.corpus.corpus_digest);
    expect(fromB.provenance).toEqual(bundle.provenance);
    expect(normalised(fromB, await dbSurrogates(B))).toBe(normalised(bundle, await dbSurrogates(A)));
    expect(await fallbackSha(eb, fromB)).toBe(GOLDEN_FALLBACK_SHA);
    expect(await fallbackSha(edb, bundle)).toBe(GOLDEN_FALLBACK_SHA);
  }, 300_000);
});

describe("thin and empty evidence", () => {
  let T: Db;
  let et: EvidenceDb;
  beforeAll(async () => {
    T = await freshEvidenceDb();
    et = pgliteEvidenceDb(T);
    const subset = built.prepared.filter((p) => p.doc.canonical_id === CASE_DEF);
    const r = await ingestCorpus(et, subset, { corpusName: "thin", now: NOW, activate: true });
    if (!r.ok) throw new Error(r.errors.join("; "));
  }, 180_000);

  it("a single relevant document gives a thin bundle that says so and persists completely", async () => {
    await insertSignal(T, { id: SIGNAL });
    const b = (await buildBundleForSignal(et, SIGNAL, RETRIEVAL_CONFIG_DEV, undefined, { retrievedAt: RETRIEVED_AT }))!;
    expect(b.stats.selected_documents).toBe(1);
    const p = await persistBundle(et, b, { now: NOW });
    const out = (await T.query<{ output: { thin: boolean; text: string } }>(`select output from public.generated_explanations where id = '${p.explanationId}'`)).rows[0].output;
    expect(out.thin).toBe(true);
    expect(out.text).toMatch(/Limited evidence: only \d+ passage\(s\) from 1 document\(s\)/);
    expect(b.gaps.length).toBeGreaterThan(0);
    for (const g of b.gaps) expect(out.text).toContain(`- ${g.message}`);
    expect(await verifyStoredBundle(et, p.bundleId)).toMatchObject({ ok: true });
  });

  it("evidence for a different syndrome is not offered: the bundle is empty, says no eligible evidence, and persists", async () => {
    const other = SYNDROMES.find((s) => s !== makeFacts().syndrome)!;
    const id = sig("empty");
    await insertSignal(T, { id, syndrome: other });
    const b = (await buildBundleForSignal(et, id, RETRIEVAL_CONFIG_DEV, undefined, { retrievedAt: RETRIEVED_AT }))!;
    expect(b.citations).toEqual([]);
    expect(b.facets.map((f) => f.name)).toHaveLength(4);
    expect(b.facets.every((f) => f.items.length === 0)).toBe(true);
    expect(b.gaps.map((g) => g.code)).toContain("no_eligible_evidence");
    const p = await persistBundle(et, b, { now: NOW });
    expect(p).toMatchObject({ created: true, items: 0, explanationCreated: true });
    expect(await shape(T, id)).toEqual({ runs: 1, bundles: 1, items: 0, explanations: 1, citations: 0, mirror: 0 });
    const out = (await T.query<{ output: { thin: boolean; points: unknown[]; text: string } }>(`select output from public.generated_explanations where id = '${p.explanationId}'`)).rows[0].output;
    expect(out).toMatchObject({ thin: true, points: [] });
    expect(out.text).toContain("No eligible evidence was selected for this signal, so there is nothing to quote.");
    expect(out.text).not.toMatch(/\[E\d+\]/);
    expect(await verifyStoredBundle(et, p.bundleId)).toEqual({ ok: true, problems: [], stale: [] });
  });
});

describe("curator-tagged conflicts", () => {
  let C: Db;
  let ec: EvidenceDb;
  let untaggedBundleId = "";
  const open = makeRankingConfig({ relevanceFloor: 0 });
  beforeAll(async () => {
    C = await freshEvidenceDb();
    ec = pgliteEvidenceDb(C);
    const r = await ingestCorpus(ec, built.prepared.filter((p) => PAIR.includes(p.doc.canonical_id)), { corpusName: "pair", now: NOW, activate: true });
    if (!r.ok) throw new Error(r.errors.join("; "));
    await insertSignal(C, { id: SIGNAL });
  }, 180_000);

  it("untagged opposing wording is not reported as a conflict", async () => {
    const b = (await buildBundleForSignal(ec, SIGNAL, RETRIEVAL_CONFIG_DEV, open, { retrievedAt: RETRIEVED_AT }))!;
    expect(b.citations.length).toBeGreaterThan(0);
    expect(b.conflicts).toEqual([]);
  });

  it("tags set by a curator are persisted exactly as curator-tagged conflicts, and the older bundle stays untouched", async () => {
    const before = (await buildBundleForSignal(ec, SIGNAL, RETRIEVAL_CONFIG_DEV, open, { retrievedAt: RETRIEVED_AT }))!;
    const p0 = await persistBundle(ec, before, { now: NOW });
    untaggedBundleId = p0.bundleId;
    await C.exec(`update public.evidence_items set question_key = 'reporting_deadline', "position" = 'within_24_hours' where canonical_id = '${PAIR[0]}'`);
    await C.exec(`update public.evidence_items set question_key = 'reporting_deadline', "position" = 'within_72_hours' where canonical_id = '${PAIR[1]}'`);
    const tagged = (await buildBundleForSignal(ec, SIGNAL, RETRIEVAL_CONFIG_DEV, open, { retrievedAt: RETRIEVED_AT }))!;
    expect(tagged.bundle_hash).not.toBe(before.bundle_hash);
    expect(tagged.provenance.retrieval_result_hash).toBe(before.provenance.retrieval_result_hash); // tags never change retrieval
    expect(tagged.conflicts).toHaveLength(1);
    expect(tagged.conflicts[0]).toMatchObject({ kind: "curator_tagged_conflict", question_key: "reporting_deadline", basis: "curator_tags" });
    expect(tagged.conflicts[0].positions.map((x) => x.position)).toEqual(["within_24_hours", "within_72_hours"]);
    const cited = new Set(tagged.citations.map((c) => c.citation_id));
    const conflictCitations = tagged.conflicts[0].positions.flatMap((x) => x.documents.flatMap((d) => d.citation_ids));
    expect(conflictCitations.length).toBeGreaterThanOrEqual(2);
    for (const id of conflictCitations) expect(cited.has(id)).toBe(true);
    const p1 = await persistBundle(ec, tagged, { now: NOW });
    expect(p1.bundleId).not.toBe(p0.bundleId);
    const stored = (await loadStoredBundle(ec, SIGNAL))!;
    expect(stored.conflictCount).toBe(1);
    expect(stored.bundle.conflicts).toEqual(tagged.conflicts);
    expect(((await ec.select("evidence_bundles", { id: p0.bundleId }, ["conflict_count"]))[0].conflict_count)).toBe(0);
    const text = (await C.query<{ output: { text: string } }>(`select output from public.generated_explanations where id = '${p1.explanationId}'`)).rows[0].output.text;
    expect(text).toContain("Conflicting positions (reported only where curators tagged documents to the same question)");
    expect(await verifyStoredBundle(ec, p0.bundleId)).toMatchObject({ ok: true });
    expect(await verifyStoredBundle(ec, p1.bundleId)).toMatchObject({ ok: true });
  });

  it("clearing the tags returns to the earlier content: dedup reuses that bundle, the tagged one is kept, and the mirror follows the current state", async () => {
    const tagged = (await loadStoredBundle(ec, SIGNAL))!;
    expect(tagged.conflictCount).toBe(1);
    await C.exec(`update public.evidence_items set question_key = null, "position" = null`);
    const cleared = (await buildBundleForSignal(ec, SIGNAL, RETRIEVAL_CONFIG_DEV, open, { retrievedAt: RETRIEVED_AT }))!;
    expect(cleared.conflicts).toEqual([]);
    const p = await persistBundle(ec, cleared, { now: NOW });
    expect(p).toMatchObject({ created: false, bundleId: untaggedBundleId }); // identical content, identical hash: nothing new is written
    expect(await count(C, `public.evidence_bundles where signal_candidate_id = '${SIGNAL}'`)).toBe(2);
    expect((await loadStoredBundle(ec, SIGNAL, cleared.bundle_hash))!.conflictCount).toBe(0);
    expect((await loadStoredBundle(ec, SIGNAL, tagged.bundleHash))!.bundle.conflicts).toHaveLength(1);
    const mirror = (await C.query<{ evidence_item_id: string }>(`select evidence_item_id from public.signal_evidence where signal_candidate_id = '${SIGNAL}'`)).rows.map((r) => r.evidence_item_id).sort();
    expect(mirror).toEqual([...mirrorTargets(cleared).keys()].sort());
  });
});

describe("verification detects tampering and staleness", () => {
  let T: Db;
  let et: EvidenceDb;
  let id: string;
  let b: EvidenceBundle;
  beforeAll(async () => {
    T = await freshEvidenceDb();
    et = pgliteEvidenceDb(T);
    const r = await ingestCorpus(et, built.prepared.filter((p) => p.doc.canonical_id === CASE_DEF), { corpusName: "verify", now: NOW, activate: true });
    if (!r.ok) throw new Error(r.errors.join("; "));
    await insertSignal(T, { id: SIGNAL });
    b = (await buildBundleForSignal(et, SIGNAL, RETRIEVAL_CONFIG_DEV, undefined, { retrievedAt: RETRIEVED_AT }))!;
    id = (await persistBundle(et, b, { now: NOW })).bundleId;
  }, 180_000);

  const withoutTriggers = async (table: string, fn: () => Promise<void>) => {
    await T.exec(`alter table public.${table} disable trigger user`);
    try {
      await fn();
    } finally {
      await T.exec(`alter table public.${table} enable trigger user`);
    }
  };

  it("passes when nothing changed", async () => {
    expect(await verifyStoredBundle(et, id)).toEqual({ ok: true, problems: [], stale: [] });
    expect((await verifyStoredBundle(et, "00000000-0000-0000-0000-00000000dead")).problems).toEqual(["bundle not found"]);
  });

  it("flags a stored bundle whose JSON no longer hashes to its bundle_hash", async () => {
    const fi = b.facets.findIndex((f) => f.items.length);
    await withoutTriggers("evidence_bundles", async () => {
      await T.query(`update public.evidence_bundles set bundle = jsonb_set(bundle, $1::text[], $2::jsonb) where id = $3`, [`{facets,${fi},items,0,excerpt}`, JSON.stringify("tampered"), id]);
    });
    const r = await verifyStoredBundle(et, id);
    expect(r.ok).toBe(false);
    expect(r.problems.join("|")).toContain("does not hash to bundle_hash");
    await withoutTriggers("evidence_bundles", async () => {
      await T.query(`update public.evidence_bundles set bundle = jsonb_set(bundle, $1::text[], $2::jsonb) where id = $3`, [`{facets,${fi},items,0,excerpt}`, JSON.stringify(b.facets[fi].items[0].excerpt), id]);
    });
  });

  it("flags a bundle item that was re-pointed to another chunk, or a denormalised count that was changed", async () => {
    await withoutTriggers("evidence_bundle_items", async () => {
      await T.exec(`update public.evidence_bundle_items set rank = rank + 7 where bundle_id = '${id}' and citation_id = 'E1'`);
    });
    expect((await verifyStoredBundle(et, id)).problems.join("|")).toContain("E1: stored facet/rank differs");
    await withoutTriggers("evidence_bundle_items", async () => {
      await T.exec(`update public.evidence_bundle_items set rank = rank - 7 where bundle_id = '${id}' and citation_id = 'E1'`);
    });
    await withoutTriggers("evidence_bundles", async () => {
      await T.exec(`update public.evidence_bundles set item_count = item_count + 1 where id = '${id}'`);
    });
    expect((await verifyStoredBundle(et, id)).problems.join("|")).toContain("denormalised counts differ");
    await withoutTriggers("evidence_bundles", async () => {
      await T.exec(`update public.evidence_bundles set item_count = item_count - 1 where id = '${id}'`);
    });
    expect(await verifyStoredBundle(et, id)).toMatchObject({ ok: true });
  });

  it("flags a citation row that was re-pointed to a different chunk", async () => {
    const p = plannedItems(b)[0].item;
    const other = (await T.query<{ id: string }>(`select id from public.evidence_chunks where version_id = '${p.evidence_version_id}' and id <> '${p.chunk_id}' limit 1`)).rows[0];
    expect(other).toBeTruthy();
    await withoutTriggers("evidence_bundle_items", async () => {
      await T.exec(`update public.evidence_bundle_items set chunk_id = '${other.id}' where bundle_id = '${id}' and citation_id = '${p.citation_id}'`);
    });
    const r = await verifyStoredBundle(et, id);
    expect(r.ok).toBe(false);
    expect(r.problems.join("|")).toContain(`${p.citation_id}: stored (version, chunk) differs from the bundle`);
    await withoutTriggers("evidence_bundle_items", async () => {
      await T.exec(`update public.evidence_bundle_items set chunk_id = '${p.chunk_id}' where bundle_id = '${id}' and citation_id = '${p.citation_id}'`);
    });
    expect(await verifyStoredBundle(et, id)).toMatchObject({ ok: true });
  });

  it("flags a stored chunk whose text no longer equals the bundle's excerpt", async () => {
    const chunkId = plannedItems(b)[0].item.chunk_id;
    const original = (await T.query<{ text: string }>(`select text from public.evidence_chunks where id = '${chunkId}'`)).rows[0].text;
    await withoutTriggers("evidence_chunks", async () => {
      await T.query(`update public.evidence_chunks set text = $1 where id = '${chunkId}'`, [`${original} (edited)`]);
    });
    const r = await verifyStoredBundle(et, id);
    expect(r.ok).toBe(false);
    expect(r.problems.join("|")).toMatch(/E1: excerpt is not the stored chunk text/);
    await withoutTriggers("evidence_chunks", async () => {
      await T.query(`update public.evidence_chunks set text = $1 where id = '${chunkId}'`, [original]);
    });
    expect(await verifyStoredBundle(et, id)).toMatchObject({ ok: true });
  });

  it("reports (but does not fail) citations whose source has since been withdrawn", async () => {
    await T.exec(`update public.evidence_items set status = 'withdrawn' where canonical_id = '${CASE_DEF}'`);
    const r = await verifyStoredBundle(et, id);
    expect(r.ok).toBe(true);
    expect(r.stale.length).toBeGreaterThan(0);
    expect(r.stale[0].reason).toMatch(/withdrawn/);
  });
});

describe("row-level security", () => {
  const seen = (uid: string, sql: string) => asUser(A, uid, () => run<{ n: string }>(A, sql));
  const counts = async (uid: string) => ({
    runs: Number((await seen(uid, `select count(*)::text n from public.retrieval_runs where signal_candidate_id = '${SIGNAL}'`)).rows[0].n),
    bundles: Number((await seen(uid, `select count(*)::text n from public.evidence_bundles where signal_candidate_id = '${SIGNAL}'`)).rows[0].n),
    items: Number((await seen(uid, `select count(*)::text n from public.evidence_bundle_items where bundle_id = '${bundleId}'`)).rows[0].n),
    explanations: Number((await seen(uid, `select count(*)::text n from public.generated_explanations where bundle_id = '${bundleId}'`)).rows[0].n),
    citations: Number((await seen(uid, `select count(*)::text n from public.explanation_citations where explanation_id = '${persisted.explanationId}'`)).rows[0].n),
    mirror: Number((await seen(uid, `select count(*)::text n from public.signal_evidence where signal_candidate_id = '${SIGNAL}'`)).rows[0].n),
  });
  let all: Awaited<ReturnType<typeof counts>>;

  it("an administrator and the officer whose district contains the signal see the whole bundle", async () => {
    all = await counts(IDS.admin);
    expect(all).toEqual(await shape(A, SIGNAL).then((s) => ({ runs: s.runs, bundles: s.bundles, items: s.items, explanations: s.explanations, citations: s.citations, mirror: s.mirror })));
    expect(await counts(KHORDHA_OFFICER)).toEqual(all);
  });

  it("an officer in another district, an unscoped officer, a clinician and citizens see nothing of it", async () => {
    const none = { runs: 0, bundles: 0, items: 0, explanations: 0, citations: 0, mirror: 0 };
    for (const uid of [GANJAM_OFFICER, IDS.officer1, IDS.officer2, IDS.officerNoScope, IDS.clinician, IDS.citizenA, IDS.citizenB]) expect(await counts(uid), uid).toEqual(none);
  });

  it("an officer cannot read the stored bundle JSON of a signal outside their scope, by any column", async () => {
    const r = await seen(GANJAM_OFFICER, `select bundle::text as n from public.evidence_bundles`);
    expect(r.rows.filter((x) => String(x.n).includes(SIGNAL))).toEqual([]);
    expect((await seen(KHORDHA_OFFICER, `select bundle::text as n from public.evidence_bundles where id = '${bundleId}'`)).rows).toHaveLength(1);
  });

  it("no client - officer, admin or citizen - can write any bundle table; only the service connection writes", async () => {
    const inserts = [
      `insert into public.evidence_bundles (retrieval_run_id, signal_candidate_id, bundle_hash, schema_version, bundle) values ((select id from public.retrieval_runs limit 1), '${SIGNAL}', '${"9".repeat(64)}', 'evidence-bundle/1', '{}')`,
      `insert into public.retrieval_runs (signal_candidate_id, corpus_snapshot_id, retrieval_version, retrieval_config_hash, query_vocab_version, as_of_date) values ('${SIGNAL}', '${bundle.corpus.snapshot_id}', 'v', '${"9".repeat(64)}', 'v', '2025-09-07')`,
      `insert into public.evidence_bundle_items (bundle_id, evidence_version_id, chunk_id, facet, rank, citation_id) select bundle_id, evidence_version_id, chunk_id, 'case_definition', 99, 'E99' from public.evidence_bundle_items limit 1`,
      `insert into public.generated_explanations (bundle_id, provider, model, prompt_version, input_hash, status) values ('${bundleId}', 'x', 'y', 'z', '${"9".repeat(64)}', 'rejected')`,
      `insert into public.explanation_citations (explanation_id, claim_index, bundle_item_id) values ('${persisted.explanationId}', 99, (select id from public.evidence_bundle_items limit 1))`,
      `insert into public.signal_evidence (signal_candidate_id, evidence_item_id) select '${SIGNAL}', id from public.evidence_items limit 1`,
      `update public.evidence_bundles set item_count = 0`,
      `delete from public.evidence_bundles`,
      `delete from public.signal_evidence`,
    ];
    for (const uid of [KHORDHA_OFFICER, IDS.admin, IDS.citizenA]) {
      for (const sql of inserts) {
        const r = await asUser(A, uid, () => run(A, sql));
        // either an explicit privilege / RLS error, or zero rows affected - never a successful write
        expect(r.error !== undefined || r.affected === 0, `${uid}: ${sql.slice(0, 60)}`).toBe(true);
      }
    }
    expect(await shape(A, SIGNAL)).toEqual(await shape(A, SIGNAL));
    expect(await count(A, `public.evidence_bundles where signal_candidate_id = '${SIGNAL}'`)).toBe(1);
  });

  it("the raw-output table is admin-only and holds nothing for the fallback", async () => {
    expect(await count(A, `public.generated_explanation_raw`)).toBe(0);
    expect((await seen(KHORDHA_OFFICER, `select count(*)::text n from public.generated_explanation_raw`)).rows[0].n).toBe("0");
  });
});

describe("the whole database path reads evidence metadata only", () => {
  it("never leaves report, observation or personal data in any bundle table", async () => {
    const tables = ["retrieval_runs", "evidence_bundles", "evidence_bundle_items", "generated_explanations", "explanation_citations", "signal_evidence"];
    for (const t of tables) {
      const text = JSON.stringify((await A.query(`select * from public.${t}`)).rows);
      for (const leak of ["observed_value", "p_value", "patient", "phone", "latitude", "17 reports", "Human verification required"]) expect(text, `${t}: ${leak}`).not.toContain(leak);
    }
  });

  it("rejects a bundle for a signal that does not exist (foreign-key integrity)", async () => {
    const b = referenceBundle();
    const orphan = structuredClone(b);
    orphan.signal.candidate_id = "00000000-0000-0000-0000-00000000f00d";
    orphan.corpus.snapshot_id = bundle.corpus.snapshot_id;
    orphan.bundle_hash = bundleHashOf(orphan);
    await expect(persistBundle(edb, orphan, { now: NOW, resolveMetadata: () => undefined })).rejects.toThrow();
    expect(await count(A, `public.evidence_bundles where signal_candidate_id = '00000000-0000-0000-0000-00000000f00d'`)).toBe(0);
    expect(IDENTITY.detectorVersion).toBeTruthy();
  });
});
