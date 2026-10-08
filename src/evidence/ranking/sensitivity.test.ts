// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RETRIEVAL_CONFIG_DEV } from "../retrieval/config";
import { retrieveFromCorpus } from "../retrieval/retrieve";
import { makeFacts, viewFromPrepared } from "../retrieval/testkit";
import { RANKING_CONFIG_V1, rankingConfigHash } from "./policy";
import { rankEvidence } from "./rank";
import { sensitivityScenarios } from "./scenarios";
import { analyseSensitivity, buildPerturbations, jaccardOfLists, kendallTau, survivorOrder } from "./sensitivity";

const ARTEFACT = join(process.cwd(), "data", "evidence", "ranking", "m4-3-sensitivity-v1.json");
const lf = (s: string) => s.replace(/\r\n/g, "\n");

describe("rank-order metric (Kendall's tau)", () => {
  it("is 1 for identical order and -1 for reversed order", () => {
    expect(kendallTau(["a", "b", "c", "d"], ["a", "b", "c", "d"])).toBe(1);
    expect(kendallTau(["a", "b", "c", "d"], ["d", "c", "b", "a"])).toBe(-1);
  });

  it("falls by 2/(n(n-1)) for each adjacent swap", () => {
    expect(kendallTau(["a", "b", "c", "d"], ["b", "a", "c", "d"])).toBeCloseTo(1 - 2 / 6, 12);
    expect(kendallTau(["a", "b", "c"], ["a", "c", "b"])).toBeCloseTo(1 - 2 / 3, 12);
  });

  it("is computed over the items both orders share, and is trivially 1 with fewer than two", () => {
    expect(kendallTau(["a", "b", "x"], ["b", "a", "y"])).toBe(-1);
    expect(kendallTau(["a"], ["a"])).toBe(1);
    expect(kendallTau([], [])).toBe(1);
    expect(kendallTau(["a", "b"], ["c", "d"])).toBe(1);
  });

  it("is symmetric", () => {
    const a = ["a", "b", "c", "d", "e"];
    const b = ["c", "a", "e", "b", "d"];
    expect(kendallTau(a, b)).toBeCloseTo(kendallTau(b, a), 12);
  });
});

describe("top-K membership metric", () => {
  it("is the Jaccard overlap of the two selected lists", () => {
    expect(jaccardOfLists(["a", "b", "c"], ["a", "b", "c"])).toBe(1);
    expect(jaccardOfLists(["a", "b", "c"], ["a", "b", "d"])).toBe(0.5);
    expect(jaccardOfLists(["a"], ["b"])).toBe(0);
    expect(jaccardOfLists([], [])).toBe(1);
    expect(jaccardOfLists(["a", "b"], ["b", "a"])).toBe(1); // membership, not order
  });
});

