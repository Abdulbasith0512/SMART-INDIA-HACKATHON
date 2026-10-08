// @vitest-environment node
// Per-scenario evaluation, aggregation, the scripted provider assignment, and the harness' hygiene: it is deterministic, offline,
// writes only to its artefact directory, and nothing in production depends on it.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IDENTITY } from "../bundle/testkit";
import { QUERY_FACETS, SOURCE_CLASS_TIERS } from "../vocab";
import { aggregateRetrieval } from "./aggregate";
import { SCRIPT_WEIGHTS, evaluateOne, scriptFor, summariseSplit, type ScenarioResult } from "./evaluate";
import { indexJudgments } from "./judgments";
import { runScenario } from "./run";
import { HIGH_TIER_CLASSES, countDuplicates, evaluateScenario, textJaccard } from "./scenarioEval";
import { findScenario, kit, scenario } from "./testkit";

const { ctx, base, set, roles, judgments: artefact } = kit();
const index = () => indexJudgments(artefact.rows);

describe("duplicate detection (independent of the production deduplicator)", () => {
  const a = "Teams should visit affected households and list every person with symptoms in the last week and record the onset date for each person.";
  it("text overlap: identical = 1, unrelated = 0, a light edit stays high", () => {
    expect(textJaccard(a, a)).toBe(1);
    expect(textJaccard(a, "Quarterly budget allocations for rural road maintenance were approved by the committee on Tuesday afternoon.")).toBe(0);
    expect(textJaccard(a, a.replace("last week", "past week"))).toBeGreaterThan(0.7);
  });

  it("counts a later copy but not the first occurrence, and not different text", () => {
    expect(countDuplicates([{ canonicalId: "d1", text: a }, { canonicalId: "d2", text: a }], roles)).toBe(1);
    expect(countDuplicates([{ canonicalId: "d1", text: a }, { canonicalId: "d2", text: "Water source inspection records should be kept by the sanitation officer for every visit made." }], roles)).toBe(0);
    expect(countDuplicates([{ canonicalId: "d1", text: a }], roles)).toBe(0);
  });

  it("an annotated redundant-copy family lowers the bar to 0.5 for different documents of the family only", () => {
    const copy = Object.entries(roles.roles).find(([, r]) => r.redundant_copy_of);
    expect(copy).toBeDefined();
    const [copyId, r] = copy!;
    const half = a.split(" ").slice(0, 13).join(" ");
    const lower = `${half} and then something quite different follows here about unrelated procurement`;
    expect(textJaccard(a, lower)).toBeGreaterThanOrEqual(0.3);
    const family = countDuplicates([{ canonicalId: r.redundant_copy_of!, text: a }, { canonicalId: copyId, text: a.split(" ").slice(0, 16).join(" ") }], roles);
    expect(family).toBe(1);
    expect(countDuplicates([{ canonicalId: "unrelated-1", text: a }, { canonicalId: "unrelated-2", text: a.split(" ").slice(0, 16).join(" ") }], roles)).toBe(0);
  });
});

