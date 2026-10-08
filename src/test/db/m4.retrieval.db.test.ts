// @vitest-environment node
// M4.2 retrieval against the REAL migrated schema (PGlite): a detector-shaped signal is read back, the corpus is
// loaded from the evidence tables, and the result must be identical to the in-memory pipeline, identical on
// repeated runs, identical when the same corpus was inserted in a different order (different ids, different
// physical row order), and never wider than what row-level security would show.
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ingestCorpus, type EvidenceDb } from "@/evidence/ingest/ingest";
import { buildCorpus } from "@/evidence/ingest/loader";
import { prepareDocument, type PreparedDocument } from "@/evidence/ingest/prepare";
import { EMPTY_ALLOWLIST } from "@/evidence/ingest/trust";
import { RETRIEVAL_CONFIG_DEV, RETRIEVAL_CONFIG_V1 } from "@/evidence/retrieval/config";
import { loadCorpusView } from "@/evidence/retrieval/corpus";
import { retrieveCandidates, retrieveForSignal, retrieveFromCorpus, type RetrievalResult } from "@/evidence/retrieval/retrieve";
import { loadSignalFacts } from "@/evidence/retrieval/signal";
import { makeFacts, uid, viewFromPrepared } from "@/evidence/retrieval/testkit";
import { pgliteEvidenceDb } from "./evidenceDb";
import { DBR, freshEvidenceDb, ingestInOrder, insertSignal } from "./evidenceFixture";
import { asUser, IDS, type Db } from "./harness";

const ROOT = process.cwd();
const built = buildCorpus(join(ROOT, "data", "evidence", "corpus"), join(ROOT, "data", "evidence", "allowlist.json"), "jansanket-dev-corpus");
const SIGNAL = makeFacts().signal_id; // same id as the in-memory reference signal
const facet = (r: RetrievalResult, n: string) => r.facets.find((f) => f.facet === n)!;
const sig = (r: RetrievalResult) => r.facets.map((f) => [f.facet, f.candidates.map((c) => [c.canonicalId, c.chunkOrdinal, c.chunkHash, c.bm25Score, c.rank])]);
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
const withDoc = (prepared: PreparedDocument[], id: string, f: (d: PreparedDocument["doc"]) => PreparedDocument["doc"]) =>
  prepared.map((p) => (p.doc.canonical_id === id ? prepareDocument(f(p.doc), EMPTY_ALLOWLIST) : p));

let A: Db;
let edbA: EvidenceDb;
let baseline: RetrievalResult;

beforeAll(async () => {
  A = await freshEvidenceDb();
  edbA = pgliteEvidenceDb(A);
  const r = await ingestCorpus(edbA, built.prepared, { corpusName: "jansanket-dev-corpus", now: () => "2026-01-01T00:00:00.000Z" });
  if (!r.ok) throw new Error(r.errors.join("; "));
  await insertSignal(A, { id: SIGNAL });
  baseline = (await retrieveForSignal(edbA, SIGNAL, RETRIEVAL_CONFIG_DEV))!;
}, 180_000);

describe("signal facts read back from a detector-shaped candidate", () => {
  it("projects the stored row onto the allowed facts only", async () => {
    const f = (await loadSignalFacts(edbA, SIGNAL))!;
    expect(f.signal_id).toBe(SIGNAL);
    expect(f.region).toEqual({ id: DBR.balianta, name: "Balianta", level: "block" });
    expect(f.ancestors.map((a) => [a.name, a.level])).toEqual([["Khordha", "district"], ["Odisha", "state"], ["India (synthetic)", "country"]]);
    expect(f.window).toEqual({ start: "2025-09-01", end: "2025-09-07" });
    expect(f.spread).toBe("single_block");
    expect(f.persistence).toBe("sustained");
    const text = JSON.stringify(f);
    for (const leak of ["Emerging signal", "Human verification", "p_value", "0.74", "81", "baseline", "episode"]) expect(text, leak).not.toContain(leak);
  });

  it("returns null for an unknown signal", async () => {
    expect(await loadSignalFacts(edbA, uid("signal:nowhere"))).toBeNull();
    expect(await retrieveForSignal(edbA, uid("signal:nowhere"), RETRIEVAL_CONFIG_DEV)).toBeNull();
  });
});

