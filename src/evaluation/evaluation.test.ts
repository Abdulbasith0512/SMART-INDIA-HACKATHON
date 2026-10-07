// @vitest-environment node
import { describe, expect, it } from "vitest";
import { clopperPearson, median, quantile } from "./stats";
import { creditedDay, evaluateRun, type EvalEpisode, type MatchRules } from "./match";
import type { OracleEvent } from "./oracle";
import { summarise } from "./metrics";
import { randomEvents, SEED_SPLITS } from "./replicates";
import { generateSyntheticDataset } from "../synthetic/generate";
import { buildOracle } from "./oracle";
import { datasetToDetectorInput } from "./adapter";
import { fixedThresholdEpisodes, earsC2Episodes } from "./comparators";

const rules: MatchRules = { tauDays: 2, maxWindow: 14, firstEvalDay: 18, lastDay: 89, syndromes: ["fever", "jaundice"], allBlocks: ["bA", "bB", "bC"] };

const ev = (over: Partial<OracleEvent> = {}): OracleEvent => ({
  id: "E1", kind: "true_cluster", syndrome: "fever", shape: "plateau", multiplier: 6, blocks: ["bA"], startDay: 40, endDay: 48,
  durationDays: 9, realizedReports: 30, reportDays: 9, evaluable: true, ...over,
});
const alarm = (day: number, w: number, involved = ["bA"]) => ({ day, windowStart: day - w + 1, windowEnd: day, involved });
const episode = (id: string, alarms: ReturnType<typeof alarm>[], syndrome = "fever", involved = ["bA"]): EvalEpisode => ({
  id, syndrome, firstAlarmDay: alarms[0].day, lastAlarmDay: alarms[alarms.length - 1].day, involved, alarms,
});

describe("statistics helpers", () => {
  it("exact binomial intervals (known values)", () => {
    const [lo, hi] = clopperPearson(4, 4);
    expect(hi).toBe(1);
    expect(lo).toBeCloseTo(0.3976, 3); // (alpha/2)^(1/4) = 0.025^0.25
    const [l2, h2] = clopperPearson(0, 10);
    expect(l2).toBe(0);
    expect(h2).toBeCloseTo(0.3085, 3);
    const [l3, h3] = clopperPearson(5, 10);
    expect(l3).toBeCloseTo(0.1871, 3);
    expect(h3).toBeCloseTo(0.8129, 3);
  });
  it("quantiles", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(quantile([10, 20, 30, 40, 50], 0.25)).toBe(20);
    expect(Number.isNaN(median([]))).toBe(true);
  });
});