describe("the fixed perturbation set", () => {
  const ps = buildPerturbations(RANKING_CONFIG_V1);

  it("is a pure function of the baseline: the same every time, with unique ids", () => {
    expect(buildPerturbations(RANKING_CONFIG_V1).map((p) => p.id)).toEqual(ps.map((p) => p.id));
    expect(new Set(ps.map((p) => p.id)).size).toBe(ps.length);
  });

  it("contains slight single-class changes (half and full tier step), ladder re-spacings, an ablation and floor changes", () => {
    const by = (family: string) => ps.filter((p) => p.family === family);
    expect(by("class_single_half_step")).toHaveLength(13); // 7 classes x 2 directions, minus the top class's no-op increase
    expect(by("class_single_full_step")).toHaveLength(13);
    expect(by("class_ladder_spacing")).toHaveLength(3);
    expect(by("class_flat")).toHaveLength(1);
    expect(by("relevance_floor")).toHaveLength(2);
    expect(ps).toHaveLength(32);
  });

  it("never includes a no-op, so stability cannot be inflated by perturbations that change nothing", () => {
    const base = rankingConfigHash(RANKING_CONFIG_V1);
    for (const p of ps) expect(rankingConfigHash(p.config), p.id).not.toBe(base);
    expect(new Set(ps.map((p) => rankingConfigHash(p.config))).size).toBe(ps.length);
  });

  it("only touches the class table (or the floor): geography, time, dedup and diversity policy are held fixed", () => {
    for (const p of ps) {
      expect(p.config.geoFactor, p.id).toEqual(RANKING_CONFIG_V1.geoFactor);
      expect(p.config.temporalFactor, p.id).toEqual(RANKING_CONFIG_V1.temporalFactor);
      expect(p.config.dedup, p.id).toEqual(RANKING_CONFIG_V1.dedup);
      expect(p.config.diversity, p.id).toEqual(RANKING_CONFIG_V1.diversity);
      expect(p.config.selection, p.id).toEqual(RANKING_CONFIG_V1.selection);
      if (p.family !== "relevance_floor") expect(p.config.relevance.floor, p.id).toBe(RANKING_CONFIG_V1.relevance.floor);
      if (p.family === "relevance_floor") expect(p.config.classFactor.table, p.id).toEqual(RANKING_CONFIG_V1.classFactor.table);
    }
  });

  it("keeps every perturbed factor in (0, 1] and the single-class steps small", () => {
    for (const p of ps) {
      for (const v of Object.values(p.config.classFactor.table)) {
        if (v === null) continue;
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    for (const p of ps.filter((x) => x.family === "class_single_full_step")) {
      const diffs = Object.entries(p.config.classFactor.table).filter(([k, v]) => v !== (RANKING_CONFIG_V1.classFactor.table as Record<string, number | null>)[k]);
      expect(diffs).toHaveLength(1);
      expect(Math.abs((diffs[0][1] as number) - ((RANKING_CONFIG_V1.classFactor.table as Record<string, number | null>)[diffs[0][0]] as number))).toBeLessThanOrEqual(0.05 + 1e-9);
    }
  });

  it("holds the retrieval candidates fixed: only the ranking changes", () => {
    const facts = makeFacts();
    const retrieval = retrieveFromCorpus(viewFromPrepared(), facts, RETRIEVAL_CONFIG_DEV);
    const base = rankEvidence({ facts, retrieval, view: viewFromPrepared() });
    for (const p of ps) expect(rankEvidence({ facts, retrieval, view: viewFromPrepared(), config: p.config }).retrieval, p.id).toEqual(base.retrieval);
  });
});

describe("survivor order", () => {
  it("lists every candidate that survived floor and dedup, selected ones in presentation order", () => {
    const facts = makeFacts();
    const r = rankEvidence({ facts, retrieval: retrieveFromCorpus(viewFromPrepared(), facts, RETRIEVAL_CONFIG_DEV), view: viewFromPrepared() });
    for (const f of r.facets) {
      const order = survivorOrder(f);
      expect(order).toHaveLength(f.stats.afterDedup);
      const selected = f.selected.map((c) => `${c.canonicalId}#${c.chunkOrdinal}`);
      expect(order.filter((id) => selected.includes(id))).toEqual(selected);
    }
  });
});

describe("the sensitivity report", () => {
  const scenarios = sensitivityScenarios();
  const report = analyseSensitivity(scenarios, RANKING_CONFIG_V1);

  it("covers every syndrome in three places over the synthetic corpus, with all four facets", () => {
    expect(scenarios).toHaveLength(15);
    expect(report.scenarios).toHaveLength(15);
    expect(report.perturbations).toHaveLength(32);
    expect(report.totals.cases).toBe(15 * 32 * 4);
    expect(report.totals.casesWithEvidence + report.totals.emptyFacetCases).toBe(report.totals.cases);
  });

  it("is reproducible bit for bit", () => {
    expect(analyseSensitivity(scenarios, RANKING_CONFIG_V1).hash).toBe(report.hash);
    expect(JSON.stringify(analyseSensitivity(scenarios, RANKING_CONFIG_V1))).toBe(JSON.stringify(report));
  });

  it("matches the committed report exactly (regenerate with `npm run evidence:sensitivity` only for a reviewed policy change)", () => {
    expect(lf(readFileSync(ARTEFACT, "utf8"))).toBe(JSON.stringify(report, null, 2) + "\n");
  });

  it("records what it measured and refuses to over-claim", () => {
    expect(report.notice).toMatch(/policy constants, not estimates/);
    expect(report.notice).toMatch(/does not validate them/);
    expect(report.notice).toMatch(/synthetic corpus cannot show real-world robustness/);
    expect(report.baseline.rankingConfigHash).toBe(rankingConfigHash(RANKING_CONFIG_V1));
  });

  it("keeps every metric inside its range and the family aggregates consistent with the cases", () => {
    for (const f of report.byFamily) {
      expect(f.meanTau).toBeGreaterThanOrEqual(-1);
      expect(f.meanTau).toBeLessThanOrEqual(1);
      expect(f.minTau).toBeLessThanOrEqual(f.meanTau);
      expect(f.minSelectedJaccard).toBeLessThanOrEqual(f.meanSelectedJaccard);
      expect(f.selectedOrderIdentical).toBeLessThanOrEqual(f.cases);
      expect(f.leadChanged).toBeLessThanOrEqual(f.cases);
    }
    const perPert = report.byPerturbation.reduce((n, p) => n + p.cases, 0);
    expect(perPert).toBe(report.byFamily.reduce((n, f) => n + f.cases, 0));
    expect(report.leadChanges.length).toBe(report.byFamily.reduce((n, f) => n + f.leadChanged, 0));
  });

  it("lists every case where a perturbation changed the leading evidence, naming both items", () => {
    for (const c of report.leadChanges) {
      expect(c.from).not.toBeNull();
      expect(c.to).not.toBeNull();
      expect(c.from).not.toBe(c.to);
      expect(report.perturbations.map((p) => p.id)).toContain(c.perturbation);
    }
  });

  it("is a different report if the baseline policy changes (so it cannot be a stale copy)", () => {
    const tweaked = { ...RANKING_CONFIG_V1, relevance: { ...RANKING_CONFIG_V1.relevance, floor: 0.2 } };
    expect(analyseSensitivity(scenarios.slice(0, 3), tweaked).baseline.rankingConfigHash).not.toBe(report.baseline.rankingConfigHash);
  });
});
