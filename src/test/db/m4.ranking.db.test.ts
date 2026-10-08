// @vitest-environment node
// M4.3 against the REAL migrated schema (PGlite): the curator conflict columns and their constraints, ingestion of
// curator tags, and DB-backed ranking that must equal the in-memory pipeline, stay identical across row orders and
// ids, and never be wider than row-level security allows.
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseCorpusDocument } from "@/evidence/ingest/document";
import { ingestCorpus, type EvidenceDb } from "@/evidence/ingest/ingest";
import { buildCorpus } from "@/evidence/ingest/loader";
import { prepareDocument, type PreparedDocument } from "@/evidence/ingest/prepare";
import { EMPTY_ALLOWLIST } from "@/evidence/ingest/trust";
import { RETRIEVAL_CONFIG_DEV } from "@/evidence/retrieval/config";
import { loadCorpusView } from "@/evidence/retrieval/corpus";
import { loadSignalFacts } from "@/evidence/retrieval/signal";
import { historicalViewFromPrepared, makeFacts, uid, viewFromPrepared } from "@/evidence/retrieval/testkit";
import { CONTRADICTS_SIGNAL } from "@/evidence/ranking/conflicts";
import { rankForSignal, retrieveAndRank } from "@/evidence/ranking/pipeline";
import { makeRankingConfig, RANKING_CONFIG_V1 } from "@/evidence/ranking/policy";
import type { RankedEvidence } from "@/evidence/ranking/types";
import { pgliteEvidenceDb } from "./evidenceDb";
import { freshEvidenceDb, ingestInOrder, insertSignal } from "./evidenceFixture";
import { asUser, IDS, run, type Db } from "./harness";

const ROOT = process.cwd();
const built = buildCorpus(join(ROOT, "data", "evidence", "corpus"), join(ROOT, "data", "evidence", "allowlist.json"), "jansanket-dev-corpus");
const SIGNAL = makeFacts().signal_id;
const PAIR = ["syn-conflict-reporting-deadline-a", "syn-conflict-reporting-deadline-b"];
const NOW = () => "2026-01-01T00:00:00.000Z";
const sel = (r: RankedEvidence) => r.facets.map((f) => [f.facet, f.selected.map((c) => [c.canonicalId, c.chunkOrdinal, c.chunkHash, c.scoreComponents.rankScore, c.rank])]);
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
const withDoc = (prepared: PreparedDocument[], id: string, f: (d: PreparedDocument["doc"]) => PreparedDocument["doc"]) => prepared.map((p) => (p.doc.canonical_id === id ? prepareDocument(f(p.doc), EMPTY_ALLOWLIST) : p));

let A: Db;
let edb: EvidenceDb;
let baseline: RankedEvidence;

beforeAll(async () => {
  A = await freshEvidenceDb();
  edb = pgliteEvidenceDb(A);
  const r = await ingestCorpus(edb, built.prepared, { corpusName: "jansanket-dev-corpus", now: NOW });
  if (!r.ok) throw new Error(r.errors.join("; "));
  await insertSignal(A, { id: SIGNAL });
  baseline = (await rankForSignal(edb, SIGNAL, RETRIEVAL_CONFIG_DEV))!;
}, 180_000);

