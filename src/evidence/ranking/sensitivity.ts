// Ranking sensitivity analysis. The class factors are POLICY CONSTANTS, so the right question is not "are they
// correct?" but "how much does the ordering of evidence move if they were a little different?". For each scenario
// the M4.2 retrieval result is computed ONCE and held fixed; only the ranking policy is perturbed.
//
// Metrics, per (scenario, facet, perturbation), comparing the perturbed ranking with the baseline:
//   tau              Kendall rank correlation of the order of all deduplicated candidates (1 = identical order;
//                    -1 = reversed; a list with fewer than two candidates is trivially 1)
//   selectedJaccard  overlap of the top-K selected sets (1 = same membership)
//   leadChanged      the first-ranked evidence is a different chunk
// Nothing here tunes a factor: the baseline is whatever policy.ts says, and the perturbations are fixed in advance.
import { hashJson } from "../hash";
import type { CorpusView } from "../retrieval/corpus";
import type { RetrievalConfig } from "../retrieval/config";
import { retrieveFromCorpus } from "../retrieval/retrieve";
import type { SignalFacts } from "../retrieval/signal";
import { compareCodePoints } from "../retrieval/tokenize";
import { SOURCE_CLASS_TIERS, type SourceClass } from "../vocab";
import { comparePresentation, presentationKeyOf, rankEvidence } from "./rank";
import { makeRankingConfig, rankingConfigHash, type RankingConfig } from "./policy";
import type { RankedEvidence, RankedFacet, ScoreComponents } from "./types";

export const SENSITIVITY_SCHEMA = "ranking-sensitivity/1";

export type PerturbationFamily = "class_single_half_step" | "class_single_full_step" | "class_ladder_spacing" | "class_flat" | "relevance_floor";

export interface Perturbation {
  id: string;
  family: PerturbationFamily;
  description: string;
  config: RankingConfig;
}

export interface Scenario {
  id: string;
  facts: SignalFacts;
  view: CorpusView;
  retrievalConfig: RetrievalConfig;
}

const clip = (x: number): number => Math.round(Math.min(1, Math.max(0.05, x)) * 1000) / 1000;

/** The fixed perturbation set. No-ops (a factor already at its bound) are omitted so they cannot inflate stability. */
export function buildPerturbations(base: RankingConfig): Perturbation[] {
  const table = base.classFactor.table;
  const ranked = SOURCE_CLASS_TIERS.filter((c) => table[c] !== null) as SourceClass[];
  const out: Perturbation[] = [];
  for (const [family, delta] of [["class_single_half_step", 0.025], ["class_single_full_step", 0.05]] as const) {
    for (const c of ranked) {
      for (const sign of [1, -1]) {
        const v = clip((table[c] as number) + sign * delta);
        if (v === table[c]) continue;
        out.push({
          id: `${family}:${c}:${sign > 0 ? "+" : "-"}${delta}`, family, description: `${c} factor ${table[c]} -> ${v}`,
          config: makeRankingConfig({ classTable: { ...table, [c]: v }, relevanceFloor: base.relevance.floor }),
        });
      }
    }
  }
  for (const step of [0.025, 0.075, 0.1]) {
    const t = { ...table };
    ranked.forEach((c, i) => (t[c] = clip(1 - step * i)));
    out.push({ id: `class_ladder_spacing:${step}`, family: "class_ladder_spacing", description: `tier spacing 0.05 -> ${step}`, config: makeRankingConfig({ classTable: t, relevanceFloor: base.relevance.floor }) });
  }
  const flat = { ...table };
  for (const c of ranked) flat[c] = 1;
  out.push({ id: "class_flat", family: "class_flat", description: "all source classes weighted equally (class ladder removed)", config: makeRankingConfig({ classTable: flat, relevanceFloor: base.relevance.floor }) });
  for (const floor of [0.05, 0.2]) {
    out.push({ id: `relevance_floor:${floor}`, family: "relevance_floor", description: `relevance floor ${base.relevance.floor} -> ${floor}`, config: makeRankingConfig({ classTable: table, relevanceFloor: floor }) });
  }
  return out;
}

const ident = (c: { canonicalId: string | null; evidenceItemId: string; chunkOrdinal: number }): string => `${c.canonicalId ?? c.evidenceItemId}#${c.chunkOrdinal}`;
const SURVIVOR_REASONS = new Set(["beyond_top_k", "document_diversity", "publisher_diversity"]);

/** All candidates that survived floor and dedup, in presentation order (selected ones plus those cut by diversity / top-K). */
export function survivorOrder(f: RankedFacet): string[] {
  const rows = [
    ...f.selected.map((c) => ({ id: ident(c), key: presentationKeyOf(c, c.bm25Score, c.scoreComponents) })),
    ...f.excluded
      .filter((e) => SURVIVOR_REASONS.has(e.reason) && e.scoreComponents.rankScore !== undefined)
      .map((e) => ({ id: ident(e.candidate), key: presentationKeyOf(e.candidate, e.bm25Score, e.scoreComponents as ScoreComponents) })),
  ];
  return rows.sort((a, b) => comparePresentation(a.key, b.key)).map((r) => r.id);
}

/** Kendall's tau over the items both orders contain. Fewer than two shared items is trivially 1. */
export function kendallTau(a: readonly string[], b: readonly string[]): number {
  const common = a.filter((x) => b.includes(x));
  const pos = new Map(b.map((x, i) => [x, i]));
  const n = common.length;
  if (n < 2) return 1;
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (pos.get(common[i])! < pos.get(common[j])!) concordant += 1;
      else discordant += 1;
    }
  }
  return (concordant - discordant) / (n * (n - 1) / 2);
}

