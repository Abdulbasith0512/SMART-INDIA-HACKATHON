// Aggregation of per-scenario evaluations into the reported retrieval / ranking / bundle metrics. Every rate states its numerator
// k, its denominator n, and what a "unit" is. Pooled rates treat the units as independent for their exact Clopper-Pearson interval,
// which is an approximation (units within one scenario are correlated); the information-retrieval means use a scenario-level bootstrap.
import { QUERY_FACETS, type QueryFacet } from "../vocab";
import { summariseIr, type IrReport, type IrValues } from "./ir";
import type { ScenarioEval } from "./scenarioEval";
import { meanStat, rate, type MeanStat, type Rate } from "./stats";

export interface RetrievalAggregate {
  scenarios: number;
  /** M4.2 retrieval stage: every eligible lexical match, in BM25 order. */
  retrieval: IrReport;
  /** M4.3 final selection (at most 5 per facet): what the bundle presents. */
  final: IrReport;
  /** Mean number of judged-relevant chunks per unit (descriptive: when this exceeds 5, Recall@5 is capped by construction). */
  relevant_chunks_per_unit: Record<QueryFacet, MeanStat>;
  source_quality: {
    high_tier_classes: readonly string[];
    selected_from_high_tier: Rate;
    relevant_high_tier_retrieved: Rate;
    selected_that_are_relevant: Rate;
    tier_inversions: Rate;
    note: string;
  };
  geography: { local_scoped_selections_in_place: Rate };
  stale_evidence: { selected_not_in_force: Rate };
  wrong_geography: { selected_outside_the_signal_place: Rate };
  other_ineligible: { selected_unverified_other_language_or_synthetic_in_production: Rate };
  duplicates: { selected_that_duplicate_an_earlier_selection: Rate };
  filler: {
    selected_that_are_irrelevant: Rate;
    /** Of the irrelevant selections: by cause (counts sum to k above). */
    breakdown: { annotated_distractor: number; relevant_to_another_facet_or_syndrome: number; other: number };
    scenarios_presenting_an_annotated_distractor: Rate;
  };
  abstention: { no_evidence_scenarios_abstained_correctly: Rate; facets_without_relevant_evidence_left_empty: Rate };
  expectations: { safety_checks_passed: Rate; behaviour_checks_passed: Rate; scenarios_with_a_failed_behaviour_check: string[] };
}

type Units = ReadonlyArray<Record<QueryFacet, IrValues>>;
const sum = (xs: readonly ScenarioEval[], f: (e: ScenarioEval) => number): number => xs.reduce((n, e) => n + f(e), 0);

export function aggregateRetrieval(evals: readonly ScenarioEval[], seedPrefix: string): RetrievalAggregate {
  const retrievalUnits: Units = evals.map((e) => e.ir.retrieval);
  const finalUnits: Units = evals.map((e) => e.ir.final);
  const sq = (k: keyof ScenarioEval["source_quality"]) => sum(evals, (e) => e.source_quality[k]);
  const checks = evals.flatMap((e) => e.checks);
  const bySafety = checks.filter((c) => c.kind === "safety");
  const byBehaviour = checks.filter((c) => c.kind === "behaviour");
  const selected = sum(evals, (e) => e.safety.selected);
  const expectedAbstain = evals.filter((e) => e.abstention.expected);

  return {
    scenarios: evals.length,
    retrieval: summariseIr(retrievalUnits, `${seedPrefix}|retrieval`),
    final: summariseIr(finalUnits, `${seedPrefix}|final`),
    relevant_chunks_per_unit: Object.fromEntries(QUERY_FACETS.map((f) => [f, meanStat(evals.map((e) => e.ir.final[f].relevant), `${seedPrefix}|R|${f}`)])) as Record<QueryFacet, MeanStat>,
    source_quality: {
      high_tier_classes: ["intergovernmental_health_authority", "national_government_health_agency", "state_government_health_agency"],
      selected_from_high_tier: rate(sq("selected_high_tier"), sq("selected")),
      relevant_high_tier_retrieved: rate(sq("units_with_relevant_high_tier_hit"), sq("units_with_relevant_high_tier")),
      selected_that_are_relevant: rate(sq("selected_relevant"), sq("selected")),
      tier_inversions: rate(sq("tier_inversions"), sq("selected_relevant")),
      note: "Source tier is presentation priority for a verifier, not truth. A tier inversion (a relevant lower-tier chunk presented while an equally relevant higher-tier chunk was not) is descriptive: the ranking multiplies relevance by tier, so it can be legitimate.",
    },
    geography: { local_scoped_selections_in_place: rate(sum(evals, (e) => e.safety.local_correct), sum(evals, (e) => e.safety.local_scoped)) },
    stale_evidence: { selected_not_in_force: rate(sum(evals, (e) => e.safety.stale.length), selected) },
    wrong_geography: { selected_outside_the_signal_place: rate(sum(evals, (e) => e.safety.wrong_geography.length), selected) },
    other_ineligible: { selected_unverified_other_language_or_synthetic_in_production: rate(sum(evals, (e) => e.safety.other_ineligible.length), selected) },
    duplicates: { selected_that_duplicate_an_earlier_selection: rate(sum(evals, (e) => e.safety.duplicates), selected) },
    filler: {
      selected_that_are_irrelevant: rate(sum(evals, (e) => e.safety.irrelevant_selected), selected),
      breakdown: {
        annotated_distractor: sum(evals, (e) => e.safety.irrelevant_breakdown.annotated_distractor),
        relevant_to_another_facet_or_syndrome: sum(evals, (e) => e.safety.irrelevant_breakdown.relevant_to_another_facet_or_syndrome),
        other: sum(evals, (e) => e.safety.irrelevant_breakdown.other),
      },
      scenarios_presenting_an_annotated_distractor: rate(evals.filter((e) => e.safety.distractor_documents.length > 0).length, evals.filter((e) => e.safety.selected > 0).length),
    },
    abstention: {
      no_evidence_scenarios_abstained_correctly: rate(expectedAbstain.filter((e) => e.abstention.correct === true).length, expectedAbstain.length),
      facets_without_relevant_evidence_left_empty: rate(sum(evals, (e) => e.abstention.facet_units_correctly_empty), sum(evals, (e) => e.abstention.facet_units_without_relevant)),
    },
    expectations: {
      safety_checks_passed: rate(bySafety.filter((c) => c.ok).length, bySafety.length),
      behaviour_checks_passed: rate(byBehaviour.filter((c) => c.ok).length, byBehaviour.length),
      scenarios_with_a_failed_behaviour_check: evals.filter((e) => e.checks.some((c) => c.kind === "behaviour" && !c.ok)).map((e) => e.id),
    },
  };
}