describe("conflict columns (migration m4_3)", () => {
  const item = async (id: string) => (await A.query<{ id: string }>(`select id from public.evidence_items where canonical_id = $1`, [id])).rows[0].id;

  it("exist on evidence_items, default to null, and are null for the whole ingested corpus", async () => {
    const r = await A.query<{ n: string }>(`select count(*)::text n from public.evidence_items where question_key is not null or "position" is not null`);
    expect(r.rows[0].n).toBe("0");
  });

  it("must be set together or not at all", async () => {
    const id = await item(PAIR[0]);
    expect((await run(A, `update public.evidence_items set question_key = 'reporting_deadline' where id = '${id}'`)).error?.message).toMatch(/evidence_items_conflict_tag_chk|check constraint/i);
    expect((await run(A, `update public.evidence_items set "position" = 'within_24_hours' where id = '${id}'`)).error?.message).toMatch(/evidence_items_conflict_tag_chk|check constraint/i);
    expect((await run(A, `update public.evidence_items set question_key = 'reporting_deadline', "position" = 'within_24_hours' where id = '${id}'`)).error).toBeUndefined();
    expect((await run(A, `update public.evidence_items set question_key = null, "position" = null where id = '${id}'`)).error).toBeUndefined();
  });

  it("accept only controlled-looking codes (no free text, no markup, no spaces)", async () => {
    const id = await item(PAIR[0]);
    for (const [q, p] of [["Has Spaces", "x"], ["ok_key", "Has Spaces"], ["<b>x</b>", "ok"], ["ab", "ok"], ["ok_key", ""], ["ok_key", "x".repeat(61)], ["UPPER", "ok"], ["ok key", "ok"]]) {
      const r = await run(A, `update public.evidence_items set question_key = $1, "position" = $2 where id = '${id}'`, [q, p]);
      expect(r.error, JSON.stringify([q, p])).toBeDefined();
    }
  });

  it("are curator metadata: only an admin can set them, and the change is audited by field name", async () => {
    const id = await item(PAIR[0]);
    const officer = await asUser(A, IDS.officer1, () => run(A, `update public.evidence_items set question_key = 'reporting_deadline', "position" = 'within_24_hours' where id = '${id}'`));
    expect(officer.error?.message ?? (officer.affected === 0 ? "no rows" : "WROTE")).not.toBe("WROTE");
    const citizen = await asUser(A, IDS.citizenA, () => run(A, `update public.evidence_items set question_key = 'reporting_deadline', "position" = 'within_24_hours' where id = '${id}'`));
    expect(citizen.error?.message ?? (citizen.affected === 0 ? "no rows" : "WROTE")).not.toBe("WROTE");
    const before = Number((await A.query<{ n: string }>(`select count(*)::text n from public.audit_log where entity = 'evidence_items' and entity_id = '${id}'`)).rows[0].n);
    const admin = await asUser(A, IDS.admin, () => run(A, `update public.evidence_items set question_key = 'reporting_deadline', "position" = 'within_24_hours' where id = '${id}'`));
    expect(admin.error).toBeUndefined();
    expect(admin.affected).toBe(1);
    const after = (await A.query<{ metadata: unknown }>(`select metadata from public.audit_log where entity = 'evidence_items' and entity_id = '${id}' order by created_at desc, id desc limit 1`)).rows[0];
    expect(Number((await A.query<{ n: string }>(`select count(*)::text n from public.audit_log where entity = 'evidence_items' and entity_id = '${id}'`)).rows[0].n)).toBe(before + 1);
    expect(JSON.stringify(after.metadata)).toMatch(/question_key/);
    await A.exec(`update public.evidence_items set question_key = null, "position" = null where id = '${id}'`);
  });

  it("are not selected by the M4.2 retrieval digest, so tagging never changes a retrieval result", async () => {
    const before = (await loadCorpusView(edb)).items.find((i) => i.canonicalId === PAIR[0])!;
    expect(before.questionKey).toBeNull();
    const id = await item(PAIR[0]);
    await A.exec(`update public.evidence_items set question_key = 'reporting_deadline', "position" = 'within_24_hours' where id = '${id}'`);
    const tagged = (await loadCorpusView(edb)).items.find((i) => i.canonicalId === PAIR[0])!;
    expect(tagged).toMatchObject({ questionKey: "reporting_deadline", position: "within_24_hours" });
    const r = (await rankForSignal(edb, SIGNAL, RETRIEVAL_CONFIG_DEV))!;
    expect(r.retrieval.resultHash).toBe(baseline.retrieval.resultHash);
    await A.exec(`update public.evidence_items set question_key = null, "position" = null where id = '${id}'`);
  });
});