describe("evaluating one scenario", () => {
  const run = runScenario(base, scenario("E01"), IDENTITY);
  const ev = evaluateScenario(run, index(), roles);

  it("records the hashes of the retrieval, ranking and bundle it evaluated", () => {
    expect(ev.hashes).toEqual({ retrieval: run.retrieval.resultHash, ranking: run.ranking.rankingHash, bundle: run.bundle.bundle_hash });
  });

  it("evaluates both pipeline stages for every facet, with values in range and the final list inside the retrieved list", () => {
    for (const f of QUERY_FACETS) {
      for (const stage of [ev.ir.retrieval[f], ev.ir.final[f]]) {
        for (const k of ["recall_at_5", "capped_recall_at_5", "recall_at_10", "precision_at_5", "mrr", "ndcg_at_10"] as const) {
          const v = stage[k];
          if (v !== null) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
        }
      }
      const retrieved = new Set(ev.facets[f].retrieved);
      if (ev.facets[f].retrieved_total <= 25) for (const k of ev.facets[f].selected) expect(retrieved.has(k), `${f}:${k}`).toBe(true);
      expect(ev.ir.final[f].returned).toBe(ev.facets[f].selected.length);
      expect(ev.ir.final[f].relevant).toBe(ev.ir.retrieval[f].relevant);
    }
  });

  it("derives the number of relevant chunks from the reference judgments, not from the system", () => {
    for (const f of QUERY_FACETS) {
      const rows = [...(index().get("E01")?.get(f)?.values() ?? [])];
      expect(ev.ir.final[f].relevant).toBe(rows.filter((r) => r.grade >= 1).length);
    }
  });

  it("a normal scenario presents evidence safely and passes its safety expectations", () => {
    expect(ev.safety.selected).toBeGreaterThan(0);
    expect(ev.safety.stale).toEqual([]);
    expect(ev.safety.wrong_geography).toEqual([]);
    expect(ev.safety.other_ineligible).toEqual([]);
    expect(ev.checks.filter((c) => c.kind === "safety").every((c) => c.ok)).toBe(true);
    expect(ev.abstention.expected).toBe(false);
  });

  it("an abstaining scenario presents nothing, states the gap, and counts as correct abstention", () => {
    const s = findScenario((x) => x.expected.abstain);
    const r = runScenario(base, s, IDENTITY);
    const e = evaluateScenario(r, index(), roles);
    expect(e.safety.selected).toBe(0);
    expect(e.gaps).toContain("no_eligible_evidence");
    expect(e.abstention).toMatchObject({ expected: true, abstained: true, correct: true });
    expect(e.abstention.facet_units_correctly_empty).toBe(e.abstention.facet_units_without_relevant);
    for (const f of QUERY_FACETS) {
      expect(e.ir.final[f].recall_at_5).toBeNull();
      expect(e.ir.final[f].mrr).toBeNull();
    }
  });

  it("splits irrelevant presentations by cause, and the parts add up", () => {
    for (const s of set.scenarios.slice(0, 12)) {
      const e = evaluateScenario(runScenario(base, s, IDENTITY), index(), roles);
      const b = e.safety.irrelevant_breakdown;
      expect(b.annotated_distractor + b.relevant_to_another_facet_or_syndrome + b.other, s.id).toBe(e.safety.irrelevant_selected);
    }
  });
});

describe("aggregation", () => {
  it("every pooled rate states its denominator, and the parts add up", () => {
    const evals = set.scenarios.slice(0, 10).map((s) => evaluateScenario(runScenario(base, s, IDENTITY), index(), roles));
    const a = aggregateRetrieval(evals, "t");
    const selected = evals.reduce((n, e) => n + e.safety.selected, 0);
    expect(a.scenarios).toBe(10);
    expect(a.stale_evidence.selected_not_in_force.n).toBe(selected);
    expect(a.source_quality.selected_from_high_tier.n).toBe(selected);
    const b = a.filler.breakdown;
    expect(b.annotated_distractor + b.relevant_to_another_facet_or_syndrome + b.other).toBe(a.filler.selected_that_are_irrelevant.k);
    expect(a.source_quality.note).toMatch(/presentation priority/);
  });

  it("produces nulls, never NaN, when the sample contains only an abstaining scenario", () => {
    const s = findScenario((x) => x.expected.abstain);
    const e = evaluateScenario(runScenario(base, s, IDENTITY), index(), roles);
    const a = aggregateRetrieval([e], "t");
    expect(a.final.overall.recall_at_5.mean).toBeNull();
    expect(a.final.overall.mrr.n).toBe(0);
    expect(a.stale_evidence.selected_not_in_force.value).toBeNull();
    expect(JSON.stringify(a)).not.toMatch(/NaN|Infinity/);
  });

  it("abstention is scored at scenario level and at facet level", () => {
    const s = findScenario((x) => x.expected.abstain);
    const e = evaluateScenario(runScenario(base, s, IDENTITY), index(), roles);
    const a = aggregateRetrieval([e], "t");
    expect(a.abstention.no_evidence_scenarios_abstained_correctly).toMatchObject({ k: 1, n: 1, value: 1 });
    expect(a.abstention.facets_without_relevant_evidence_left_empty.n).toBeGreaterThan(0);
  });
});

