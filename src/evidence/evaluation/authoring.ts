// Authoring of the M4.6 scenario set and its reference judgments. This is a deterministic generator: its output is committed
// (data/evidence/eval/) and frozen BEFORE any held-out result is looked at, and `eval:evidence --check` regenerates it to prove
// the committed files were not edited by hand. It is the only evaluation module that imports the M3 episode generator.
//
//   40 scenarios are DERIVED from M3 planted-episode shapes: the seeded M3 replicate generator (seeds 3001-3010, outside both
//      the M3 dev and held-out seed ranges) draws true clusters with a syndrome, one or two blocks of one district, an onset, a
//      duration and a plateau/ramp shape. Each is mapped to the signal characteristics the evidence pipeline actually consumes
//      (syndrome, place, window, spread, persistence). The mapping is documented here; the episodes were NOT run through the detector.
//   24 are HAND-AUTHORED edge cases covering the situations the plan names (no evidence, conflicts, wrong place, stale, superseded, ...).
//
// The expected behaviour of every scenario is written down here, from the stated rules, and never fitted to a result.
import { sha256Hex } from "../hash";
import type { CorpusItem } from "../retrieval/corpus";
import { classifyPersistence, classifySpread } from "../retrieval/signal";
import { randomEvents } from "../../evaluation/replicates";
import { START_DATE } from "../../synthetic/generate";
import { generateGeography } from "../../synthetic/geography";
import { ineligibleReasons } from "./oracle";
import { inputsFor, type CorpusBase } from "./scenarioCorpus";
import { DISCLAIMER, SCENARIO_SCHEMA, scenarioSetSchema, type FactsSpec, type Scenario, type ScenarioSet, type Syndrome } from "./types";

export const SCENARIO_SET_VERSION = "1.0.0";
export const M3_SEEDS = { first: 3001, last: 3010 } as const;
export const SPLIT_RULE =
  "Scenarios are grouped by category. Within each group they are ordered by SHA-256 of 'm4.6-split|<id>' and alternately assigned dev, test, dev, ... " +
  "(a one-scenario group goes to dev when the first byte of that hash is even, otherwise to test). The split is fixed here, before any result exists, and is part of the scenario-set hash.";

const geo = generateGeography();
const byId = new Map(geo.regions.map((r) => [r.id, r]));
type Level = "country" | "state" | "district" | "block" | "locality";
const spec = (code: string) => {
  const r = geo.byCode.get(code);
  if (!r) throw new Error(`unknown synthetic region ${code}`);
  return { code, name: r.name, level: r.region_type as Level };
};
const parentOf = (code: string) => {
  const r = geo.byCode.get(code)!;
  return spec(byId.get(r.parent_region_id!)!.administrative_code);
};
const addDays = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const OTHER_STATE = { code: "OTHER-STATE", name: "Elsewhere State", level: "state" as const };
const OTHER_DISTRICT = { code: "OTHER-DISTRICT", name: "Elsewhere District", level: "district" as const };
const COUNTRY = spec("SYN-IN");
const STATE = spec("SYN-OD");

/** Facts for a signal located in a synthetic block (single block) or district (district-level), with the standard ancestors. */
function placeFacts(syndrome: Syndrome, code: string, window: { start: string; end: string }, o: Partial<FactsSpec> = {}): FactsSpec {
  const region = spec(code);
  if (region.level === "block") {
    const district = parentOf(code);
    return { syndrome, region, ancestors: [district, STATE, COUNTRY], window, involved_blocks: [{ code, name: region.name }], spread: "single_block", persistence: "sustained", ...o };
  }
  return { syndrome, region, ancestors: [STATE, COUNTRY], window, involved_blocks: [], spread: "unknown", persistence: "sustained", ...o };
}
const elsewhere = (syndrome: Syndrome, window: { start: string; end: string }): FactsSpec => ({
  syndrome, region: OTHER_DISTRICT, ancestors: [OTHER_STATE, COUNTRY], window, involved_blocks: [], spread: "unknown", persistence: "sustained",
});
const WEEK = { start: "2025-09-01", end: "2025-09-07" };