describe("ingestion of curator tags", () => {
  it("writes tags from a document file, is idempotent, and propagates a curator's change", async () => {
    const D = await freshEvidenceDb();
    const e = pgliteEvidenceDb(D);
    const tagged = (a: string, b: string) =>
      withDoc(withDoc(built.prepared, PAIR[0], (d) => ({ ...d, question_key: "reporting_deadline", position: a })), PAIR[1], (d) => ({ ...d, question_key: "reporting_deadline", position: b }));
    const first = await ingestCorpus(e, tagged("within_24_hours", "within_72_hours"), { corpusName: "t", now: NOW });
    expect(first.ok).toBe(true);
    const rows = (await D.query<{ canonical_id: string; question_key: string; position: string }>(`select canonical_id, question_key, "position" as position from public.evidence_items where question_key is not null order by canonical_id`)).rows;
    expect(rows).toEqual([
      { canonical_id: PAIR[0], question_key: "reporting_deadline", position: "within_24_hours" },
      { canonical_id: PAIR[1], question_key: "reporting_deadline", position: "within_72_hours" },
    ]);
    const again = await ingestCorpus(e, tagged("within_24_hours", "within_72_hours"), { corpusName: "t", now: NOW });
    expect(again.documents.filter((d) => d.actions.length)).toEqual([]);
    const changed = await ingestCorpus(e, tagged("within_24_hours", "within_48_hours"), { corpusName: "t", now: NOW });
    expect(changed.documents.find((d) => d.canonical_id === PAIR[1])!.actions).toEqual(["metadata:position"]);
    expect((await D.query<{ position: string }>(`select "position" as position from public.evidence_items where canonical_id = '${PAIR[1]}'`)).rows[0].position).toBe("within_48_hours");
  }, 180_000);

  it("rejects half a tag, or an uncontrolled-looking tag, in a document file", () => {
    const doc = built.prepared.find((p) => p.doc.canonical_id === PAIR[0])!.doc;
    expect(parseCorpusDocument({ ...doc, question_key: "reporting_deadline", position: null }).errors.join()).toMatch(/set together/);
    expect(parseCorpusDocument({ ...doc, question_key: null, position: "within_24_hours" }).errors.join()).toMatch(/set together/);
    expect(parseCorpusDocument({ ...doc, question_key: "Has Spaces", position: "ok" }).errors.join()).toMatch(/question_key/);
    expect(parseCorpusDocument({ ...doc, question_key: "reporting_deadline", position: "within_24_hours" }).errors).toEqual([]);
  });

  it("leaves the hash of every untagged document unchanged and changes it for a tagged one", () => {
    const base = built.prepared.find((p) => p.doc.canonical_id === PAIR[0])!;
    const tagged = prepareDocument({ ...base.doc, question_key: "reporting_deadline", position: "within_24_hours" }, EMPTY_ALLOWLIST);
    expect(prepareDocument(base.doc, EMPTY_ALLOWLIST).metadataHash).toBe(base.metadataHash);
    expect(tagged.metadataHash).not.toBe(base.metadataHash);
    expect(tagged.contentHash).toBe(base.contentHash); // tags are metadata, not content
  });
});

describe("DB-backed ranking equals the in-memory pipeline", () => {
  it("produces the same retrieval provenance, selected evidence, components, exclusions, gaps and ranking hash", () => {
    const mem = retrieveAndRank({ facts: makeFacts(), view: viewFromPrepared(), historicalView: historicalViewFromPrepared(), retrievalConfig: RETRIEVAL_CONFIG_DEV });
    expect(baseline.retrieval).toEqual(mem.retrieval);
    expect(sel(baseline)).toEqual(sel(mem));
    expect(baseline.exclusions.counts).toEqual(mem.exclusions.counts);
    expect(baseline.gaps).toEqual(mem.gaps);
    expect(baseline.rankingHash).toBe(mem.rankingHash);
    expect(baseline.ranking.configHash).toBe(mem.ranking.configHash);
  });

  it("leaves the M4.2 reference retrieval result unchanged", () => {
    expect(baseline.retrieval.resultHash).toBe("fa55022a2264168cc0ac30878313a1e6438e818156aa30d517f3c08dbadedd5a");
    expect(baseline.retrieval.queryHash).toBe("e2cc3e663c47c5b585f85685408e6641477d1e8c53d1d97a4707b4aba9bd9f76");
  });

  it("records real database ids on candidates and a complete, reasoned exclusion log", () => {
    const c = baseline.facets[0].selected[0];
    for (const id of [c.evidenceItemId, c.evidenceVersionId, c.chunkId]) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(baseline.exclusions.ranking.length).toBeGreaterThan(30);
    expect(baseline.exclusions.ranking.every((e) => e.reason && e.family && e.detail.message)).toBe(true);
    expect(baseline.gaps.map((g) => g.code)).toEqual(["only_synthetic_evidence"]);
  });
});