describe("DB-backed retrieval equals the in-memory pipeline", () => {
  it("produces the same query, candidates, scores and content-addressed result hash", () => {
    const mem = retrieveFromCorpus(viewFromPrepared(), makeFacts(), RETRIEVAL_CONFIG_DEV);
    expect(baseline.query.hash).toBe(mem.query.hash);
    expect(baseline.corpus.digest).toBe(mem.corpus.digest);
    expect(sig(baseline)).toEqual(sig(mem));
    expect(baseline.resultHash).toBe(mem.resultHash);
    expect(baseline.facets.reduce((n, f) => n + f.candidates.length, 0)).toBeGreaterThan(40);
  });

  it("carries real database ids and the exclusion log", () => {
    const c = facet(baseline, "case_definition").candidates[0];
    expect(c.canonicalId).toBe("syn-ads-case-definition");
    for (const id of [c.evidenceItemId, c.evidenceVersionId, c.chunkId]) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const ex = new Map(facet(baseline, "verification_guidance").excluded.map((e) => [e.canonicalId, e.reasons]));
    expect(ex.get("syn-adv-instruction-override")).toContain("status_not_eligible");
    expect(ex.get("syn-ads-verification-guidance-2022")).toContain("status_not_eligible");
    expect(ex.get("syn-unverified-forum-post")).toEqual(expect.arrayContaining(["source_class_excluded", "status_not_eligible"]));
  });

  it("admits no synthetic evidence under the production configuration", async () => {
    const facts = (await loadSignalFacts(edbA, SIGNAL))!;
    const prod = await retrieveCandidates(edbA, facts, RETRIEVAL_CONFIG_V1);
    expect(prod.facets.every((f) => f.candidates.length === 0)).toBe(true);
  });
});

describe("determinism against the database", () => {
  it("returns byte-identical results (including row ids) on repeated runs", async () => {
    const text = JSON.stringify(baseline);
    for (let i = 0; i < 5; i += 1) expect(JSON.stringify(await retrieveForSignal(edbA, SIGNAL, RETRIEVAL_CONFIG_DEV))).toBe(text);
  });

  it("is unchanged after the evidence rows are physically rewritten", async () => {
    const C = await freshEvidenceDb();
    const edb = pgliteEvidenceDb(C);
    await ingestCorpus(edb, built.prepared, { corpusName: "jansanket-dev-corpus", now: () => "2026-01-01T00:00:00.000Z" });
    await insertSignal(C, { id: SIGNAL });
    const before = (await retrieveForSignal(edb, SIGNAL, RETRIEVAL_CONFIG_DEV))!;
    const order = async () => (await C.query<{ canonical_id: string }>(`select canonical_id from public.evidence_items`)).rows.map((r) => r.canonical_id);
    const orderBefore = await order();
    await C.exec(`update public.evidence_items set title = title`); // every tuple is rewritten
    await C.exec(`update public.evidence_items set title = title where canonical_id like 'syn-a%'`);
    expect(await order()).not.toEqual(orderBefore); // the physical order really did change
    const after = (await retrieveForSignal(edb, SIGNAL, RETRIEVAL_CONFIG_DEV))!;
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  }, 180_000);

  it("is identical when the same corpus was inserted in a different order (different ids, different row order)", async () => {
    const B = await freshEvidenceDb();
    await ingestInOrder(B, shuffle(built.prepared, 20260707));
    await insertSignal(B, { id: SIGNAL });
    const edbB = pgliteEvidenceDb(B);
    const fromB = (await retrieveForSignal(edbB, SIGNAL, RETRIEVAL_CONFIG_DEV))!;

    const physical = async (d: Db) => (await d.query<{ canonical_id: string }>(`select canonical_id from public.evidence_items`)).rows.map((r) => r.canonical_id);
    expect(await physical(B)).not.toEqual(await physical(A)); // genuinely different insertion / physical order
    const idsA = new Set(baseline.facets.flatMap((f) => f.candidates.map((c) => c.chunkId)));
    const idsB = new Set(fromB.facets.flatMap((f) => f.candidates.map((c) => c.chunkId)));
    expect([...idsB].some((id) => idsA.has(id))).toBe(false); // different database-assigned ids

    expect(fromB.query).toEqual(baseline.query);
    expect(fromB.corpus.digest).toBe(baseline.corpus.digest);
    expect(sig(fromB)).toEqual(sig(baseline)); // same candidates, same scores, same ordering
    expect(fromB.resultHash).toBe(baseline.resultHash);
  }, 240_000);
});