// ------------------------------------------------------------------------------------------------ M3-derived scenarios
function m3Derived(): Scenario[] {
  const out: Scenario[] = [];
  for (let seed = M3_SEEDS.first; out.length < 40 && seed <= M3_SEEDS.last + 40; seed += 1) {
    for (const e of randomEvents(seed).events.filter((x) => x.kind === "true_cluster")) {
      if (out.length >= 40) break;
      const blocks = e.region_codes.map(spec);
      const district = parentOf(blocks[0].code);
      const blocksInDistrict = geo.blocks.filter((b) => b.districtCode === district.code.split("-").pop()).length;
      const single = blocks.length === 1;
      const window = { start: addDays(START_DATE, e.start_day), end: addDays(START_DATE, e.end_day) };
      const spread = classifySpread(single ? "block" : "district", blocks.length, blocksInDistrict);
      const persistence = classifyPersistence(e.shape === "plateau" ? 0.85 : 0.45);
      const facts: FactsSpec = {
        syndrome: e.syndrome as Syndrome,
        region: single ? blocks[0] : district,
        ancestors: single ? [district, STATE, COUNTRY] : [STATE, COUNTRY],
        window,
        involved_blocks: blocks.map((b) => ({ code: b.code, name: b.name })),
        spread: spread === "unknown" ? "multi_block" : spread,
        persistence: persistence === "unknown" ? "sustained" : persistence,
      };
      const id = `M${String(out.length + 1).padStart(2, "0")}`;
      out.push({
        id, family: "m3_derived", category: `m3_${e.shape}_${facts.spread}`, split: "dev",
        description: `M3-derived: ${e.shape} ${e.syndrome.replace(/_/g, " ")} episode in ${blocks.map((b) => b.name).join(" + ")} (${district.name}), ${e.end_day - e.start_day + 1} days from ${window.start}`,
        origin: { m3_seed: seed, m3_event: e.id, shape: e.shape, blocks: blocks.length, onset_day: e.start_day, duration_days: e.end_day - e.start_day + 1, multiplier: e.multiplier },
        facts, variant: { retrieval_config: "dev" },
        expected: { abstain: false, gap_codes_include: ["only_synthetic_evidence"], gap_codes_exclude: ["no_eligible_evidence"], must_not_select: [], should_not_select: [], conflicts: 0, historical_context: "any", facets_empty: [] },
      });
    }
  }
  if (out.length !== 40) throw new Error(`expected 40 M3-derived scenarios, drew ${out.length}`);
  return out;
}

// ------------------------------------------------------------------------------------------------ hand-authored edge cases
const NO_SYNTH_GAP = { gap_codes_include: ["only_synthetic_evidence"], gap_codes_exclude: [] as string[] };
interface Edge {
  id: string; category: string; description: string; facts: FactsSpec; variant?: Scenario["variant"]; signal_key?: string;
  expected: Partial<Scenario["expected"]> & { abstain: boolean };
}
const REGIONAL_DOCS = [
  "syn-ads-odisha-context", "syn-odisha-wash-guidance-monsoon", "syn-national-monsoon-seasonality-note", "syn-ganjam-water-advisory", "syn-khordha-response-contacts",
  "syn-global-vector-borne-context", "syn-fev-odisha-context", "syn-jau-odisha-context", "syn-ras-odisha-context", "syn-res-odisha-context",
];
const PAIR = ["syn-conflict-reporting-deadline-a", "syn-conflict-reporting-deadline-b"];