describe("determinism against the database", () => {
  it("returns byte-identical results (ids included) on repeated runs", async () => {
    const text = JSON.stringify(baseline);
    for (let i = 0; i < 4; i += 1) expect(JSON.stringify(await rankForSignal(edb, SIGNAL, RETRIEVAL_CONFIG_DEV))).toBe(text);
  });

  it("is identical when the corpus was inserted in a different order, with different ids", async () => {
    const B = await freshEvidenceDb();
    await ingestInOrder(B, shuffle(built.prepared, 424242));
    await insertSignal(B, { id: SIGNAL });
    const fromB = (await rankForSignal(pgliteEvidenceDb(B), SIGNAL, RETRIEVAL_CONFIG_DEV))!;
    const ids = (r: RankedEvidence) => new Set(r.facets.flatMap((f) => f.selected.map((c) => c.chunkId)));
    expect([...ids(fromB)].some((id) => ids(baseline).has(id))).toBe(false);
    expect(sel(fromB)).toEqual(sel(baseline));
    expect(fromB.rankingHash).toBe(baseline.rankingHash);
  }, 240_000);

  it("is unchanged after the rows are physically rewritten", async () => {
    const C = await freshEvidenceDb();
    const e = pgliteEvidenceDb(C);
    await ingestCorpus(e, built.prepared, { corpusName: "jansanket-dev-corpus", now: NOW });
    await insertSignal(C, { id: SIGNAL });
    const before = (await rankForSignal(e, SIGNAL, RETRIEVAL_CONFIG_DEV))!;
    await C.exec(`update public.evidence_items set title = title`);
    expect(JSON.stringify(await rankForSignal(e, SIGNAL, RETRIEVAL_CONFIG_DEV))).toBe(JSON.stringify(before));
  }, 180_000);
});

describe("lifecycle, conflicts and historical context against real rows", () => {
  it("a curator's tags on the pair produce a conflict, and clearing them removes it", async () => {
    const E = await freshEvidenceDb();
    const e = pgliteEvidenceDb(E);
    const subset = built.prepared.filter((p) => PAIR.includes(p.doc.canonical_id));
    expect((await ingestCorpus(e, subset, { corpusName: "pair", now: NOW })).ok).toBe(true);
    await insertSignal(E, { id: SIGNAL });
    const open = makeRankingConfig({ relevanceFloor: 0 });
    const none = (await rankForSignal(e, SIGNAL, RETRIEVAL_CONFIG_DEV, open))!;
    expect(none.facets.flatMap((f) => f.selected).map((c) => c.canonicalId)).toEqual(expect.arrayContaining(PAIR));
    expect(none.conflicts).toEqual([]); // untagged: no conflict is guessed from the opposing wording
    await E.exec(`update public.evidence_items set question_key = 'reporting_deadline', "position" = 'within_24_hours' where canonical_id = '${PAIR[0]}'`);
    await E.exec(`update public.evidence_items set question_key = 'reporting_deadline', "position" = 'within_72_hours' where canonical_id = '${PAIR[1]}'`);
    const some = (await rankForSignal(e, SIGNAL, RETRIEVAL_CONFIG_DEV, open))!;
    expect(some.conflicts).toHaveLength(1);
    expect(some.conflicts[0].positions.map((p) => p.position)).toEqual(["within_24_hours", "within_72_hours"]);
    expect(some.retrieval.resultHash).toBe(none.retrieval.resultHash);
    await E.exec(`update public.evidence_items set question_key = null, "position" = null`);
    expect((await rankForSignal(e, SIGNAL, RETRIEVAL_CONFIG_DEV, open))!.conflicts).toEqual([]);
  }, 180_000);

  it("a contradiction tag surfaces a gap and keeps the evidence in the list", async () => {
    const F = await freshEvidenceDb();
    const e = pgliteEvidenceDb(F);
    await ingestCorpus(e, built.prepared, { corpusName: "jansanket-dev-corpus", now: NOW });
    await insertSignal(F, { id: SIGNAL });
    await F.exec(`update public.evidence_items set question_key = 'alternative_explanation', "position" = '${CONTRADICTS_SIGNAL}' where canonical_id = 'syn-ads-case-definition'`);
    const r = (await rankForSignal(e, SIGNAL, RETRIEVAL_CONFIG_DEV))!;
    expect(r.gaps.find((g) => g.code === "contradicting_evidence")!.message).toMatch(/syn-ads-case-definition/);
    expect(r.facets.find((f) => f.facet === "case_definition")!.selected.map((c) => c.canonicalId)).toContain("syn-ads-case-definition");
  }, 180_000);

  it("shows the superseded edition in historical context only when its successor is selected", async () => {
    const wide = makeRankingConfig({ topK: 40 });
    const withSuccessor = (await rankForSignal(edb, SIGNAL, RETRIEVAL_CONFIG_DEV, wide))!;
    const h = withSuccessor.historicalContext.filter((x) => x.canonicalId === "syn-ads-verification-guidance-2022");
    expect(h.length).toBeGreaterThan(0);
    expect(h[0].relation).toEqual({ status: "superseded", supersededBy: ["syn-ads-verification-guidance-2025"] });
    expect(baseline.historicalContext.filter((x) => x.canonicalId === "syn-ads-verification-guidance-2022")).toEqual([]);
    expect(baseline.exclusions.ranking.some((e) => e.section === "historical_context" && e.reason === "superseded")).toBe(true);
  });

  it("a quarantined or withdrawn document in the database never reaches the ranking", async () => {
    const G = await freshEvidenceDb();
    const e = pgliteEvidenceDb(G);
    await ingestCorpus(e, built.prepared, { corpusName: "jansanket-dev-corpus", now: NOW });
    await insertSignal(G, { id: SIGNAL });
    const ids = async () => new Set((await rankForSignal(e, SIGNAL, RETRIEVAL_CONFIG_DEV))!.facets.flatMap((f) => f.selected.map((c) => c.canonicalId)));
    expect(await ids()).toContain("syn-ads-case-definition");
    await G.exec(`update public.evidence_items set status = 'quarantined' where canonical_id = 'syn-ads-case-definition'`);
    expect(await ids()).not.toContain("syn-ads-case-definition");
  }, 180_000);

  it("a Ganjam signal and a signal in another state obey the geography rules with real region rows", async () => {
    const H = await freshEvidenceDb();
    const e = pgliteEvidenceDb(H);
    await ingestCorpus(e, built.prepared, { corpusName: "jansanket-dev-corpus", now: NOW });
    const ganjam = uid("signal:ganjam");
    await insertSignal(H, { id: ganjam, regionId: "00000000-0000-0000-0000-000000009107", involved: [{ id: "00000000-0000-0000-0000-000000009107", name: "Aska" }] });
    const rg = (await rankForSignal(e, ganjam, RETRIEVAL_CONFIG_DEV))!;
    const names = new Set(rg.facets.flatMap((f) => f.selected.map((c) => c.canonicalId)));
    expect(names.has("syn-khordha-response-contacts")).toBe(false);
    const elsewhere = uid("signal:elsewhere");
    await insertSignal(H, { id: elsewhere, regionId: "00000000-0000-0000-0000-000000009109", involved: [], components: { involvedBlocks: 0, blocksInDistrict: 0 } });
    const re = (await rankForSignal(e, elsewhere, RETRIEVAL_CONFIG_DEV))!;
    expect(re.gaps.find((g) => g.code === "missing_local_evidence")!.message).toBe("no state-level / district-level evidence for Elsewhere District, Elsewhere State");
    for (const f of re.facets) for (const c of f.selected) expect(["national", "regional", "global"]).toContain(c.scoreComponents.geoFactor.evidenceScope);
  }, 180_000);
});