describe("lifecycle changes in the database change retrieval, never the rules", () => {
  it("a document quarantined in the database stops competing; releasing it restores it", async () => {
    const D = await freshEvidenceDb();
    const edb = pgliteEvidenceDb(D);
    await ingestCorpus(edb, built.prepared, { corpusName: "jansanket-dev-corpus", now: () => "2026-01-01T00:00:00.000Z" });
    await insertSignal(D, { id: SIGNAL });
    const docs = async () => new Set(facet((await retrieveForSignal(edb, SIGNAL, RETRIEVAL_CONFIG_DEV))!, "case_definition").candidates.map((c) => c.canonicalId));
    expect(await docs()).toContain("syn-ads-case-definition");
    await D.exec(`update public.evidence_items set status = 'quarantined' where canonical_id = 'syn-ads-case-definition'`);
    expect(await docs()).not.toContain("syn-ads-case-definition");
    await D.exec(`update public.evidence_items set status = 'current' where canonical_id = 'syn-ads-case-definition'`);
    expect(await docs()).toContain("syn-ads-case-definition");
    await D.exec(`update public.evidence_items set status = 'withdrawn' where canonical_id = 'syn-ads-case-definition'`);
    expect(await docs()).not.toContain("syn-ads-case-definition");
  }, 180_000);

  it("a new version replaces the old text in results (only the current version is searched)", async () => {
    const E = await freshEvidenceDb();
    const edb = pgliteEvidenceDb(E);
    const opts = { corpusName: "jansanket-dev-corpus", now: () => "2026-01-01T00:00:00.000Z" };
    await ingestCorpus(edb, built.prepared, opts);
    await insertSignal(E, { id: SIGNAL });
    const before = facet((await retrieveForSignal(edb, SIGNAL, RETRIEVAL_CONFIG_DEV))!, "case_definition");
    const edited = withDoc(built.prepared, "syn-ads-case-definition", (d) => ({ ...d, version_label: "2", excerpts: [...d.excerpts, { text: "An added excerpt about the suspected case definition wording in version two." }] }));
    await ingestCorpus(edb, edited, opts);
    const after = facet((await retrieveForSignal(edb, SIGNAL, RETRIEVAL_CONFIG_DEV))!, "case_definition");
    const mine = (f: typeof before) => f.candidates.filter((c) => c.canonicalId === "syn-ads-case-definition");
    expect(mine(after).length).toBe(mine(before).length + 1);
    expect(mine(after).some((c) => c.text.includes("version two"))).toBe(true);
    expect(await E.query(`select count(*)::int n from public.evidence_versions where is_current and evidence_item_id = (select id from public.evidence_items where canonical_id = 'syn-ads-case-definition')`).then((r) => (r.rows[0] as { n: number }).n)).toBe(1);
    // chunks of the superseded version are not searched
    expect(new Set(mine(after).map((c) => c.evidenceVersionId)).size).toBe(1);
  }, 180_000);

  it("an active corpus snapshot is recorded in the result and changes its hash", async () => {
    const F = await freshEvidenceDb();
    const edb = pgliteEvidenceDb(F);
    await ingestCorpus(edb, built.prepared, { corpusName: "jansanket-dev-corpus", now: () => "2026-01-01T00:00:00.000Z", activate: true });
    await insertSignal(F, { id: SIGNAL });
    const r = (await retrieveForSignal(edb, SIGNAL, RETRIEVAL_CONFIG_DEV))!;
    expect(r.corpus.activeSnapshot?.corpusHash).toBe(built.manifest.corpus_hash);
    expect(r.corpus.activeSnapshot?.corpusVersion).toBe(`jansanket-dev-corpus+${built.manifest.corpus_hash.slice(0, 12)}`);
    expect(r.resultHash).not.toBe(baseline.resultHash);
    expect(sig(r)).toEqual(sig(baseline)); // same candidates; only the recorded snapshot differs
  }, 180_000);
});