function edges(): Edge[] {
  return [
    { id: "E01", category: "strong_relevant", signal_key: "default", description: "Reference scenario: acute diarrhoeal illness, single block in Khordha, strong multi-source evidence (its bundle is the M4.4 golden bundle)",
      facts: placeFacts("acute_diarrhoeal_illness", "SYN-OD-KHO-BAL", WEEK), expected: { abstain: false, ...NO_SYNTH_GAP, conflicts: 0 } },
    { id: "E02", category: "strong_relevant", description: "Fever in a Ganjam block: strong syndrome-specific and state-level evidence",
      facts: placeFacts("fever", "SYN-OD-GAN-ASK", WEEK), expected: { abstain: false, ...NO_SYNTH_GAP, conflicts: 0 } },
    { id: "E03", category: "multiple_sources", description: "Jaundice signal at Ganjam district level: a district-specific advisory exists in addition to the national and state sources",
      facts: placeFacts("jaundice", "SYN-OD-GAN", WEEK, { spread: "district_wide", involved_blocks: [{ code: "SYN-OD-GAN-ASK", name: "Aska" }, { code: "SYN-OD-GAN-BHA", name: "Bhanjanagar" }, { code: "SYN-OD-GAN-CHH", name: "Chhatrapur" }] }),
      expected: { abstain: false, ...NO_SYNTH_GAP, conflicts: 0 } },
    { id: "E04", category: "weak_evidence", description: "Fever with rash where only general (no syndrome-specific) guidance remains in the corpus",
      facts: placeFacts("fever_with_rash", "SYN-OD-KHO-BAL", WEEK),
      variant: { retrieval_config: "dev", only_docs: ["syn-global-outbreak-investigation-checklist", "syn-national-outbreak-response-reporting", "syn-professional-cluster-reporting-statement", "syn-community-health-worker-notes", "syn-national-surveillance-methods-primer"] },
      expected: { abstain: false, ...NO_SYNTH_GAP, gap_codes_exclude: ["no_eligible_evidence"], conflicts: 0 } },
    { id: "E05", category: "sparse_evidence", description: "Jaundice where a single case-definition document is all that remains",
      facts: placeFacts("jaundice", "SYN-OD-KHO-JAT", WEEK), variant: { retrieval_config: "dev", only_docs: ["syn-jau-case-definition"] },
      expected: { abstain: false, gap_codes_include: ["only_synthetic_evidence", "facet_not_covered", "missing_local_evidence"], gap_codes_exclude: ["no_eligible_evidence"], facets_empty: ["verification_guidance", "epidemiological_context", "regional_context"] } },
    { id: "E06", category: "no_evidence", description: "Empty corpus: nothing exists to retrieve",
      facts: placeFacts("acute_diarrhoeal_illness", "SYN-OD-KHO-BAL", WEEK), variant: { retrieval_config: "dev", only_docs: [] },
      expected: { abstain: true, gap_codes_include: ["no_eligible_evidence", "missing_local_evidence"], conflicts: 0 } },
    { id: "E07", category: "no_evidence", description: "Acute diarrhoeal illness where the corpus holds only documents specific to other syndromes",
      facts: placeFacts("acute_diarrhoeal_illness", "SYN-OD-KHO-BAL", WEEK),
      variant: { retrieval_config: "dev", only_docs: ["syn-res-case-definition", "syn-res-verification-guidance", "syn-jau-case-definition", "syn-ras-case-definition", "syn-fev-verification-guidance"] },
      expected: { abstain: true, gap_codes_include: ["no_eligible_evidence"], conflicts: 0 } },
    { id: "E08", category: "no_evidence", description: "Full synthetic corpus under the PRODUCTION policy, which refuses synthetic evidence: nothing is eligible",
      facts: placeFacts("fever", "SYN-OD-KHO-BAL", WEEK), variant: { retrieval_config: "production" },
      expected: { abstain: true, gap_codes_include: ["no_eligible_evidence"], gap_codes_exclude: ["only_synthetic_evidence"], conflicts: 0 } },
    { id: "E09", category: "conflicting_sources", description: "Two curator-tagged reporting-deadline rules (24 hours vs 72 hours) are both selected: a conflict must be reported",
      facts: placeFacts("jaundice", "SYN-OD-KHO-BAL", WEEK),
      variant: { retrieval_config: "dev", only_docs: [...PAIR, "syn-global-outbreak-investigation-checklist"], tags: { [PAIR[0]]: { question_key: "reporting_deadline", position: "within_24_hours" }, [PAIR[1]]: { question_key: "reporting_deadline", position: "within_72_hours" } } },
      expected: { abstain: false, ...NO_SYNTH_GAP, conflicts: 1 } },
    { id: "E10", category: "conflicting_sources", description: "The same two rules with NO curator tags: opposing wording alone must not be reported as a conflict",
      facts: placeFacts("jaundice", "SYN-OD-KHO-BAL", WEEK), variant: { retrieval_config: "dev", only_docs: [...PAIR, "syn-global-outbreak-investigation-checklist"] },
      expected: { abstain: false, ...NO_SYNTH_GAP, conflicts: 0 } },
    { id: "E11", category: "wrong_geography", description: "A signal in another state: Odisha and district documents must not be presented, and the missing local evidence must be stated",
      facts: elsewhere("acute_diarrhoeal_illness", WEEK), expected: { abstain: false, gap_codes_include: ["missing_local_evidence", "only_synthetic_evidence"], conflicts: 0 } },
    { id: "E12", category: "wrong_geography", description: "A signal in Ganjam: the Khordha district procedure must not be presented, the Ganjam advisory may be",
      facts: placeFacts("acute_diarrhoeal_illness", "SYN-OD-GAN-ASK", WEEK), expected: { abstain: false, ...NO_SYNTH_GAP, conflicts: 0 } },
    { id: "E13", category: "wrong_geography", description: "A signal in Puri, which has no district documents: neither Khordha nor Ganjam documents may be presented",
      facts: placeFacts("jaundice", "SYN-OD-PUR-BRA", WEEK), expected: { abstain: false, ...NO_SYNTH_GAP, conflicts: 0 } },
    { id: "E14", category: "stale_evidence", description: "A window ending before the situation report and weekly summary were published: no look-ahead",
      facts: placeFacts("acute_diarrhoeal_illness", "SYN-OD-KHO-BAL", { start: "2025-08-18", end: "2025-08-24" }), expected: { abstain: false, ...NO_SYNTH_GAP, conflicts: 0 } },
    { id: "E15", category: "stale_evidence", description: "Fever with rash: the verification guidance whose validity ended in 2023 must not be presented",
      facts: placeFacts("fever_with_rash", "SYN-OD-KHO-BAL", WEEK), expected: { abstain: false, ...NO_SYNTH_GAP, conflicts: 0 } },
    { id: "E16", category: "superseded_evidence", description: "Acute diarrhoeal illness: the superseded 2022 verification guidance must not be presented as current evidence",
      facts: placeFacts("acute_diarrhoeal_illness", "SYN-OD-KHO-JAT", WEEK), expected: { abstain: false, ...NO_SYNTH_GAP, conflicts: 0 } },
    { id: "E17", category: "ineligible_status", description: "Fever: a withdrawn guidance, quarantined adversarial documents and an unverified forum post exist and must never be presented",
      facts: placeFacts("fever", "SYN-OD-KHO-BAL", WEEK), expected: { abstain: false, ...NO_SYNTH_GAP, conflicts: 0 } },
    { id: "E18", category: "ineligible_status", description: "Respiratory illness: a draft note and quarantined adversarial documents exist and must never be presented",
      facts: placeFacts("respiratory_illness", "SYN-OD-GAN-ASK", WEEK), expected: { abstain: false, ...NO_SYNTH_GAP, conflicts: 0 } },
    { id: "E19", category: "keyword_stuffed_distractors", description: "Two keyword-stuffed off-topic pages compete directly with real guidance: they should not be selected",
      facts: placeFacts("acute_diarrhoeal_illness", "SYN-OD-KHO-BAL", WEEK),
      variant: { retrieval_config: "dev", only_docs: ["syn-stuffed-irrelevant-a", "syn-stuffed-irrelevant-b", "syn-ads-verification-guidance", "syn-global-outbreak-investigation-checklist", "syn-ads-case-definition"] },
      expected: { abstain: false, ...NO_SYNTH_GAP, conflicts: 0, should_not_select: ["syn-stuffed-irrelevant-a", "syn-stuffed-irrelevant-b"] } },
    { id: "E20", category: "duplicates", description: "An exact copy and a near-duplicate of the primary verification guidance are present: the copies should not both be presented",
      facts: placeFacts("acute_diarrhoeal_illness", "SYN-OD-KHO-BAL", WEEK),
      variant: { retrieval_config: "dev", only_docs: ["syn-ads-verification-guidance", "syn-ads-verification-exact-copy", "syn-ads-verification-near-duplicate", "syn-ads-verification-guidance-2025", "syn-global-outbreak-investigation-checklist"] },
      expected: { abstain: false, ...NO_SYNTH_GAP, conflicts: 0, should_not_select: ["syn-ads-verification-exact-copy", "syn-ads-verification-near-duplicate"] } },
    { id: "E21", category: "language_scope", description: "A Hindi verification note is in the corpus: cross-lingual retrieval is out of scope, so it must not be presented",
      facts: placeFacts("acute_diarrhoeal_illness", "SYN-OD-KHO-BAL", WEEK),
      variant: { retrieval_config: "dev", only_docs: ["syn-hi-ads-verification", "syn-ads-verification-guidance", "syn-ads-case-definition", "syn-ads-clinical-reference"] },
      expected: { abstain: false, ...NO_SYNTH_GAP, conflicts: 0 } },
    { id: "E22", category: "missing_facet_coverage", description: "No regional-context documents remain: the regional facet must be empty and the gap stated",
      facts: placeFacts("acute_diarrhoeal_illness", "SYN-OD-KHO-BAL", WEEK), variant: { retrieval_config: "dev", remove_docs: REGIONAL_DOCS },
      expected: { abstain: false, gap_codes_include: ["only_synthetic_evidence", "facet_not_covered", "missing_local_evidence"], conflicts: 0, facets_empty: ["regional_context"] } },
    { id: "E23", category: "multiple_sources", description: "Acute diarrhoeal illness at Khordha district level across several blocks: the district procedure and the state guidance both apply",
      facts: placeFacts("acute_diarrhoeal_illness", "SYN-OD-KHO", WEEK, { spread: "district_wide", involved_blocks: [{ code: "SYN-OD-KHO-BAL", name: "Balianta" }, { code: "SYN-OD-KHO-JAT", name: "Jatni" }, { code: "SYN-OD-KHO-BAN", name: "Banapur" }] }),
      expected: { abstain: false, ...NO_SYNTH_GAP, conflicts: 0 } },
    { id: "E24", category: "stale_evidence", description: "A window more than a year after the situation reports: they are aged (oldest bucket) and the gap must say so",
      facts: placeFacts("acute_diarrhoeal_illness", "SYN-OD-KHO-BAL", { start: "2026-09-10", end: "2026-09-16" }), expected: { abstain: false, gap_codes_include: ["only_synthetic_evidence", "all_evidence_old"], conflicts: 0 } },
  ];
}