export const jaccardOfLists = (a: readonly string[], b: readonly string[]): number => {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const union = A.size + B.size - inter;
  return union === 0 ? 1 : inter / union;
};

export interface CaseResult {
  scenario: string;
  facet: string;
  perturbation: string;
  survivors: number;
  tau: number;
  selectedJaccard: number;
  selectedOrderIdentical: boolean;
  leadChanged: boolean;
  baselineLead: string | null;
  perturbedLead: string | null;
}

const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

export interface SensitivityReport {
  schema: typeof SENSITIVITY_SCHEMA;
  notice: string;
  baseline: { rankingConfigHash: string; retrievalConfigHash: string; corpusDigest: string };
  scenarios: string[];
  perturbations: Array<{ id: string; family: PerturbationFamily; description: string }>;
  totals: { cases: number; casesWithEvidence: number; emptyFacetCases: number };
  byFamily: Array<{ family: PerturbationFamily; cases: number; meanTau: number; minTau: number; meanSelectedJaccard: number; minSelectedJaccard: number; selectedOrderIdentical: number; leadChanged: number }>;
  byPerturbation: Array<{ id: string; cases: number; meanTau: number; minTau: number; minSelectedJaccard: number; leadChanged: number }>;
  leadChanges: Array<{ scenario: string; facet: string; perturbation: string; from: string | null; to: string | null }>;
  hash: string;
}

export function analyseSensitivity(scenarios: readonly Scenario[], base: RankingConfig, perturbations: readonly Perturbation[] = buildPerturbations(base)): SensitivityReport {
  const cases: Array<CaseResult & { family: PerturbationFamily }> = [];
  let corpusDigest = "";
  let retrievalHash = "";
  for (const s of scenarios) {
    const retrieval = retrieveFromCorpus(s.view, s.facts, s.retrievalConfig); // candidates are FIXED for every perturbation
    corpusDigest = retrieval.corpus.digest;
    retrievalHash = retrieval.config.hash;
    const baseline: RankedEvidence = rankEvidence({ facts: s.facts, retrieval, view: s.view, config: base });
    for (const p of perturbations) {
      const alt = rankEvidence({ facts: s.facts, retrieval, view: s.view, config: p.config });
      for (const bf of baseline.facets) {
        const af = alt.facets.find((f) => f.facet === bf.facet)!;
        const bOrder = survivorOrder(bf);
        const aOrder = survivorOrder(af);
        const bSel = bf.selected.map(ident);
        const aSel = af.selected.map(ident);
        cases.push({
          scenario: s.id, facet: bf.facet, perturbation: p.id, family: p.family, survivors: bOrder.length, tau: r6(kendallTau(bOrder, aOrder)),
          selectedJaccard: r6(jaccardOfLists(bSel, aSel)), selectedOrderIdentical: JSON.stringify(bSel) === JSON.stringify(aSel),
          leadChanged: bSel.length > 0 && aSel.length > 0 && bSel[0] !== aSel[0], baselineLead: bSel[0] ?? null, perturbedLead: aSel[0] ?? null,
        });
      }
    }
  }
  const withEvidence = cases.filter((c) => c.survivors > 0);
  const mean = (xs: number[]) => (xs.length ? r6(xs.reduce((a, b) => a + b, 0) / xs.length) : 1);
  const min = (xs: number[]) => (xs.length ? Math.min(...xs) : 1);
  const families = [...new Set(perturbations.map((p) => p.family))];
  const report: Omit<SensitivityReport, "hash"> = {
    schema: SENSITIVITY_SCHEMA,
    notice: "Class factors are policy constants, not estimates. This measures how much the ORDER of eligible evidence moves if they were slightly different; it does not validate them, and a synthetic corpus cannot show real-world robustness.",
    baseline: { rankingConfigHash: rankingConfigHash(base), retrievalConfigHash: retrievalHash, corpusDigest },
    scenarios: scenarios.map((s) => s.id),
    perturbations: perturbations.map((p) => ({ id: p.id, family: p.family, description: p.description })),
    totals: { cases: cases.length, casesWithEvidence: withEvidence.length, emptyFacetCases: cases.length - withEvidence.length },
    byFamily: families.map((family) => {
      const cs = withEvidence.filter((c) => c.family === family);
      return {
        family, cases: cs.length, meanTau: mean(cs.map((c) => c.tau)), minTau: min(cs.map((c) => c.tau)), meanSelectedJaccard: mean(cs.map((c) => c.selectedJaccard)),
        minSelectedJaccard: min(cs.map((c) => c.selectedJaccard)), selectedOrderIdentical: cs.filter((c) => c.selectedOrderIdentical).length, leadChanged: cs.filter((c) => c.leadChanged).length,
      };
    }),
    byPerturbation: perturbations.map((p) => {
      const cs = withEvidence.filter((c) => c.perturbation === p.id);
      return { id: p.id, cases: cs.length, meanTau: mean(cs.map((c) => c.tau)), minTau: min(cs.map((c) => c.tau)), minSelectedJaccard: min(cs.map((c) => c.selectedJaccard)), leadChanged: cs.filter((c) => c.leadChanged).length };
    }),
    leadChanges: withEvidence
      .filter((c) => c.leadChanged)
      .map((c) => ({ scenario: c.scenario, facet: c.facet, perturbation: c.perturbation, from: c.baselineLead, to: c.perturbedLead }))
      .sort((a, b) => compareCodePoints(`${a.scenario}|${a.facet}|${a.perturbation}`, `${b.scenario}|${b.facet}|${b.perturbation}`)),
  };
  return { ...report, hash: hashJson(report) };
}
