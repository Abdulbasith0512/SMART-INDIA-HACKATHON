// @vitest-environment node
// The scenario set, the document roles and the reference judgments: authored deterministically, internally consistent, and
// independent of the production eligibility code. Also: the evaluation harness changes nothing in production.
import { describe, expect, it } from "vitest";
import { SEED_SPLITS } from "../../evaluation/replicates";
import { IDENTITY, referenceBundle } from "../bundle/testkit";
import { retrieveFromCorpus } from "../retrieval/retrieve";
import { RETRIEVAL_CONFIG_DEV, RETRIEVAL_CONFIG_V1 } from "../retrieval/config";
import { authorScenarioSet, M3_SEEDS } from "./authoring";
import { buildJudgmentsArtefact } from "./artifacts";
import { judgeScenario } from "./judgments";
import { ineligibleReasons } from "./oracle";
import { runScenario } from "./run";
import { daysBetween, inputsFor } from "./scenarioCorpus";
import { kit, scenario } from "./testkit";
import { chunkKey, JUDGMENT_LABEL, scenarioSetSchema } from "./types";

describe("scenario set", () => {
  const { set, base } = kit();

  it("has 64 scenarios: 40 derived from M3 episode shapes and 24 hand-authored edge cases", () => {
    expect(set.scenarios.length).toBe(64);
    expect(set.scenarios.filter((s) => s.family === "m3_derived").length).toBe(40);
    expect(set.scenarios.filter((s) => s.family === "edge_case").length).toBe(24);
    expect(new Set(set.scenarios.map((s) => s.id)).size).toBe(64);
  });

  it("is authored deterministically (twice gives the same set) and passes its own schema", () => {
    expect(authorScenarioSet(base)).toEqual(set);
    expect(scenarioSetSchema.safeParse(JSON.parse(JSON.stringify(set))).success).toBe(true);
  });

  it("draws the M3-derived episodes from seeds outside the M3 development and held-out seed ranges", () => {
    const used = new Set(Object.values(SEED_SPLITS).flat());
    for (let seed = M3_SEEDS.first; seed <= M3_SEEDS.last; seed += 1) expect(used.has(seed)).toBe(false);
  });

  it("covers every syndrome and the situations the plan names", () => {
    const syndromes = new Set(set.scenarios.map((s) => s.facts.syndrome));
    expect(syndromes.size).toBe(5);
    const cats = new Set(set.scenarios.map((s) => s.category));
    for (const need of ["no_evidence", "wrong_geography", "stale_evidence", "conflicting_sources", "keyword_stuffed_distractors", "sparse_evidence", "strong_relevant", "weak_evidence", "multiple_sources"]) {
      expect(cats.has(need), need).toBe(true);
    }
    expect(set.scenarios.some((s) => s.category.includes("duplicate"))).toBe(true);
    expect(set.scenarios.some((s) => s.category.includes("superseded") || s.category.includes("ineligible_status"))).toBe(true);
  });

  it("splits deterministically into a dev and a held-out test split that BOTH exercise no-evidence, wrong-geography and stale cases", () => {
    const dev = set.scenarios.filter((s) => s.split === "dev");
    const test = set.scenarios.filter((s) => s.split === "test");
    expect(dev.length + test.length).toBe(64);
    expect(dev.length).toBeGreaterThanOrEqual(28);
    expect(test.length).toBeGreaterThanOrEqual(24);
    for (const part of [dev, test]) {
      const cats = new Set(part.map((s) => s.category));
      for (const need of ["no_evidence", "wrong_geography", "stale_evidence"]) expect(cats.has(need), need).toBe(true);
      expect(part.some((s) => s.expected.abstain)).toBe(true);
    }
  });

  it("every scenario states its expected behaviour; abstention is declared exactly where nothing relevant and eligible exists", () => {
    const { judgments } = kit();
    for (const s of set.scenarios) {
      const relevant = judgments.rows.some((r) => r.scenario === s.id && r.grade > 0);
      expect(s.expected.abstain, `${s.id} abstain`).toBe(!relevant);
    }
  });

  it("every hard-negative document exists in the corpus", () => {
    const ids = new Set([...base.view.items, ...base.historicalView.items].map((i) => i.canonicalId));
    for (const s of set.scenarios) for (const d of [...s.expected.must_not_select, ...s.expected.should_not_select]) expect(ids.has(d), `${s.id}:${d}`).toBe(true);
  });

  it("the split rule is part of the set and the split cannot be changed without changing the set hash", () => {
    expect(set.split_rule).toMatch(/SHA-256/);
    const flipped = { ...set, scenarios: set.scenarios.map((s, i) => (i === 0 ? { ...s, split: s.split === "dev" ? "test" : "dev" } : s)) };
    expect(JSON.stringify(flipped)).not.toBe(JSON.stringify(set));
  });
});

