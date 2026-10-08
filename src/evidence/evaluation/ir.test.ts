// @vitest-environment node
// Every information-retrieval metric checked against a hand-computed value, including the edge cases the definitions promise.
import { describe, expect, it } from "vitest";
import { QUERY_FACETS } from "../vocab";
import { cappedRecallAtK, irValues, ndcgAtK, precisionAtK, recallAtK, reciprocalRank, summariseIr, type IrValues, type RankedGrade } from "./ir";

const L = (...grades: number[]): RankedGrade[] => grades.map((g, i) => ({ key: `k${i}`, grade: g as 0 | 1 | 2 }));
// returned: grades 2,0,1,0,0,1 ; judged grades of the whole pool: 2,1,1,2 (R = 4, one grade-2 chunk was never returned)
const returned = L(2, 0, 1, 0, 0, 1);
const judged = [2, 1, 1, 2];

describe("metric definitions", () => {
  it("Recall@k = relevant chunks in the first k / R", () => {
    expect(recallAtK(returned, 5, 4)).toBe(0.5);
    expect(recallAtK(returned, 10, 4)).toBe(0.75);
    expect(recallAtK(returned, 1, 4)).toBe(0.25);
  });

  it("capped Recall@5 divides by min(R, 5), so it can reach 1 when R > 5", () => {
    expect(cappedRecallAtK(returned, 5, 4)).toBe(0.5);
    expect(cappedRecallAtK(L(1, 1, 1, 1, 1), 5, 8)).toBe(1);
    expect(recallAtK(L(1, 1, 1, 1, 1), 5, 8)).toBe(0.625);
  });

  it("Precision@k divides by what was returned (an honest short list is not punished)", () => {
    expect(precisionAtK(returned, 5)).toBe(0.4);
    expect(precisionAtK(L(1, 1, 0), 5)).toBe(0.666667);
    expect(precisionAtK(L(), 5)).toBeNull();
  });

  it("MRR = 1 / rank of the first relevant chunk; 0 if relevant chunks exist but none was returned", () => {
    expect(reciprocalRank(returned, 4)).toBe(1);
    expect(reciprocalRank(L(0, 0, 1), 4)).toBe(0.333333);
    expect(reciprocalRank(L(0, 0, 0), 4)).toBe(0);
    expect(reciprocalRank(L(), 4)).toBe(0);
  });

  it("nDCG@k uses linear gain, a log2(rank+1) discount and the ideal ordering of ALL judged chunks", () => {
    const dcg = 2 / Math.log2(2) + 1 / Math.log2(4) + 1 / Math.log2(7);
    const idcg = 2 / Math.log2(2) + 2 / Math.log2(3) + 1 / Math.log2(4) + 1 / Math.log2(5);
    expect(ndcgAtK(returned, 10, judged)).toBeCloseTo(dcg / idcg, 5);
  });

  it("nDCG is 1 for the ideal ordering and lower for a worse one", () => {
    expect(ndcgAtK(L(2, 2, 1, 1), 10, judged)).toBe(1);
    expect(ndcgAtK(L(1, 1, 2, 2), 10, judged)!).toBeLessThan(1);
  });

  it("nDCG only counts the first k results", () => {
    const longList = L(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2);
    expect(ndcgAtK(longList, 10, [2])).toBe(0);
  });
});

describe("undefined metrics are null, never NaN, 0 or 1", () => {
  it("with no relevant chunk (R = 0): Recall, capped Recall, MRR and nDCG are undefined", () => {
    expect(recallAtK(L(0, 0), 5, 0)).toBeNull();
    expect(cappedRecallAtK(L(0, 0), 5, 0)).toBeNull();
    expect(reciprocalRank(L(0, 0), 0)).toBeNull();
    expect(ndcgAtK(L(0, 0), 10, [])).toBeNull();
    expect(ndcgAtK(L(0, 0), 10, [0, 0])).toBeNull();
  });

  it("irValues reports R and the number returned", () => {
    const v = irValues({ list: returned, judgedGrades: judged });
    expect(v.relevant).toBe(4);
    expect(v.returned).toBe(6);
    expect(v.recall_at_5).toBe(0.5);
    const none = irValues({ list: L(0, 1), judgedGrades: [] });
    expect(none.relevant).toBe(0);
    expect(none.recall_at_5).toBeNull();
    expect(Object.values(none).every((x) => x === null || typeof x === "number" && Number.isFinite(x))).toBe(true);
  });
});

describe("macro averaging", () => {
  const blank = (): Record<string, IrValues> =>
    Object.fromEntries(QUERY_FACETS.map((f) => [f, { recall_at_5: null, capped_recall_at_5: null, recall_at_10: null, precision_at_5: null, mrr: null, ndcg_at_10: null }]));
  it("averages per scenario first, excludes undefined units, and counts them", () => {
    const s1 = blank();
    s1.verification_guidance.recall_at_5 = 1;
    const s2 = blank();
    s2.verification_guidance.recall_at_5 = 0;
    s2.case_definition.recall_at_5 = 0.5;
    const r = summariseIr([s1, s2] as never, "t");
    expect(r.per_facet.verification_guidance.recall_at_5.mean).toBe(0.5);
    expect(r.per_facet.verification_guidance.recall_at_5.n).toBe(2);
    expect(r.per_facet.case_definition.recall_at_5.mean).toBe(0.5);
    expect(r.per_facet.case_definition.recall_at_5.n).toBe(1);
    expect(r.per_facet.case_definition.recall_at_5.n_undefined).toBe(1);
    // scenario 1 -> 1 ; scenario 2 -> mean(0, 0.5) = 0.25 ; overall = 0.625
    expect(r.overall.recall_at_5.mean).toBe(0.625);
    expect(r.overall.recall_at_5.n).toBe(2);
    expect(r.overall.mrr.mean).toBeNull();
  });
});
