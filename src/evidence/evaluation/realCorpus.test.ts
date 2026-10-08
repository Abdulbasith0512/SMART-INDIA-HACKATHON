// @vitest-environment node
// The real-corpus boundary: nothing counts as a real-corpus evaluation until the human prerequisites are attested.
import { describe, expect, it } from "vitest";
import { REAL_CORPUS_GATE, adjudicatedJudgmentsHash, assessRealCorpus, realCorpusPackageSchema, type RealCorpusPackage } from "./realCorpus";

const FACETS = ["verification_guidance", "case_definition", "epidemiological_context", "regional_context"] as const;

/** Two raters who agree on most of `n` items. */
function pkg(o: { n?: number; disagreeEvery?: number; synthetic?: number; licence?: number; raters?: number; freeze?: boolean | string } = {}): RealCorpusPackage {
  const n = o.n ?? REAL_CORPUS_GATE.min_judged_items;
  const ids = ["rater-a", "rater-b", "rater-c"].slice(0, o.raters ?? 2);
  const judgments = Array.from({ length: n }, (_, i) => {
    const g = (i % 3) as 0 | 1 | 2;
    const grades: Record<string, 0 | 1 | 2> = {};
    ids.forEach((id, j) => (grades[id] = j === 1 && o.disagreeEvery && i % o.disagreeEvery === 0 ? (((g + 1) % 3) as 0 | 1 | 2) : g));
    return { scenario: `R${i % 7}`, facet: FACETS[i % 4], canonical_id: `doc-${i % 25}`, chunk_ordinal: Math.floor(i / 25), rater_grades: grades, adjudicated_grade: g };
  });
  const base: RealCorpusPackage = {
    schema: "m4-real-corpus-package/1",
    corpus: { corpus_id: "curated-1", corpus_hash: "a".repeat(64), curator: "curator-1", documents: 40, synthetic_documents: o.synthetic ?? 0, licence_verified_documents: o.licence ?? 40, source_verified_documents: 40 },
    raters: ids.map((id) => ({ id, qualification: "MPH, field epidemiology" })),
    judgments,
    judgments_frozen_hash: null,
  };
  if (o.freeze === false) return base;
  return { ...base, judgments_frozen_hash: typeof o.freeze === "string" ? o.freeze : adjudicatedJudgmentsHash(base) };
}

describe("real-corpus readiness", () => {
  it("is ready only when every prerequisite is attested", () => {
    const r = assessRealCorpus(pkg());
    expect(r.blockers).toEqual([]);
    expect(r.ready).toBe(true);
    expect(r.min_pairwise_kappa).toBe(1);
  });

  it("is NOT ready with a single rater", () => {
    const r = assessRealCorpus(pkg({ raters: 1 }));
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/1 rater/);
    expect(r.blockers.join(" ")).toMatch(/inter-rater agreement cannot be computed/);
  });

  it("is NOT ready if any document is synthetic or lacks a verified licence", () => {
    expect(assessRealCorpus(pkg({ synthetic: 1 })).blockers.join(" ")).toMatch(/1 synthetic document/);
    expect(assessRealCorpus(pkg({ licence: 39 })).blockers.join(" ")).toMatch(/licence verified for 39 of 40/);
  });

  it("is NOT ready when the raters disagree too much (kappa below the floor)", () => {
    const r = assessRealCorpus(pkg({ disagreeEvery: 2 }));
    expect(r.min_pairwise_kappa!).toBeLessThan(REAL_CORPUS_GATE.min_kappa);
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/kappa/);
  });

  it("is NOT ready with too few judged items", () => {
    expect(assessRealCorpus(pkg({ n: 50 })).blockers.join(" ")).toMatch(/50 judged items/);
  });

  it("requires the adjudicated judgments to be frozen, and unchanged since", () => {
    expect(assessRealCorpus(pkg({ freeze: false })).blockers.join(" ")).toMatch(/not frozen/);
    expect(assessRealCorpus(pkg({ freeze: "b".repeat(64) })).blockers.join(" ")).toMatch(/differ from the frozen hash/);
  });

  it("rejects grades from a rater who was not declared", () => {
    const p = pkg();
    p.judgments[0].rater_grades["ghost"] = 1;
    p.judgments_frozen_hash = adjudicatedJudgmentsHash(p);
    expect(assessRealCorpus(p).blockers.join(" ")).toMatch(/undeclared rater/);
  });

  it("an invalid package is not ready and says why", () => {
    const r = assessRealCorpus({ schema: "nope" });
    expect(r.ready).toBe(false);
    expect(r.blockers[0]).toMatch(/not valid/);
  });

  it("the schema is strict about unknown fields", () => {
    expect(realCorpusPackageSchema.safeParse({ ...pkg(), extra: 1 }).success).toBe(false);
  });
});