describe("the scripted provider", () => {
  it("is assigned by scenario id only: deterministic, mostly valid answers, and several kinds of failure", () => {
    const ids = set.scenarios.map((s) => s.id);
    expect(ids.map(scriptFor)).toEqual(ids.map(scriptFor));
    const counts: Record<string, number> = {};
    for (const id of ids) counts[scriptFor(id)] = (counts[scriptFor(id)] ?? 0) + 1;
    expect(counts.valid).toBeGreaterThan(ids.length / 2);
    expect(Object.keys(counts).length).toBeGreaterThanOrEqual(3);
    expect(SCRIPT_WEIGHTS.reduce((n, [, w]) => n + w, 0)).toBe(20);
  });
});

describe("summarising a split", () => {
  it("counts scenarios by family and category, scripted outcomes by script, and ties valid-answer acceptance to the valid script", async () => {
    const results: ScenarioResult[] = [];
    for (const s of set.scenarios.filter((x) => x.split === "dev").slice(0, 8)) results.push((await evaluateOne(ctx, s)).result);
    const sum = summariseSplit("dev", results);
    expect(sum.scenarios).toBe(8);
    expect(Object.values(sum.by_family).reduce((a, b) => a + b, 0)).toBe(8);
    expect(Object.values(sum.by_category).reduce((a, b) => a + b, 0)).toBe(8);
    expect(Object.values(sum.generation.scripted.by_script).reduce((n, v) => n + v.scenarios, 0)).toBe(8);
    const asked = results.filter((r) => r.generation.script === "valid" && r.generation.facts.status !== "skipped");
    expect(sum.generation.valid_answer_acceptance.n).toBe(asked.length);
    expect(sum.generation.replay_fidelity).toMatchObject({ k: 8, n: 8 });
    expect(sum.generation.scripted.note).toMatch(/not a language model/);
    expect(sum.generation.factual_consistency.status).toBe("not_measured");
  });
});