describe("TP / FP / FN / TN definitions", () => {
  it("a persistent alarm inside the event is a detected cluster (TP episode) with a credited delay", () => {
    const e = episode("ep1", [alarm(43, 3), alarm(44, 3), alarm(45, 5)]);
    expect(creditedDay(e, ev(), rules)).toBe(43); // window 41-43 overlaps the event by 3 days, alarm day >= start + 1
    const r = evaluateRun([ev()], [e], rules);
    expect(r.detected).toBe(1);
    expect(r.tpEpisodes).toBe(1);
    expect(r.fpEpisodes).toBe(0);
    expect(r.events[0]).toMatchObject({ detected: true, delayDays: 3, lateDetected: false });
    expect(r.events[0].localization).toEqual({ jaccard: 1, exact: true, overreach: 0, missing: 0 });
  });

  it("no episode => the cluster is missed (FN), nothing is a false positive", () => {
    const r = evaluateRun([ev()], [], rules);
    expect(r.detected).toBe(0);
    expect(r.events[0]).toMatchObject({ detected: false, lateDetected: false, creditedDay: null, delayDays: null });
    expect(r.fpEpisodes).toBe(0);
  });

  it("an alarm elsewhere / for another syndrome is a false-positive episode", () => {
    const wrongBlock = episode("w1", [alarm(43, 3, ["bB"]), alarm(44, 3, ["bB"])], "fever", ["bB"]);
    const wrongSyndrome = episode("w2", [alarm(43, 3), alarm(44, 3)], "jaundice");
    const early = episode("w3", [alarm(20, 3), alarm(21, 3)]);
    const r = evaluateRun([ev()], [wrongBlock, wrongSyndrome, early], rules);
    expect(r.detected).toBe(0);
    expect(r.fpEpisodes).toBe(3);
    expect(r.episodes.every((l) => l.label === "FP" && l.fpKind === "spurious")).toBe(true);
  });

  it("pre-onset coincidence does not earn credit: an alarm on the start day, or a window touching only one event day", () => {
    const onStart = episode("c1", [alarm(40, 7)]); // day == start: not credited
    expect(creditedDay(onStart, ev(), rules)).toBeNull();
    const oneDay = episode("c2", [alarm(41, 2)]); // window 40-41 overlaps 2 days, alarm day start+1: ok
    expect(creditedDay(oneDay, ev(), rules)).toBe(41);
    const touch = episode("c3", [alarm(41, 1)]); // single-day window -> only 1 covered day
    expect(creditedDay(touch, ev(), rules)).toBeNull();
    const accumulated = episode("c4", [alarm(41, 1), alarm(42, 1)]); // daily alarms accumulate coverage
    expect(creditedDay(accumulated, ev(), rules)).toBe(42);
  });

  it("a lagging alarm after the event is 'late', not in-time", () => {
    const late = episode("l1", [alarm(53, 14), alarm(54, 14)]); // window 40-53 overlaps all 9 days, day 53 > end(48) + tau(2)
    const r = evaluateRun([ev()], [late], rules);
    expect(r.detected).toBe(0);
    expect(r.lateOnly).toBe(1);
    expect(r.events[0].lateDetected).toBe(true);
    expect(r.tpEpisodes).toBe(1); // it did credit the event
  });

  it("fragmentation: extra crediting episodes are counted, not treated as false positives", () => {
    const a = episode("f1", [alarm(43, 3), alarm(44, 3)]);
    const b = episode("f2", [alarm(47, 3), alarm(48, 3)]);
    const r = evaluateRun([ev()], [a, b], rules);
    expect(r.detected).toBe(1);
    expect(r.fragments).toBe(1);
    expect(r.fpEpisodes).toBe(0);
  });

  it("localization: over-reach and missed blocks are measured", () => {
    const over = episode("o1", [alarm(43, 3, ["bA", "bB"]), alarm(44, 3, ["bA", "bB"])], "fever", ["bA", "bB"]);
    const r = evaluateRun([ev()], [over], rules);
    expect(r.events[0].localization).toMatchObject({ jaccard: 0.5, exact: false, overreach: 1, missing: 0 });
    const two = ev({ blocks: ["bA", "bB"] });
    const under = episode("u1", [alarm(43, 3), alarm(44, 3)]);
    expect(evaluateRun([two], [under], rules).events[0].localization).toMatchObject({ jaccard: 0.5, overreach: 0, missing: 1 });
  });

  it("decoy rejection: no overlapping episode = rejected (good); an overlapping one is a decoy false alert and an FP", () => {
    const decoy = ev({ id: "D1", kind: "decoy_reporting_artifact", blocks: ["bC"], startDay: 50, endDay: 50, durationDays: 1, evaluable: false, variant: "bulk_import_1d" });
    const clean = evaluateRun([decoy], [], rules);
    expect(clean.decoyFalseAlerts).toBe(0);
    expect(clean.events[0].alerted).toBe(false);
    const alerted = evaluateRun([decoy], [episode("d1", [alarm(52, 3, ["bC"]), alarm(53, 3, ["bC"])], "fever", ["bC"])], rules);
    expect(alerted.decoyFalseAlerts).toBe(1);
    expect(alerted.episodes[0]).toMatchObject({ label: "FP", fpKind: "decoy" });
  });

  it("an episode explained by a true cluster is not also counted as a decoy false alert", () => {
    const decoy = ev({ id: "D9", kind: "decoy_reporting_artifact", startDay: 30, endDay: 30, durationDays: 1, evaluable: false });
    const cluster = ev(); // same syndrome and block, starts 10 days after the decoy ends
    const e = episode("ex", [alarm(43, 3), alarm(44, 3)]);
    const r = evaluateRun([cluster, decoy], [e], rules);
    expect(r.detected).toBe(1);
    expect(r.decoyFalseAlerts).toBe(0);
    expect(r.fpEpisodes).toBe(0);
  });

  it("unit grid: positives, grace zone (excluded), false-positive units and TN arithmetic", () => {
    const e = ev();
    const good = episode("g", [alarm(43, 3), alarm(44, 3)]); // 2 alarm units, both inside the event window (positive)
    const spurious = episode("s", [alarm(70, 5, ["bB"]), alarm(71, 5, ["bB"])], "fever", ["bB"]); // 2 FP units
    const lag = episode("lag", [alarm(50, 14)]); // in the grace zone after the event -> neither positive nor FP
    const r = evaluateRun([e], [good, spurious, lag], rules);
    const total = 3 * 2 * (89 - 18 + 1);
    expect(r.units.positive).toBe(9);
    expect(r.units.positiveAlarmed).toBe(2);
    expect(r.units.falsePositive).toBe(2);
    expect(r.units.negative).toBe(total - 9 - 14); // grace zone: days 49..62 (14 days) for the event block
  });
});