function assignSplits(scenarios: Scenario[]): Scenario[] {
  const groups = new Map<string, Scenario[]>();
  for (const s of scenarios) groups.set(s.category, [...(groups.get(s.category) ?? []), s]);
  const split = new Map<string, "dev" | "test">();
  for (const [, g] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ordered = g.map((s) => ({ s, h: sha256Hex(`m4.6-split|${s.id}`) })).sort((a, b) => a.h.localeCompare(b.h));
    if (ordered.length === 1) split.set(ordered[0].s.id, parseInt(ordered[0].h.slice(0, 2), 16) % 2 === 0 ? "dev" : "test");
    else ordered.forEach((o, i) => split.set(o.s.id, i % 2 === 0 ? "dev" : "test"));
  }
  return scenarios.map((s) => ({ ...s, split: split.get(s.id)! }));
}

/** Documents that may not be presented in a scenario (by the independent oracle): its explicit hard negatives. */
function hardNegatives(base: CorpusBase, s: Scenario): string[] {
  const inputs = inputsFor(base, s);
  const ctx = { asOf: inputs.asOfDate, chain: [{ id: inputs.facts.region.id, level: inputs.facts.region.level as string }, ...inputs.facts.ancestors.map((a) => ({ id: a.id, level: a.level as string }))], profile: inputs.retrievalProfile };
  const seen = new Map<string, CorpusItem>();
  for (const v of [inputs.view, inputs.historicalView]) for (const i of v.items) if (i.canonicalId) seen.set(i.canonicalId, i);
  return [...seen.entries()].filter(([, item]) => ineligibleReasons(item, ctx).length > 0).map(([id]) => id).sort();
}

export function authorScenarioSet(base: CorpusBase): ScenarioSet {
  const derived = m3Derived();
  const edge: Scenario[] = edges().map((e) => ({
    id: e.id, family: "edge_case", category: e.category, split: "dev", description: e.description, signal_key: e.signal_key, facts: e.facts,
    variant: e.variant ?? { retrieval_config: "dev" },
    expected: { gap_codes_include: [], gap_codes_exclude: [], must_not_select: [], historical_context: "any", facets_empty: [], should_not_select: [], ...e.expected },
  }));
  const withNegatives = [...derived, ...edge].map((s) => ({ ...s, expected: { ...s.expected, must_not_select: hardNegatives(base, s) } }));
  const scenarios = assignSplits(withNegatives);
  const set: ScenarioSet = {
    artefact: "m4-6-scenario-set", schema: SCENARIO_SCHEMA, version: SCENARIO_SET_VERSION, disclaimer: DISCLAIMER, split_rule: SPLIT_RULE,
    categories: [...new Set(scenarios.map((s) => s.category))].sort(), scenarios,
  };
  return scenarioSetSchema.parse(set);
}