describe("harness hygiene", () => {
  const dir = join(process.cwd(), "src", "evidence", "evaluation");
  const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => [f, readFileSync(join(dir, f), "utf8")] as const);
  const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("makes no network call, reads no environment, runs no subprocess and uses no clock or randomness", () => {
    for (const [f, src] of sources) {
      const code = noComments(src);
      for (const banned of [/\bfetch\s*\(/, /XMLHttpRequest/, /process\.env/, /child_process/, /Math\.random\s*\(/, /Date\.now\s*\(/, /new Date\(\)/]) {
        expect(banned.test(code), `${f} ${banned}`).toBe(false);
      }
    }
  });

  it("only artifacts.ts writes files, and only under the evaluation artefact directory", () => {
    const writers = sources.filter(([, s]) => /writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync/.test(noComments(s))).map(([f]) => f);
    expect(writers).toEqual(["artifacts.ts"]);
    const art = noComments(sources.find(([f]) => f === "artifacts.ts")![1]);
    expect(art.match(/writeFileSync\(/g)!.length).toBe(2);
    expect(art).toMatch(/const path = \(root: string, name: string\): string => join\(root, EVAL_DIR, name\)/);
    expect(art.match(/writeFileSync\(path\(root, name\)/g)!.length).toBe(2);
  });

  it("nothing in production (retrieval, ranking, bundle, llm, ingest, net, vocabulary) imports the evaluation harness", () => {
    for (const d of ["retrieval", "ranking", "bundle", "llm", "ingest", "net"]) {
      for (const f of readdirSync(join(process.cwd(), "src", "evidence", d)).filter((n) => n.endsWith(".ts"))) {
        const src = readFileSync(join(process.cwd(), "src", "evidence", d, f), "utf8");
        expect(/from\s+["'][^"']*evaluation["']|from\s+["'][^"']*\/evaluation\//.test(src), `${d}/${f}`).toBe(false);
      }
    }
    for (const f of ["vocab.ts", "hash.ts"]) expect(/evaluation/.test(readFileSync(join(process.cwd(), "src", "evidence", f), "utf8"))).toBe(false);
  });

  it("the judge cannot reach production outputs: nothing but the harness imports it", () => {
    const importers = sources.filter(([f, s]) => f !== "judge.ts" && /import\s+(?!type\b)[^;]*from\s+["']\.\/judge["']/.test(s)).map(([f]) => f);
    expect(importers).toEqual(["produce.ts"]);
  });
});

// ---------------------------------------------------------------------------------------------- planted violations
// Production never presents these, so the evaluator's detection is proven by planting each violation in a copy of the
// selected candidate's metadata (the shared corpus is never touched) and checking that the evaluation sees it.
describe("the safety oracle is wired into the evaluation", () => {
  const plant = (patch: Record<string, unknown>) => {
    const run = runScenario(base, scenario("E01"), IDENTITY);
    const facet = run.ranking.facets.find((f) => f.selected.length > 0)!;
    const target = facet.selected[0] as unknown as { metadata: Record<string, unknown> };
    target.metadata = { ...target.metadata, ...patch };
    return { run, ev: evaluateScenario(run, index(), roles), facet };
  };

  it("detects stale evidence being presented (not current, published after the as-of date)", () => {
    const a = plant({ status: "superseded" });
    expect(a.ev.safety.stale).toHaveLength(1);
    expect(a.ev.safety.stale[0]).toContain("status:superseded");
    expect(a.ev.safety.wrong_geography).toEqual([]);
    expect(plant({ publicationDate: "2999-01-01" }).ev.safety.stale[0]).toContain("published_after_as_of");
    expect(plant({ validFrom: "2999-01-01" }).ev.safety.stale[0]).toContain("not_yet_valid");
  });

  it("detects evidence for another place being presented, and counts correctly placed local evidence", () => {
    const a = plant({ geoScope: "district", geoRegionId: "somewhere-else" });
    expect(a.ev.safety.wrong_geography).toHaveLength(1);
    // E01 already presents some correctly placed local evidence; the planted wrong-place chunk is the one that is not correct
    expect(a.ev.safety.local_scoped).toBeGreaterThanOrEqual(1);
    expect(a.ev.safety.local_correct).toBe(a.ev.safety.local_scoped - 1);
    const run = runScenario(base, scenario("E01"), IDENTITY);
    const state = run.inputs.facts.ancestors.find((x) => x.level === "state")!;
    const ok = plant({ geoScope: "state", geoRegionId: state.id });
    expect(ok.ev.safety.wrong_geography).toEqual([]);
    expect(ok.ev.safety.local_scoped).toBeGreaterThanOrEqual(1);
    expect(ok.ev.safety.local_correct).toBe(ok.ev.safety.local_scoped);
  });

  it("detects unverified and non-English sources being presented", () => {
    expect(plant({ language: "hi" }).ev.safety.other_ineligible[0]).toContain("language_not_english");
    expect(plant({ sourceClass: "unverified" }).ev.safety.other_ineligible[0]).toContain("unverified_source");
    expect(plant({ status: "draft" }).ev.safety.other_ineligible).toEqual([]);
  });

  it("the aggregate reports a planted violation with its denominator", () => {
    const { ev } = plant({ status: "withdrawn" });
    const a = aggregateRetrieval([ev], "t");
    expect(a.stale_evidence.selected_not_in_force).toMatchObject({ k: 1, n: ev.safety.selected });
    expect(a.wrong_geography.selected_outside_the_signal_place.k).toBe(0);
    const g = plant({ geoScope: "district", geoRegionId: "x" });
    expect(aggregateRetrieval([g.ev], "t").wrong_geography.selected_outside_the_signal_place.k).toBe(1);
    expect(aggregateRetrieval([plant({ language: "or" }).ev], "t").other_ineligible.selected_unverified_other_language_or_synthetic_in_production.k).toBe(1);
  });

  it("a hard-negative document that is selected fails a SAFETY check; a missed gap or distractor is only a BEHAVIOUR check", () => {
    const run = runScenario(base, scenario("E01"), IDENTITY);
    const selectedDoc = run.ranking.facets.flatMap((f) => f.selected)[0].canonicalId!;
    const withExpected = (e: Partial<typeof run.scenario.expected>) => ({ ...run, scenario: { ...run.scenario, expected: { ...run.scenario.expected, ...e } } });
    const hard = evaluateScenario(withExpected({ must_not_select: [selectedDoc] }), index(), roles);
    const failedHard = hard.checks.find((c) => c.name === "no hard-negative document is selected")!;
    expect(failedHard).toMatchObject({ kind: "safety", ok: false });
    expect(failedHard.detail).toContain(selectedDoc);
    const soft = evaluateScenario(withExpected({ should_not_select: [selectedDoc], gap_codes_include: ["no_such_gap"], gap_codes_exclude: [...evaluateScenario(run, index(), roles).gaps] }), index(), roles);
    expect(soft.checks.filter((c) => !c.ok).every((c) => c.kind === "behaviour")).toBe(true);
    expect(soft.checks.filter((c) => !c.ok).length).toBeGreaterThanOrEqual(2);
  });

  it("an abstaining scenario is only correct if the no_eligible_evidence gap is stated and nothing is presented", () => {
    const s = findScenario((x) => x.expected.abstain);
    const run = runScenario(base, s, IDENTITY);
    expect(evaluateScenario(run, index(), roles).abstention.correct).toBe(true);
    const noGap = { ...run, ranking: { ...run.ranking, gaps: run.ranking.gaps.filter((g) => g.code !== "no_eligible_evidence") } };
    const e = evaluateScenario(noGap, index(), roles);
    expect(e.abstention.correct).toBe(false);
    expect(e.checks.find((c) => c.name.includes("no_eligible_evidence"))).toMatchObject({ kind: "safety", ok: false });
    const presenting = plant({}).run;
    const asAbstain = evaluateScenario({ ...presenting, scenario: { ...presenting.scenario, expected: { ...presenting.scenario.expected, abstain: true } } }, index(), roles);
    expect(asAbstain.abstention).toMatchObject({ expected: true, abstained: false, correct: false });
    expect(asAbstain.checks.find((c) => c.name.startsWith("abstains: nothing is selected"))).toMatchObject({ kind: "safety", ok: false });
  });
});

describe("duplicate thresholds", () => {
  const words = (n: number, edit: number[] = []) => Array.from({ length: n }, (_, i) => (edit.includes(i) ? `zz${i}` : `wa${i}`)).join(" ");
  it("one changed word in forty keeps Jaccard just above 0.85 (a duplicate); two changes drop it to about 0.73 (not a duplicate)", () => {
    expect(textJaccard(words(40), words(40, [20]))).toBeCloseTo(35 / 41, 5);
    expect(countDuplicates([{ canonicalId: "a", text: words(40) }, { canonicalId: "b", text: words(40, [20]) }], roles)).toBe(1);
    expect(textJaccard(words(40), words(40, [10, 30]))).toBeCloseTo(32 / 44, 5);
    expect(countDuplicates([{ canonicalId: "a", text: words(40) }, { canonicalId: "b", text: words(40, [10, 30]) }], roles)).toBe(0);
  });

  it("an annotated redundant-copy family is counted from 0.5, between DIFFERENT documents only", () => {
    const [copyId, r] = Object.entries(roles.roles).find(([, x]) => x.redundant_copy_of)!;
    const pair = (a: string, b: string) => [{ canonicalId: a, text: words(40) }, { canonicalId: b, text: words(40, [10, 30]) }];
    expect(countDuplicates(pair(r.redundant_copy_of!, copyId), roles)).toBe(1);
    expect(countDuplicates(pair(copyId, r.redundant_copy_of!), roles)).toBe(1);
    expect(countDuplicates(pair("unrelated-a", "unrelated-b"), roles)).toBe(0);
    expect(countDuplicates(pair(copyId, copyId), roles)).toBe(0);
  });
});

describe("source quality (tier is presentation priority, not truth)", () => {
  const withClass = (sourceClass: string) => {
    const run = runScenario(base, scenario("E01"), IDENTITY);
    const target = run.ranking.facets.find((f) => f.selected.length > 0)!.selected[0] as unknown as { metadata: Record<string, unknown> };
    target.metadata = { ...target.metadata, sourceClass };
    return evaluateScenario(run, index(), roles).source_quality.selected_high_tier;
  };

  it("high tier means the first three source classes: intergovernmental, national and state health authorities", () => {
    expect(HIGH_TIER_CLASSES).toEqual(SOURCE_CLASS_TIERS.slice(0, 3));
    expect(HIGH_TIER_CLASSES).toEqual(["intergovernmental_health_authority", "national_government_health_agency", "state_government_health_agency"]);
    const a = aggregateRetrieval([evaluateScenario(runScenario(base, scenario("E01"), IDENTITY), index(), roles)], "t");
    expect(a.source_quality.high_tier_classes).toEqual(HIGH_TIER_CLASSES);
    expect(a.source_quality.note).toMatch(/not truth/);
  });

  it("counts a presented chunk as high tier by its source class", () => {
    const low = withClass("other_verified");
    expect(withClass("peer_reviewed_literature")).toBe(low);
    expect(withClass("recognized_institution")).toBe(low);
    for (const high of HIGH_TIER_CLASSES) expect(withClass(high), high).toBeGreaterThanOrEqual(low + 1);
  });
});

describe("duplicates and abstention are carried through to the aggregate", () => {
  it("a scenario that presents a near-copy is counted, and the aggregate sums the scenarios' counts", () => {
    const evals = set.scenarios.map((s) => evaluateScenario(runScenario(base, s, IDENTITY), index(), roles));
    const withDup = evals.filter((e) => e.safety.duplicates > 0);
    expect(withDup.length).toBeGreaterThan(0);
    const a = aggregateRetrieval(evals, "t");
    expect(a.duplicates.selected_that_duplicate_an_earlier_selection.k).toBe(evals.reduce((n, e) => n + e.safety.duplicates, 0));
    expect(a.duplicates.selected_that_duplicate_an_earlier_selection.k).toBeGreaterThan(0);
  });

  it("scenario abstention counts only abstentions that were correct: an abstain scenario that presents evidence scores 0 of 1", () => {
    const run = runScenario(base, scenario("E01"), IDENTITY);
    const asAbstain = evaluateScenario({ ...run, scenario: { ...run.scenario, expected: { ...run.scenario.expected, abstain: true } } }, index(), roles);
    expect(asAbstain.abstention.correct).toBe(false);
    const a = aggregateRetrieval([asAbstain], "t");
    expect(a.abstention.no_evidence_scenarios_abstained_correctly).toMatchObject({ k: 0, n: 1, value: 0 });
    const right = evaluateScenario(runScenario(base, findScenario((x) => x.expected.abstain), IDENTITY), index(), roles);
    expect(aggregateRetrieval([asAbstain, right], "t").abstention.no_evidence_scenarios_abstained_correctly).toMatchObject({ k: 1, n: 2 });
  });
});