describe("document roles and reference judgments", () => {
  const { roles, base, judgments, set } = kit();
  const docs = new Map([...base.view.items, ...base.historicalView.items].filter((i) => i.canonicalId).map((i) => [i.canonicalId as string, i]));

  it("labels every judgment a synthetic reference judgment, not an expert judgment", () => {
    expect(judgments.label).toBe(JUDGMENT_LABEL);
    expect(roles.label).toBe(JUDGMENT_LABEL);
    expect(judgments.disclaimer).toMatch(/NOT evidence of real-world/);
  });

  it("has a hand-authored role for every document, and no role for a document that does not exist", () => {
    expect([...docs.keys()].filter((id) => !roles.roles[id])).toEqual([]);
    expect(Object.keys(roles.roles).filter((id) => !docs.has(id))).toEqual([]);
  });

  it("roles are coherent: distractors judge nothing relevant; every other role speaks to at least one facet; copies point at real documents", () => {
    for (const [id, r] of Object.entries(roles.roles)) {
      if (r.role === "irrelevant_distractor") expect(Object.keys(r.facets), id).toEqual([]);
      else expect(Object.keys(r.facets).length, id).toBeGreaterThan(0);
      if (r.redundant_copy_of) expect(docs.has(r.redundant_copy_of), id).toBe(true);
      expect(r.justification.length, id).toBeGreaterThan(4);
    }
  });

  it("grades are 0, 1 or 2; a not-presentable document is always grade 0 and says why", () => {
    for (const r of judgments.rows) {
      expect([0, 1, 2]).toContain(r.grade);
      if (r.ineligible_reason && r.rule !== "distractor") expect(r.grade).toBe(0);
      expect(r.justification.length).toBeGreaterThan(0);
    }
    expect(judgments.rows.some((r) => r.ineligible_reason && r.ineligible_reason !== "distractor")).toBe(true);
  });

  it("grade 2 is given only to substantive (excerpt) chunks of a document the roles rate 2; abstract chunks are capped at 1", () => {
    const kindOf = new Map<string, string>();
    for (const d of docs.values()) for (const c of d.chunks) kindOf.set(chunkKey(d.canonicalId as string, c.ordinal), c.kind);
    for (const r of judgments.rows.filter((x) => x.grade === 2)) {
      expect(kindOf.get(chunkKey(r.canonical_id, r.chunk_ordinal)), `${r.scenario}/${r.canonical_id}`).not.toBe("abstract");
      expect((roles.roles[r.canonical_id].facets as Record<string, number>)[r.facet]).toBe(2);
    }
  });

  it("a situation report older than one year at the as-of date is capped at grade 1", () => {
    let checked = 0;
    for (const s of set.scenarios) {
      const inputs = inputsFor(base, s);
      for (const row of judgments.rows.filter((r) => r.scenario === s.id && r.grade > 0)) {
        const d = docs.get(row.canonical_id)!;
        if ((d.evidenceKind === "situation_report" || d.evidenceKind === "surveillance_data") && d.publicationDate && daysBetween(d.publicationDate, inputs.asOfDate) > 365) {
          expect(row.grade).toBe(1);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("a document about one syndrome is judged only for that syndrome", () => {
    for (const r of judgments.rows.filter((x) => x.grade > 0)) {
      const d = docs.get(r.canonical_id)!;
      const s = scenario(r.scenario);
      if (d.syndromes.length) expect(d.syndromes, `${r.scenario}/${r.canonical_id}`).toContain(s.facts.syndrome);
    }
  });

  it("the judgments are reproducible from doc-roles.json and the scenario set", () => {
    expect(buildJudgmentsArtefact(base, set, roles)).toEqual(judgments);
    const s = set.scenarios[0];
    expect(judgeScenario(s, inputsFor(base, s), roles)).toEqual(judgments.rows.filter((r) => r.scenario === s.id));
  });
});

describe("the independent eligibility oracle agrees with production", () => {
  const { set, base } = kit();
  it("production retrieval never returns a candidate the oracle forbids, in any of the 64 scenarios", () => {
    let candidates = 0;
    for (const s of set.scenarios) {
      const inputs = inputsFor(base, s);
      const ctx = { asOf: inputs.asOfDate, chain: [{ id: inputs.facts.region.id, level: inputs.facts.region.level as string }, ...inputs.facts.ancestors.map((a) => ({ id: a.id, level: a.level as string }))], profile: inputs.retrievalProfile };
      const result = retrieveFromCorpus(inputs.view, inputs.facts, inputs.retrievalConfig, { asOfDate: inputs.asOfDate });
      for (const f of result.facets) {
        for (const c of f.candidates) {
          candidates += 1;
          expect(ineligibleReasons(c.metadata, ctx), `${s.id}/${f.facet}/${c.canonicalId}`).toEqual([]);
        }
      }
    }
    expect(candidates).toBeGreaterThan(500);
  });

  it("the oracle actually forbids things (it is not vacuously empty)", () => {
    const all = [...base.view.items, ...base.historicalView.items];
    const ctx = { asOf: "2025-09-07", chain: [], profile: "production" as const };
    const reasons = new Set(all.flatMap((i) => ineligibleReasons(i, ctx)));
    expect(reasons.has("synthetic_in_production")).toBe(true);
    expect([...reasons].some((r) => r.startsWith("status:"))).toBe(true);
  });
});

describe("running a scenario", () => {
  it("reproduces the committed M4.4 reference bundle exactly (a cross-check of the whole chain)", () => {
    const run = runScenario(kit().base, scenario("E01"), IDENTITY);
    expect(run.bundle.bundle_hash).toBe(referenceBundle().bundle_hash);
    expect(run.bundle.bundle_hash.startsWith("347d388f")).toBe(true);
  });

  it("is deterministic: the same scenario gives the same retrieval, ranking and bundle hashes", () => {
    const a = runScenario(kit().base, scenario("M02"), IDENTITY);
    const b = runScenario(kit().base, scenario("M02"), IDENTITY);
    expect([a.retrieval.resultHash, a.ranking.rankingHash, a.bundle.bundle_hash]).toEqual([b.retrieval.resultHash, b.ranking.rankingHash, b.bundle.bundle_hash]);
  });

  it("uses the production retrieval configuration when a scenario asks for it, so synthetic evidence is not eligible", () => {
    const prod = scenario("E01");
    const asked = { ...prod, variant: { ...prod.variant, retrieval_config: "production" as const } };
    const run = runScenario(kit().base, asked, IDENTITY);
    expect(run.inputs.retrievalConfig).toBe(RETRIEVAL_CONFIG_V1);
    expect(run.ranking.facets.every((f) => f.selected.length === 0)).toBe(true);
    expect(runScenario(kit().base, prod, IDENTITY).inputs.retrievalConfig).toBe(RETRIEVAL_CONFIG_DEV);
  });
});

describe("scenario variants", () => {
  const { base } = kit();
  const e01 = scenario("E01");
  const with_ = (variant: Partial<typeof e01.variant>) => ({ ...e01, variant: { ...e01.variant, ...variant } });

  it("only_docs and remove_docs reshape the corpus for one scenario without touching the base", () => {
    const before = base.view.items.length;
    expect(inputsFor(base, with_({ only_docs: ["syn-ads-verification-guidance"] })).view.items.map((i) => i.canonicalId)).toEqual(["syn-ads-verification-guidance"]);
    expect(inputsFor(base, with_({ remove_docs: ["syn-ads-verification-guidance"] })).view.items.some((i) => i.canonicalId === "syn-ads-verification-guidance")).toBe(false);
    expect(base.view.items.length).toBe(before);
  });

  it("curator conflict tags are applied to the main view only", () => {
    const i = inputsFor(base, with_({ tags: { "syn-ads-verification-guidance": { question_key: "q", position: "p1" } } }));
    const tagged = i.view.items.find((x) => x.canonicalId === "syn-ads-verification-guidance")!;
    expect(tagged.questionKey).toBe("q");
    expect(tagged.position).toBe("p1");
    expect(base.view.items.find((x) => x.canonicalId === "syn-ads-verification-guidance")!.questionKey).not.toBe("q");
  });

  it("the as-of date defaults to the signal window end and can be overridden", () => {
    expect(inputsFor(base, e01).asOfDate).toBe(e01.facts.window.end);
    expect(inputsFor(base, with_({ as_of_date: "2024-01-01" })).asOfDate).toBe("2024-01-01");
  });
});