describe("geography against real region rows", () => {
  it("a Ganjam signal gets Ganjam evidence and not Khordha evidence", async () => {
    const G = await freshEvidenceDb();
    const edb = pgliteEvidenceDb(G);
    await ingestCorpus(edb, built.prepared, { corpusName: "jansanket-dev-corpus", now: () => "2026-01-01T00:00:00.000Z" });
    const id = uid("signal:ganjam");
    await insertSignal(G, { id, regionId: DBR.aska, involved: [{ id: DBR.aska, name: "Aska" }] });
    const r = (await retrieveForSignal(edb, id, RETRIEVAL_CONFIG_DEV))!;
    const names = new Set(r.facets.flatMap((f) => f.candidates.map((c) => c.canonicalId)));
    expect(names.has("syn-ganjam-water-advisory")).toBe(true);
    expect(names.has("syn-khordha-response-contacts")).toBe(false);
  }, 180_000);

  it("a signal in a different state gets no state- or district-scoped Odisha evidence", async () => {
    const H = await freshEvidenceDb();
    const edb = pgliteEvidenceDb(H);
    await ingestCorpus(edb, built.prepared, { corpusName: "jansanket-dev-corpus", now: () => "2026-01-01T00:00:00.000Z" });
    const id = uid("signal:elsewhere");
    await insertSignal(H, { id, regionId: DBR.otherDistrict, involved: [], components: { involvedBlocks: 0, blocksInDistrict: 0 } });
    const r = (await retrieveForSignal(edb, id, RETRIEVAL_CONFIG_DEV))!;
    for (const f of r.facets) for (const c of f.candidates) expect(["global", "regional", "national"], `${f.facet}/${c.canonicalId}`).toContain(c.metadata.geoMatch);
    const names = new Set(r.facets.flatMap((f) => f.candidates.map((c) => c.canonicalId)));
    for (const odisha of ["syn-ads-odisha-context", "syn-odisha-wash-guidance-monsoon", "syn-khordha-response-contacts", "syn-ganjam-water-advisory"]) expect(names.has(odisha), odisha).toBe(false);
  }, 180_000);
});

describe("retrieval never widens visibility (row-level security)", () => {
  /** An EvidenceDb that runs every read as a signed-in user, so RLS applies exactly as it would for that user. */
  const asUserDb = (d: Db, uidv: string): EvidenceDb => {
    const base = pgliteEvidenceDb(d);
    return {
      select: (t, m, c) => asUser(d, uidv, () => base.select(t, m, c)),
      insert: () => Promise.reject(new Error("no writes")),
      update: () => Promise.reject(new Error("no writes")),
    };
  };

  it("an officer-level reader gets exactly the candidates a service-level reader gets (everything else is ineligible anyway)", async () => {
    const facts = (await loadSignalFacts(edbA, SIGNAL))!;
    const officer = await retrieveCandidates(asUserDb(A, IDS.officer1), facts, RETRIEVAL_CONFIG_DEV);
    expect(sig(officer)).toEqual(sig(baseline));
    // RLS hides non-current rows from the officer, so they never even reach the exclusion log
    expect(officer.corpus.documents).toBe(built.manifest.counts.by_status.current);
    expect(officer.corpus.documents).toBeLessThan(baseline.corpus.documents);
  });

  it("a citizen-level reader sees no synthetic evidence at all", async () => {
    const facts = (await loadSignalFacts(edbA, SIGNAL))!;
    const citizen = await retrieveCandidates(asUserDb(A, IDS.citizenA), facts, RETRIEVAL_CONFIG_DEV);
    expect(citizen.corpus.documents).toBe(0);
    for (const f of citizen.facets) expect(f.candidates).toEqual([]);
  });
});

describe("loading the corpus view", () => {
  it("loads text only for current documents and metadata for the rest", async () => {
    const view = await loadCorpusView(edbA);
    expect(view.items.length).toBe(60);
    for (const i of view.items) {
      if (i.status === "current") expect(i.chunks.length, i.canonicalId!).toBeGreaterThan(0);
      else expect(i.chunks, i.canonicalId!).toEqual([]);
    }
    expect(view.activeSnapshot).toBeNull();
  });

  it("returns chunks in ordinal order and dates as plain strings", async () => {
    const view = await loadCorpusView(edbA);
    for (const i of view.items) {
      expect(i.chunks.map((c) => c.ordinal)).toEqual([...i.chunks.map((c) => c.ordinal)].sort((a, b) => a - b));
      if (i.publicationDate) expect(i.publicationDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
