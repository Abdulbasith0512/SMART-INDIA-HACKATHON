// Information-retrieval metrics, defined explicitly. A "unit" is one (scenario, facet). For a unit:
//
//   R         the number of chunks judged relevant (grade >= 1) in that scenario's corpus. The pool of judged chunks is the
//             hand-authored reference judgments (synthetic_reference_judgment); unlisted chunks are grade 0.
//   list      the ranked chunks the system returned for the unit, best first. Two lists are evaluated: the M4.2 RETRIEVAL
//             candidates (every eligible lexical match, in BM25 order) and the M4.3 FINAL selection (at most 5 per facet).
//
//   Recall@k      (relevant chunks among the first k) / R.                      Undefined (null) when R = 0.
//   CappedRecall@5  (relevant chunks among the first 5) / min(R, 5): recall measured against what a list of 5 could possibly contain, because
//                 Recall@5 can never exceed 5/R when R > 5. Descriptive companion to Recall@5. Undefined (null) when R = 0.
//   Precision@k   (relevant chunks among the first k) / (chunks returned in the first k).
//                 Divides by what was returned, not by k, so an honest short list is not punished; abstention is measured
//                 separately. Undefined (null) when nothing was returned.
//   MRR           1 / (rank of the first relevant chunk); 0 when relevant chunks exist but none was returned.
//                 Undefined (null) when R = 0.
//   nDCG@k        DCG@k / IDCG@k with linear gain = grade (0/1/2) and discount 1/log2(rank+1). IDCG uses the best possible
//                 ordering of ALL judged chunks. Undefined (null) when IDCG = 0 (R = 0).
//
// Per-facet and overall figures are MACRO averages over scenarios: each scenario contributes its value (for overall, the mean of
// its defined facet values) once, so a scenario with many chunks does not outweigh one with few. Units where the metric is
// undefined are excluded from the mean and counted in n_undefined; they are never treated as 0 or 1.
import { QUERY_FACETS, type QueryFacet } from "../vocab";
import { meanStat, round6, type MeanStat } from "./stats";
import type { Grade } from "./types";

export interface RankedGrade {
  key: string;
  grade: Grade;
}

const discount = (rank1: number): number => 1 / Math.log2(rank1 + 1);

export function recallAtK(list: readonly RankedGrade[], k: number, relevantTotal: number): number | null {
  if (relevantTotal === 0) return null;
  return round6(list.slice(0, k).filter((x) => x.grade >= 1).length / relevantTotal);
}

export function cappedRecallAtK(list: readonly RankedGrade[], k: number, relevantTotal: number): number | null {
  if (relevantTotal === 0) return null;
  return round6(list.slice(0, k).filter((x) => x.grade >= 1).length / Math.min(relevantTotal, k));
}

export function precisionAtK(list: readonly RankedGrade[], k: number): number | null {
  const top = list.slice(0, k);
  if (top.length === 0) return null;
  return round6(top.filter((x) => x.grade >= 1).length / top.length);
}

export function reciprocalRank(list: readonly RankedGrade[], relevantTotal: number): number | null {
  if (relevantTotal === 0) return null;
  const i = list.findIndex((x) => x.grade >= 1);
  return i < 0 ? 0 : round6(1 / (i + 1));
}

export function ndcgAtK(list: readonly RankedGrade[], k: number, judgedGrades: readonly number[]): number | null {
  const ideal = [...judgedGrades].filter((g) => g > 0).sort((a, b) => b - a).slice(0, k);
  const idcg = ideal.reduce((s, g, i) => s + g * discount(i + 1), 0);
  if (idcg === 0) return null;
  const dcg = list.slice(0, k).reduce((s, x, i) => s + x.grade * discount(i + 1), 0);
  return round6(dcg / idcg);
}

export const IR_METRICS = ["recall_at_5", "capped_recall_at_5", "recall_at_10", "precision_at_5", "mrr", "ndcg_at_10"] as const;
export type IrMetric = (typeof IR_METRICS)[number];
export type IrValues = Record<IrMetric, number | null>;

export interface UnitInput {
  list: readonly RankedGrade[];
  /** Grades of every judged chunk for the unit (including those not returned), for R and IDCG. */
  judgedGrades: readonly number[];
}

export function irValues(u: UnitInput): IrValues & { relevant: number; returned: number } {
  const relevant = u.judgedGrades.filter((g) => g >= 1).length;
  return {
    relevant,
    returned: u.list.length,
    recall_at_5: recallAtK(u.list, 5, relevant),
    capped_recall_at_5: cappedRecallAtK(u.list, 5, relevant),
    recall_at_10: recallAtK(u.list, 10, relevant),
    precision_at_5: precisionAtK(u.list, 5),
    mrr: reciprocalRank(u.list, relevant),
    ndcg_at_10: ndcgAtK(u.list, 10, u.judgedGrades),
  };
}

export type IrSummary = Record<IrMetric, MeanStat>;
export interface IrReport {
  per_facet: Record<QueryFacet, IrSummary>;
  overall: IrSummary;
}

const defined = (xs: ReadonlyArray<number | null>): number[] => xs.filter((x): x is number => x !== null);

/** `byScenario[i][facet]` is that scenario's unit values for the facet. */
export function summariseIr(byScenario: ReadonlyArray<Record<QueryFacet, IrValues>>, seedPrefix: string): IrReport {
  const perFacet = {} as Record<QueryFacet, IrSummary>;
  for (const f of QUERY_FACETS) {
    perFacet[f] = Object.fromEntries(IR_METRICS.map((m) => [m, meanStat(byScenario.map((s) => s[f][m]), `${seedPrefix}|${f}|${m}`)])) as IrSummary;
  }
  const overall = Object.fromEntries(
    IR_METRICS.map((m) => {
      const perScenario = byScenario.map((s) => {
        const vals = defined(QUERY_FACETS.map((f) => s[f][m]));
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      });
      return [m, meanStat(perScenario, `${seedPrefix}|overall|${m}`)];
    }),
  ) as IrSummary;
  return { per_facet: perFacet, overall };
}
