// Per-scenario evaluation: IR metrics at both pipeline stages, source-quality counts, the independent safety oracle,
// duplicate detection, abstention, and the scenario's own declared expectations. Everything returned is a COUNT or a per-unit
// value; aggregation (and its confidence intervals) happens once, over scenarios, in aggregate.ts.
import { hashJson } from "../hash";
import type { Candidate } from "../retrieval/retrieve";
import type { RankedCandidate } from "../ranking/types";
import { SOURCE_CLASS_TIERS, QUERY_FACETS, type QueryFacet } from "../vocab";
import { gradeOf, indexJudgments } from "./judgments";
import { ineligibleReasons, isGeoReason, isOtherIneligibleReason, isStaleReason } from "./oracle";
import { irValues, type IrValues } from "./ir";
import type { ScenarioRun } from "./run";
import { chunkKey, type DocRoles, type Grade, type Scenario } from "./types";

export const HIGH_TIER_CLASSES: readonly string[] = SOURCE_CLASS_TIERS.slice(0, 3);
export const STORED_LIST_CAP = 25;

export interface Check {
  name: string;
  /** safety: a violation is a critical failure; behaviour: reported honestly, not an invariant. */
  kind: "safety" | "behaviour";
  ok: boolean;
  detail?: string;
}

export interface FacetLists {
  retrieved_total: number;
  /** First STORED_LIST_CAP retrieved chunk keys, best first (metrics use the full list; retrieved_list_hash covers it). */
  retrieved: string[];
  retrieved_list_hash: string;
  selected: string[];
}

export interface ScenarioEval {
  id: string;
  split: string;
  family: string;
  category: string;
  hashes: { retrieval: string; ranking: string; bundle: string };
  facets: Record<QueryFacet, FacetLists>;
  gaps: string[];
  conflicts: number;
  historical_context: number;
  ir: { retrieval: Record<QueryFacet, IrValues & { relevant: number; returned: number }>; final: Record<QueryFacet, IrValues & { relevant: number; returned: number }> };
  source_quality: { selected: number; selected_high_tier: number; units_with_relevant_high_tier: number; units_with_relevant_high_tier_hit: number; selected_relevant: number; tier_inversions: number };
  safety: {
    selected: number;
    stale: string[];
    wrong_geography: string[];
    other_ineligible: string[];
    local_scoped: number;
    local_correct: number;
    duplicates: number;
    irrelevant_selected: number;
    /** Why an irrelevant (grade 0) chunk was presented: an annotated keyword-stuffed / off-topic distractor, a document relevant to a different facet or syndrome, or other. */
    irrelevant_breakdown: { annotated_distractor: number; relevant_to_another_facet_or_syndrome: number; other: number };
    distractor_documents: string[];
  };
  abstention: { expected: boolean; abstained: boolean; correct: boolean | null; facet_units_without_relevant: number; facet_units_correctly_empty: number };
  checks: Check[];
}

const keyOf = (c: { canonicalId: string | null; evidenceItemId: string; chunkOrdinal: number }): string => chunkKey(c.canonicalId ?? c.evidenceItemId, c.chunkOrdinal);
const tierOf = (cls: string): number => SOURCE_CLASS_TIERS.indexOf(cls as (typeof SOURCE_CLASS_TIERS)[number]);

// ------------------------------------------------------------------ duplicates, independent of the production deduplicator
const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const shingles = (s: string, n = 3): Set<string> => {
  const w = words(s);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i += 1) out.add(w.slice(i, i + n).join(" "));
  return out;
};
export function textJaccard(a: string, b: string): number {
  const x = shingles(a);
  const y = shingles(b);
  if (x.size === 0 && y.size === 0) return words(a).join(" ") === words(b).join(" ") ? 1 : 0;
  let inter = 0;
  for (const s of x) if (y.has(s)) inter += 1;
  return inter / (x.size + y.size - inter);
}

/**
 * A selected chunk is a duplicate if an earlier-ranked selected chunk of the same facet has a 3-word-shingle Jaccard >= 0.85 with it (the same
 * threshold the production deduplicator uses, applied by independent code), OR comes from a different document of the same annotated
 * redundant-copy family AND overlaps it by Jaccard >= 0.5 (so a hand-annotated near-copy that production's 0.85 threshold misses is still counted).
 */
export function countDuplicates(selected: ReadonlyArray<{ canonicalId: string | null; text: string }>, roles: DocRoles): number {
  const family = (id: string | null): string => (id ? (roles.roles[id]?.redundant_copy_of ?? id) : "");
  let dups = 0;
  selected.forEach((c, i) => {
    const earlier = selected.slice(0, i);
    const isDup = earlier.some((e) => {
      const j = textJaccard(c.text, e.text);
      return j >= 0.85 || (c.canonicalId !== null && e.canonicalId !== c.canonicalId && family(c.canonicalId) === family(e.canonicalId) && j >= 0.5);
    });
    if (isDup) dups += 1;
  });
  return dups;
}