describe("aggregation", () => {
  it("summarises recall, precision, delay, decoys and false episodes per run with intervals", () => {
    const hit = evaluateRun([ev()], [episode("a", [alarm(43, 3), alarm(44, 3)])], rules);
    const miss = evaluateRun([ev()], [], rules);
    const fa = evaluateRun([ev()], [episode("x", [alarm(70, 5, ["bB"]), alarm(71, 5, ["bB"])], "fever", ["bB"])], rules);
    const s = summarise([hit, miss, fa], "unit");
    expect(s.clusters.all).toMatchObject({ k: 1, n: 3 });
    expect(s.clusters.all.ci95[0]).toBeLessThan(s.clusters.all.value);
    expect(s.episodes).toMatchObject({ tp: 1, fp: 1 });
    expect(s.episodes.falsePerRun.mean).toBeCloseTo(1 / 3, 3);
    expect(s.delay.median).toBe(3);
    expect(s.units.fpr).toBeGreaterThan(0);
  });
});

describe("replicates and comparators", () => {
  it("random events are deterministic per seed, well-formed and non-overlapping", () => {
    const a = randomEvents(1001), b = randomEvents(1001), c = randomEvents(1002);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
    expect(a.events.filter((e) => e.kind === "true_cluster")).toHaveLength(4);
    expect(a.events.filter((e) => e.kind === "decoy_reporting_artifact")).toHaveLength(2);
    for (const e of a.events) {
      expect(e.start_day).toBeGreaterThanOrEqual(24);
      expect(e.end_day).toBeLessThanOrEqual(88);
      if (e.kind === "true_cluster") expect(e.multiplier).toBeGreaterThanOrEqual(4);
    }
    expect(Object.keys(a.meta.decoyVariants).sort()).toEqual(["DA", "DB"]);
  });

  it("seed splits are disjoint (dev seeds can never leak into the held-out test split)", () => {
    const sets = Object.values(SEED_SPLITS).map((s) => new Set(s));
    for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) for (const x of sets[i]) expect(sets[j].has(x)).toBe(false);
  });

  it("the oracle reports realised counts and evaluability on the M2 dataset", () => {
    const ds = generateSyntheticDataset();
    const o = buildOracle(ds, 5);
    expect(o.map((e) => e.id)).toEqual(["P1", "P2", "P3", "P4", "D1"]);
    expect(o.find((e) => e.id === "P1")!.evaluable).toBe(true);
    expect(o.find((e) => e.id === "D1")!.evaluable).toBe(false);
    expect(o.every((e) => e.blocks.length >= 1)).toBe(true);
  });

  it("comparators produce episodes on the same data (benchmark only)", () => {
    const input = datasetToDetectorInput(generateSyntheticDataset({ seed: 5, events: [] }), 5);
    const syn = ["acute_diarrhoeal_illness", "fever", "fever_with_rash", "jaundice", "respiratory_illness"];
    const fixed = fixedThresholdEpisodes(input, syn);
    const c2 = earsC2Episodes(input, syn);
    expect(Array.isArray(fixed) && Array.isArray(c2)).toBe(true);
    for (const e of [...fixed, ...c2]) expect(e.alarms.length).toBeGreaterThan(0);
  });
});