describe("ranking never widens visibility (row-level security)", () => {
  const asUserDb = (uidv: string): EvidenceDb => ({
    select: (t, m, c) => asUser(A, uidv, () => edb.select(t, m, c)),
    insert: () => Promise.reject(new Error("no writes")),
    update: () => Promise.reject(new Error("no writes")),
  });

  it("an officer-level reader gets the same selected evidence as the service reader", async () => {
    const facts = (await loadSignalFacts(edb, SIGNAL))!;
    const view = await loadCorpusView(asUserDb(IDS.officer1));
    const histView = await loadCorpusView(asUserDb(IDS.officer1), { textStatuses: ["superseded", "historical"] });
    const officer = retrieveAndRank({ facts, view, historicalView: histView, retrievalConfig: RETRIEVAL_CONFIG_DEV });
    expect(sel(officer)).toEqual(sel(baseline));
    expect(officer.historicalContext).toEqual([]); // RLS hides non-current documents from officers
  });

  it("a citizen-level reader gets nothing, and says so as gaps", async () => {
    const facts = (await loadSignalFacts(edb, SIGNAL))!;
    const view = await loadCorpusView(asUserDb(IDS.citizenA));
    const r = retrieveAndRank({ facts, view, retrievalConfig: RETRIEVAL_CONFIG_DEV });
    for (const f of r.facets) expect(f.selected).toEqual([]);
    expect(r.gaps[0].code).toBe("no_eligible_evidence");
  });
});

describe("the default policy is what is documented", () => {
  it("uses the published ladder, geography table, age buckets, diversity limits and top-K", () => {
    expect(RANKING_CONFIG_V1.classFactor.table.national_government_health_agency).toBe(0.95);
    expect(RANKING_CONFIG_V1.selection.topKPerFacet).toBe(5);
    expect(baseline.facets.every((f) => f.selected.length <= 5)).toBe(true);
  });
});