// ------------------------------------------------------------------ the scenario evaluation
export function evaluateScenario(run: ScenarioRun, judgments: ReturnType<typeof indexJudgments>, roles: DocRoles): ScenarioEval {
  const s = run.scenario;
  const { ranking, retrieval, inputs } = run;
  const ctx = { asOf: inputs.asOfDate, chain: [{ id: inputs.facts.region.id, level: inputs.facts.region.level as string }, ...inputs.facts.ancestors.map((a) => ({ id: a.id, level: a.level as string }))], profile: inputs.retrievalProfile };
  const classOf = new Map<string, string>();
  for (const v of [inputs.view, inputs.historicalView]) for (const i of v.items) if (i.canonicalId) classOf.set(i.canonicalId, i.sourceClass);

  const facets = {} as Record<QueryFacet, FacetLists>;
  const irRetrieval = {} as ScenarioEval["ir"]["retrieval"];
  const irFinal = {} as ScenarioEval["ir"]["final"];
  const sq = { selected: 0, selected_high_tier: 0, units_with_relevant_high_tier: 0, units_with_relevant_high_tier_hit: 0, selected_relevant: 0, tier_inversions: 0 };
  const safety: ScenarioEval["safety"] = { selected: 0, stale: [], wrong_geography: [], other_ineligible: [], local_scoped: 0, local_correct: 0, duplicates: 0, irrelevant_selected: 0, irrelevant_breakdown: { annotated_distractor: 0, relevant_to_another_facet_or_syndrome: 0, other: 0 }, distractor_documents: [] };
  let factUnits = 0;
  let factEmpty = 0;
  const selectedDocs = new Set<string>();
  const allSelectedKeys: string[] = [];

  for (const f of QUERY_FACETS) {
    const rf = retrieval.facets.find((x) => x.facet === f)!;
    const rk = ranking.facets.find((x) => x.facet === f)!;
    const judged = [...(judgments.get(s.id)?.get(f)?.values() ?? [])];
    const judgedGrades = judged.map((r) => r.grade);
    const gradeAt = (c: { canonicalId: string | null; evidenceItemId: string; chunkOrdinal: number }): Grade => gradeOf(judgments, s.id, f, c.canonicalId ?? c.evidenceItemId, c.chunkOrdinal);

    const retrievedList = rf.candidates.map((c: Candidate) => ({ key: keyOf(c), grade: gradeAt(c) }));
    const selectedList = rk.selected.map((c: RankedCandidate) => ({ key: keyOf(c), grade: gradeAt(c) }));
    irRetrieval[f] = irValues({ list: retrievedList, judgedGrades });
    irFinal[f] = irValues({ list: selectedList, judgedGrades });
    facets[f] = { retrieved_total: retrievedList.length, retrieved: retrievedList.slice(0, STORED_LIST_CAP).map((x) => x.key), retrieved_list_hash: hashJson(retrievedList.map((x) => x.key)), selected: selectedList.map((x) => x.key) };

    // source quality
    const selectedKeys = new Set(selectedList.map((x) => x.key));
    const relevantHigh = judged.filter((r) => r.grade >= 1 && HIGH_TIER_CLASSES.includes(classOf.get(r.canonical_id) ?? ""));
    if (relevantHigh.length > 0) {
      sq.units_with_relevant_high_tier += 1;
      if (relevantHigh.some((r) => selectedKeys.has(chunkKey(r.canonical_id, r.chunk_ordinal)))) sq.units_with_relevant_high_tier_hit += 1;
    }
    for (const c of rk.selected) {
      const g = gradeAt(c);
      sq.selected += 1;
      if (HIGH_TIER_CLASSES.includes(c.metadata.sourceClass)) sq.selected_high_tier += 1;
      if (g >= 1) {
        sq.selected_relevant += 1;
        const betterUnselected = judged.some((r) => r.grade >= g && !selectedKeys.has(chunkKey(r.canonical_id, r.chunk_ordinal)) && tierOf(classOf.get(r.canonical_id) ?? "") >= 0 && tierOf(classOf.get(r.canonical_id) ?? "") < tierOf(c.metadata.sourceClass));
        if (betterUnselected) sq.tier_inversions += 1;
      } else {
        safety.irrelevant_selected += 1;
        const role = c.canonicalId ? roles.roles[c.canonicalId] : undefined;
        if (role?.role === "irrelevant_distractor") {
          safety.irrelevant_breakdown.annotated_distractor += 1;
          if (c.canonicalId && !safety.distractor_documents.includes(c.canonicalId)) safety.distractor_documents.push(c.canonicalId);
        } else if (role && Object.keys(role.facets).length > 0) safety.irrelevant_breakdown.relevant_to_another_facet_or_syndrome += 1;
        else safety.irrelevant_breakdown.other += 1;
      }

      // the independent safety oracle
      safety.selected += 1;
      const reasons = ineligibleReasons(c.metadata, ctx);
      const tag = `${f}:${keyOf(c)}`;
      if (reasons.some(isStaleReason)) safety.stale.push(`${tag}:${reasons.filter(isStaleReason).join("+")}`);
      if (reasons.some(isGeoReason)) safety.wrong_geography.push(tag);
      if (reasons.some(isOtherIneligibleReason)) safety.other_ineligible.push(`${tag}:${reasons.filter(isOtherIneligibleReason).join("+")}`);
      if (c.metadata.geoScope === "state" || c.metadata.geoScope === "district") {
        safety.local_scoped += 1;
        if (!reasons.some(isGeoReason)) safety.local_correct += 1;
      }
      allSelectedKeys.push(keyOf(c));
      if (c.canonicalId) selectedDocs.add(c.canonicalId);
    }
    safety.duplicates += countDuplicates(rk.selected.map((c) => ({ canonicalId: c.canonicalId, text: c.text })), roles);

    // facet-level abstention: a facet with nothing relevant should present nothing
    if (irFinal[f].relevant === 0) {
      factUnits += 1;
      if (rk.selected.length === 0) factEmpty += 1;
    }
  }

  const gaps = ranking.gaps.map((g) => g.code);
  const totalSelected = sq.selected;
  const abstained = totalSelected === 0;
  const checks = expectationChecks(s, { gaps, selectedDocs, totalSelected, conflicts: ranking.conflicts.length, historical: ranking.historicalContext.length, facets });

  return {
    id: s.id, split: s.split, family: s.family, category: s.category,
    hashes: { retrieval: retrieval.resultHash, ranking: ranking.rankingHash, bundle: run.bundle.bundle_hash },
    facets, gaps: [...new Set(gaps)].sort(), conflicts: ranking.conflicts.length, historical_context: ranking.historicalContext.length,
    ir: { retrieval: irRetrieval, final: irFinal },
    source_quality: sq, safety,
    abstention: { expected: s.expected.abstain, abstained, correct: s.expected.abstain ? abstained && gaps.includes("no_eligible_evidence") : null, facet_units_without_relevant: factUnits, facet_units_correctly_empty: factEmpty },
    checks,
  };
}

function expectationChecks(
  s: Scenario,
  got: { gaps: string[]; selectedDocs: Set<string>; totalSelected: number; conflicts: number; historical: number; facets: Record<QueryFacet, FacetLists> },
): Check[] {
  const e = s.expected;
  const out: Check[] = [];
  const add = (name: string, kind: Check["kind"], ok: boolean, detail?: string) => out.push({ name, kind, ok, ...(ok || !detail ? {} : { detail }) });
  if (e.abstain) {
    add("abstains: nothing is selected", "safety", got.totalSelected === 0, `${got.totalSelected} chunk(s) selected`);
    add("abstains: the no_eligible_evidence gap is explicit", "safety", got.gaps.includes("no_eligible_evidence"));
  } else add("presents evidence", "behaviour", got.totalSelected > 0);
  for (const g of e.gap_codes_include) add(`gap ${g} is stated`, "behaviour", got.gaps.includes(g));
  for (const g of e.gap_codes_exclude) add(`gap ${g} is not stated`, "behaviour", !got.gaps.includes(g));
  const forbidden = e.must_not_select.filter((id) => got.selectedDocs.has(id));
  add("no hard-negative document is selected", "safety", forbidden.length === 0, forbidden.join(", "));
  const soft = e.should_not_select.filter((id) => got.selectedDocs.has(id));
  if (e.should_not_select.length) add("distractors / redundant copies are not selected", "behaviour", soft.length === 0, soft.join(", "));
  if (e.conflicts !== undefined) add(`${e.conflicts} curator-tagged conflict(s) reported`, "behaviour", got.conflicts === e.conflicts, `${got.conflicts} reported`);
  if (e.historical_context === "none") add("no historical context shown", "behaviour", got.historical === 0);
  if (e.historical_context === "present") add("historical context shown", "behaviour", got.historical > 0);
  for (const f of e.facets_empty) add(`facet ${f} is empty`, "behaviour", got.facets[f].selected.length === 0);
  return out;
}
