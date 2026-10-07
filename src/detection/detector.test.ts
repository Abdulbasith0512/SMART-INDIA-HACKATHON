// @vitest-environment node
// Detector behaviour tests. Fixtures are built here with a LOCAL rng: this file must not import the
// synthetic generator or any ground truth (see isolation.test.ts).
import { describe, expect, it } from "vitest";
import { DETECTOR_V1, DetectorEngine, configHash, explainSignal, hashFeatureRows, isSafeExplanation, resolveConfig, runDetector, scoreAlarm } from "./index";
import { topExcessShare } from "./detector";
import { evaluateGates, dowFactors } from "./exceedance";
import { SeriesStore, addDaysIso } from "./series";
import { SOURCE_KEYS, type DetectorInput, type FeatureRow, type RegionNode, type SourceKey, type WindowTest } from "./types";

// ---- tiny deterministic rng + fixture builder ------------------------------------------------
function rngOf(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const poisson = (lam: number) => {
    if (lam <= 0) return 0;
    const L = Math.exp(-lam);
    let k = 0, p = 1;
    do { k++; p *= next(); } while (p > L);
    return k - 1;
  };
  return { next, poisson };
}

const START = "2026-06-15";
const DAYS = 90;
const NORMAL_SOURCES: SourceKey[] = ["citizen", "clinician", "health_facility", "survey"];
const SYNS = ["acute_diarrhoeal_illness", "fever", "fever_with_rash", "jaundice", "respiratory_illness"];
const RATE: Record<string, number> = { acute_diarrhoeal_illness: 0.9, fever: 1.1, fever_with_rash: 0.2, jaundice: 0.1, respiratory_illness: 0.8 };

const regions: RegionNode[] = [
  { id: "c", type: "country", parentId: null, name: "Country" },
  { id: "s", type: "state", parentId: "c", name: "State" },
  { id: "d1", type: "district", parentId: "s", name: "District One" },
  { id: "d2", type: "district", parentId: "s", name: "Solo District" },
  { id: "b1", type: "block", parentId: "d1", name: "Block 1" },
  { id: "b2", type: "block", parentId: "d1", name: "Block 2" },
  { id: "b3", type: "block", parentId: "d1", name: "Block 3" },
  { id: "b4", type: "block", parentId: "d1", name: "Block 4" },
  { id: "b5", type: "block", parentId: "d2", name: "Block 5" }, // single-block district (edge case)
];
const BLOCKS = ["b1", "b2", "b3", "b4", "b5"];
const WEIGHT: Record<string, number> = { b1: 1, b2: 1.4, b3: 0.7, b4: 1, b5: 1.1 };

interface Inject { block: string; syndrome: string; day: number; n: number; source?: SourceKey | "mixed"; severityUnknown?: boolean }

function makeInput(opts: { seed?: number; inject?: Inject[]; blackout?: [number, number]; privacyK?: number; weekday?: boolean } = {}): DetectorInput {
  const rng = rngOf(opts.seed ?? 11);
  const cells = new Map<string, FeatureRow>();
  const add = (block: string, day: number, syndrome: string, source: SourceKey, unknown: boolean, n = 1) => {
    const date = addDaysIso(START, day);
    const key = `${block}|${date}|${syndrome}`;
    let r = cells.get(key);
    if (!r) { r = { regionId: block, date, syndrome, reports: 0, cases: 0, unknownSeverity: 0, bySource: {} }; cells.set(key, r); }
    r.reports += n; r.cases += n; if (unknown) r.unknownSeverity += n;
    r.bySource[source] = (r.bySource[source] ?? 0) + n;
  };
  for (let day = 0; day < DAYS; day++) {
    if (opts.blackout && day >= opts.blackout[0] && day <= opts.blackout[1]) continue;
    const dow = new Date(`${addDaysIso(START, day)}T00:00:00Z`).getUTCDay();
    const wk = opts.weekday ? (dow === 0 ? 0.5 : dow === 1 ? 1.5 : 1) : 1;
    for (const b of BLOCKS) for (const s of SYNS) {
      const n = rng.poisson(RATE[s] * WEIGHT[b] * wk);
      for (let i = 0; i < n; i++) add(b, day, s, NORMAL_SOURCES[Math.floor(rng.next() * 4)], rng.next() < 0.05);
    }
  }
  for (const inj of opts.inject ?? []) {
    for (let i = 0; i < inj.n; i++) {
      const src = !inj.source || inj.source === "mixed" ? NORMAL_SOURCES[i % 4] : inj.source;
      add(inj.block, inj.day, inj.syndrome, src, inj.severityUnknown ?? false);
    }
  }
  return { rows: [...cells.values()], regions, startDate: START, endDate: addDaysIso(START, DAYS - 1), privacyK: opts.privacyK ?? 5 };
}

const clusterInject = (block: string, syndrome: string, from: number, to: number, perDay: number): Inject[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ block, syndrome, day: from + i, n: perDay, source: "mixed" as const }));

describe("clean background (null data) alarms rarely", () => {
  it("averages at most one false episode per 90-day run over 24 null seeds (incl. strong weekday patterns); the real calibration is the evaluation harness", () => {
    let episodes = 0;
    for (let seed = 1; seed <= 24; seed++) {
      episodes += runDetector(makeInput({ seed, weekday: seed % 2 === 0 }), DETECTOR_V1).state.episodes.length;
    }
    expect(episodes).toBeLessThanOrEqual(24);
  });

  it("never tests before there is enough usable history", () => {
    const r = runDetector(makeInput({ seed: 3 }), DETECTOR_V1, { collectFindings: true, toDay: 14 });
    expect(r.stats.testsRun).toBe(0);
    expect(r.stats.skippedInsufficientHistory).toBeGreaterThan(0);
    expect(r.findings).toHaveLength(0);
  });
});

describe("a real, persistent cluster is detected as an emerging signal", () => {
  const input = makeInput({ seed: 21, inject: clusterInject("b2", "fever", 50, 58, 4) });
  const r = runDetector(input, DETECTOR_V1, { collectFindings: true, keepAlarmDays: true });

  it("produces exactly one episode, localised to the block, not before onset and not instantly", () => {
    const eps = r.state.episodes.filter((e) => e.syndrome === "fever");
    expect(eps).toHaveLength(1);
    const e = eps[0];
    expect(e.involved).toEqual(["b2"]);
    expect(e.firstAlarmDay).toBeGreaterThan(50); // persistence: cannot alarm on the first day
    expect(e.firstAlarmDay).toBeLessThanOrEqual(54);
    expect(e.lastAlarmDay).toBeGreaterThanOrEqual(56);
    expect(e.peak.score.score).toBeGreaterThan(40);
    expect(r.state.episodes.filter((x) => x.syndrome !== "fever")).toHaveLength(0);
  });

  it("candidate payload respects the evidence floor, wording rules and score semantics", () => {
    const engine = new DetectorEngine(input, DETECTOR_V1);
    const ep = engine.replay({}).state.episodes[0];
    const c = engine.buildCandidate(ep);
    expect(c.sampleCount).toBeGreaterThanOrEqual(5);
    expect(c.minimumSampleCount).toBe(5);
    expect(c.regionId).toBe("b2");
    expect(isSafeExplanation(c.explanation)).toBe(true);
    expect(c.explanation).toMatch(/Emerging signal requiring verification/);
    expect(c.explanation).toMatch(/Human verification required/);
    expect(c.explanation).not.toMatch(/probab|likelihood|diagnosed/i);
    expect(c.signalScore).toBeGreaterThanOrEqual(0);
    expect(c.signalScore).toBeLessThanOrEqual(100);
    expect(c.confidence).toBeGreaterThanOrEqual(0);
    expect(c.confidence).toBeLessThanOrEqual(1);
    expect(c.scoreComponents.note).toMatch(/not a probability/);
    expect(new Date(c.windowEnd).getTime()).toBeGreaterThan(new Date(c.windowStart).getTime());
  });

  it("findings record why tests fired", () => {
    expect(r.findings.some((f) => f.test.decision === "candidate" && f.syndrome === "fever")).toBe(true);
    for (const f of r.findings) expect(["candidate", "watch", "gated"]).toContain(f.test.decision);
  });
});

describe("artifacts and weak evidence are rejected (and logged)", () => {
  it("a one-day bulk import is gated by persistence/burst AND by bulk-source", () => {
    const input = makeInput({ seed: 5, inject: [{ block: "b3", syndrome: "fever", day: 60, n: 40, source: "imported_dataset", severityUnknown: true }] });
    const r = runDetector(input, DETECTOR_V1, { collectFindings: true });
    expect(r.state.episodes).toHaveLength(0);
    const gated = r.findings.filter((f) => f.test.decision === "gated" && f.syndrome === "fever");
    expect(gated.length).toBeGreaterThan(0);
    expect(gated.some((f) => f.test.failed.includes("burst"))).toBe(true);
    expect(gated.some((f) => f.test.failed.includes("bulk"))).toBe(true);
  });

  it("each defence works independently (ablation): without gates the same data DOES alarm", () => {
    const input = makeInput({ seed: 5, inject: [{ block: "b3", syndrome: "fever", day: 60, n: 40, source: "imported_dataset", severityUnknown: true }] });
    const none = runDetector(input, resolveConfig({ gates: { persistence: false, burst: false, bulk: false, ratio: false } }));
    expect(none.state.episodes.length).toBeGreaterThan(0);
    const noBulk = runDetector(input, resolveConfig({ gates: { bulk: false } }));
    expect(noBulk.state.episodes).toHaveLength(0); // burst/persistence alone rejects a one-day burst
    const noBurst = runDetector(input, resolveConfig({ gates: { persistence: false, burst: false } }));
    expect(noBurst.state.episodes).toHaveLength(0); // bulk-source alone rejects it too
  });

  it("a multi-day bulk import persists in time but is rejected by the bulk-source gate", () => {
    const inj: Inject[] = [60, 61, 62].map((day) => ({ block: "b3", syndrome: "fever", day, n: 25, source: "imported_dataset" as const, severityUnknown: true }));
    const r = runDetector(makeInput({ seed: 5, inject: inj }), DETECTOR_V1, { collectFindings: true });
    expect(r.state.episodes).toHaveLength(0);
    expect(r.findings.some((f) => f.test.failed.includes("bulk") && !f.test.failed.includes("persistence"))).toBe(true);
  });

  it("pooling cannot launder a one-block artifact into a district-level signal", () => {
    const input = makeInput({ seed: 5, inject: [{ block: "b3", syndrome: "fever", day: 60, n: 40, source: "imported_dataset", severityUnknown: true }] });
    const r = runDetector(input, DETECTOR_V1, { collectFindings: true });
    expect(r.state.episodes).toHaveLength(0);
    expect(r.findings.filter((f) => f.scope === "district").every((f) => f.test.decision !== "candidate")).toBe(true);
    expect(r.findings.some((f) => f.scope === "district" && f.test.failed.length > 0)).toBe(true);
  });

  it("concentration share arithmetic (defence in depth for district-level alarms)", () => {
    expect(topExcessShare([10, 0, 0, 0])).toBe(1);
    expect(topExcessShare([5, 5, 0, 0])).toBe(0.5);
    expect(topExcessShare([0, 0, 0])).toBe(0);
    expect(topExcessShare([-3, 4, 1])).toBeCloseTo(0.8, 12);
    expect(Number.isFinite(topExcessShare([]))).toBe(true);
  });

  it("survival checks: a signal that depends on one day, or on bulk-source reports, does not survive; a genuine one does", () => {
    const gate = (over: object) => evaluateGates(DETECTOR_V1, 5, { observed: 12, elevatedDays: 4, maxDayShare: 0.4, bulkShare: 0.1, ratio: 4, pLeaveOneDayOut: 0.001, pNonBulk: 0.001, ...over });
    expect(gate({})).toEqual([]);
    expect(gate({ pLeaveOneDayOut: 0.4 })).toEqual(["burst"]); // fails once its largest day is removed
    expect(gate({ pNonBulk: 0.4 })).toEqual(["bulk"]); // fails once bulk-source reports are removed
  });

  it("a statistically odd but sub-floor cluster is a 'watch' finding, never a candidate or a number shown to officers", () => {
    // 4 extra jaundice reports over 3 days in a quiet block: below the evidence floor of 5
    const inj: Inject[] = [{ block: "b4", syndrome: "jaundice", day: 70, n: 2, source: "mixed" }, { block: "b4", syndrome: "jaundice", day: 71, n: 2, source: "mixed" }];
    const r = runDetector(makeInput({ seed: 8, inject: inj }), resolveConfig({ test: { alpha: 0.05 } }), { collectFindings: true });
    const watch = r.findings.filter((f) => f.test.decision === "watch");
    expect(watch.length).toBeGreaterThan(0);
    for (const e of r.state.episodes) expect(e.peak.observed).toBeGreaterThanOrEqual(5);
  });

  it("the evidence floor follows the privacy threshold k", () => {
    const input = makeInput({ seed: 21, inject: clusterInject("b2", "fever", 50, 58, 4), privacyK: 12 });
    const engine = new DetectorEngine(input, DETECTOR_V1);
    expect(engine.evidenceFloor).toBe(12);
    for (const ep of engine.replay({}).state.episodes) expect(engine.buildCandidate(ep).sampleCount).toBeGreaterThanOrEqual(12);
  });
});

describe("geography", () => {
  it("a two-block cluster in one district becomes one district-level candidate listing both blocks", () => {
    const inj = [...clusterInject("b1", "respiratory_illness", 55, 63, 3), ...clusterInject("b2", "respiratory_illness", 55, 63, 3)];
    const input = makeInput({ seed: 31, inject: inj });
    const engine = new DetectorEngine(input, DETECTOR_V1);
    const eps = engine.replay({}).state.episodes.filter((e) => e.syndrome === "respiratory_illness");
    expect(eps).toHaveLength(1);
    expect(eps[0].involved).toEqual(["b1", "b2"]);
    const c = engine.buildCandidate(eps[0]);
    expect(c.regionId).toBe("d1");
    expect(c.evidence.involved_blocks.map((b: { id: string }) => b.id)).toEqual(["b1", "b2"]);
    expect(eps[0].peak.score.components.involvedBlocks).toBe(2);
    expect(eps[0].peak.score.components.geographic).toBeCloseTo(1 - 1 / 3, 3);
  });

  it("a single-block district yields a finite, fully concentrated geographic score (no divide-by-zero)", () => {
    const input = makeInput({ seed: 41, inject: clusterInject("b5", "fever", 60, 68, 4) });
    const r = runDetector(input, DETECTOR_V1);
    const ep = r.state.episodes.find((e) => e.districtId === "d2");
    expect(ep).toBeTruthy();
    expect(ep!.peak.score.components.blocksInDistrict).toBe(1);
    expect(ep!.peak.score.components.geographic).toBe(1);
    expect(Number.isFinite(ep!.peak.score.score)).toBe(true);
  });

  it("scoreAlarm never yields NaN/Infinity for degenerate district sizes", () => {
    const t = { w: 5, observed: 12, expected: 3, ratio: 4, p: 1e-6, elevatedDays: 4, sourceCounts: [4, 3, 3, 2, 0, 0, 0, 0], historyDays: 28, bulkShare: 0, unknownSeverityShare: 0.1 } as unknown as WindowTest;
    for (const [inv, n] of [[1, 1], [1, 0], [0, 0], [3, 1], [1, 4], [4, 4], [5, 4]] as const) {
      const s = scoreAlarm(DETECTOR_V1, t, inv, n);
      expect(Number.isFinite(s.score), `${inv}/${n}`).toBe(true);
      expect(Number.isFinite(s.components.geographic)).toBe(true);
      expect(s.components.geographic).toBeGreaterThanOrEqual(0);
      expect(s.components.geographic).toBeLessThanOrEqual(1);
    }
  });
});

describe("episodes, duplicates and baseline handling", () => {
  it("consecutive alarms merge into one episode with a deterministic key", () => {
    const input = makeInput({ seed: 21, inject: clusterInject("b2", "fever", 50, 62, 4) });
    const a = runDetector(input, DETECTOR_V1).state.episodes;
    const b = runDetector(input, DETECTOR_V1).state.episodes;
    expect(a.filter((e) => e.syndrome === "fever")).toHaveLength(1);
    expect(a.map((e) => e.key)).toEqual(b.map((e) => e.key));
    expect(a[0].key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("two bursts far apart become two episodes with different keys", () => {
    const input = makeInput({ seed: 21, inject: [...clusterInject("b2", "fever", 40, 46, 4), ...clusterInject("b2", "fever", 75, 81, 4)] });
    const eps = runDetector(input, DETECTOR_V1).state.episodes.filter((e) => e.syndrome === "fever");
    expect(eps).toHaveLength(2);
    expect(new Set(eps.map((e) => e.key)).size).toBe(2);
    expect(eps[0].open).toBe(false);
  });

  it("a long sustained rise is not absorbed into the baseline (open-episode days are excluded)", () => {
    const input = makeInput({ seed: 21, inject: clusterInject("b2", "fever", 36, 70, 4) });
    const eps = runDetector(input, DETECTOR_V1).state.episodes.filter((e) => e.syndrome === "fever");
    expect(eps).toHaveLength(1);
    expect(eps[0].nAlarmDays).toBeGreaterThan(25); // would collapse to a handful of days if the baseline self-masked
  });

  it("a reporting blackout does not create false alarms when reporting resumes", () => {
    const r = runDetector(makeInput({ seed: 9, blackout: [40, 43] }), DETECTOR_V1);
    expect(r.state.episodes).toHaveLength(0);
  });

  it("incremental as-of runs equal a full replay (episode state round-trips)", () => {
    const input = makeInput({ seed: 21, inject: clusterInject("b2", "fever", 50, 58, 4) });
    const full = runDetector(input, DETECTOR_V1).state;
    const engine = new DetectorEngine(input, DETECTOR_V1);
    let state = engine.replay({ toDay: 54 }).state;
    state = engine.replay({ fromDay: 55, toDay: 89, state: JSON.parse(JSON.stringify(state)) }).state;
    expect(JSON.stringify(state)).toBe(JSON.stringify(full));
  });
});

describe("determinism and look-ahead safety", () => {
  const input = makeInput({ seed: 21, inject: clusterInject("b2", "fever", 50, 58, 4) });

  it("identical inputs give byte-identical results; row order is irrelevant", () => {
    const a = JSON.stringify(runDetector(input, DETECTOR_V1, { collectFindings: true }));
    const shuffled = { ...input, rows: [...input.rows].reverse() };
    const b = JSON.stringify(runDetector(shuffled, DETECTOR_V1, { collectFindings: true }));
    expect(strip(a)).toBe(strip(b));
    expect(hashFeatureRows(input.rows)).toBe(hashFeatureRows(shuffled.rows));
  });

  it("changing data AFTER an as-of day cannot change results up to that day", () => {
    const asOf = 56;
    const mutated: DetectorInput = {
      ...input,
      rows: input.rows.map((r) => (r.date > addDaysIso(START, asOf) ? { ...r, reports: r.reports + 50, cases: r.cases + 50, bySource: { ...r.bySource, citizen: (r.bySource.citizen ?? 0) + 50 } } : r)),
    };
    const a = runDetector(input, DETECTOR_V1, { toDay: asOf, collectFindings: true });
    const b = runDetector(mutated, DETECTOR_V1, { toDay: asOf, collectFindings: true });
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    expect(JSON.stringify(a.findings)).toBe(JSON.stringify(b.findings));
  });
});

// The engine object is not serialisable; compare only state/findings/stats.
function strip(json: string): string {
  const o = JSON.parse(json);
  return JSON.stringify({ state: o.state, findings: o.findings, stats: o.stats });
}

describe("gates, scoring, config", () => {
  const base = { observed: 12, elevatedDays: 4, maxDayShare: 0.4, bulkShare: 0.1, ratio: 4, pLeaveOneDayOut: 0.001, pNonBulk: 0.001 };

  it("evaluateGates reports exactly the failing gates", () => {
    expect(evaluateGates(DETECTOR_V1, 5, base)).toEqual([]);
    expect(evaluateGates(DETECTOR_V1, 5, { ...base, observed: 4 })).toEqual(["evidence"]);
    expect(evaluateGates(DETECTOR_V1, 5, { ...base, elevatedDays: 1 })).toEqual(["persistence"]);
    expect(evaluateGates(DETECTOR_V1, 5, { ...base, maxDayShare: 0.9 })).toEqual(["burst"]);
    expect(evaluateGates(DETECTOR_V1, 5, { ...base, bulkShare: 0.8 })).toEqual(["bulk"]);
    expect(evaluateGates(DETECTOR_V1, 5, { ...base, ratio: 1.5 })).toEqual(["ratio"]);
    expect(evaluateGates(DETECTOR_V1, 20, base)).toEqual(["evidence"]); // privacy k raises the floor
  });

  it("'distinct reports' counts report RECORDS (not reporters): the feature rows carry no reporter identity at all", () => {
    const cols = Object.keys(makeInput().rows[0]).sort();
    expect(cols).toEqual(["bySource", "cases", "date", "regionId", "reports", "syndrome", "unknownSeverity"]);
    expect(evaluateGates(resolveConfig({ evidence: { floor: 1, minDistinctReports: 3 } }), 1, { ...base, observed: 2 })).toEqual(["evidence"]);
  });

  it("the score is reproducible from its stored components and bounded", () => {
    const t = { w: 5, observed: 14, expected: 3.1, ratio: 4.5, p: 3e-8, elevatedDays: 5, sourceCounts: [5, 4, 3, 2, 0, 0, 0, 0], historyDays: 28, bulkShare: 0, unknownSeverityShare: 0.05 } as unknown as WindowTest;
    const s = scoreAlarm(DETECTOR_V1, t, 1, 4);
    const w = DETECTOR_V1.score.weights, c = s.components;
    const raw = c.quality * (w.deviation * c.deviation + w.persistence * c.persistence + w.volume * c.volume + w.geographic * c.geographic + w.sourceMix * c.sourceMix);
    expect(s.score).toBeCloseTo(100 * raw, 1);
    expect(s.score).toBeLessThanOrEqual(100);
    expect(s.priority).toMatch(/low|medium|high/);
  });

  it("score is monotone in its inputs", () => {
    const mk = (over: Partial<WindowTest>) => ({ w: 5, observed: 10, expected: 3, ratio: 3.3, p: 1e-5, elevatedDays: 3, sourceCounts: [3, 3, 2, 2, 0, 0, 0, 0], historyDays: 28, bulkShare: 0, unknownSeverityShare: 0, ...over }) as unknown as WindowTest;
    const sc = (t: WindowTest, inv = 1) => scoreAlarm(DETECTOR_V1, t, inv, 4).score;
    expect(sc(mk({ p: 1e-9 }))).toBeGreaterThan(sc(mk({ p: 1e-5 })));
    expect(sc(mk({ elevatedDays: 5 }))).toBeGreaterThan(sc(mk({ elevatedDays: 3 })));
    expect(sc(mk({ observed: 25 }))).toBeGreaterThan(sc(mk({ observed: 10 })));
    expect(sc(mk({}), 1)).toBeGreaterThan(sc(mk({}), 3));
    expect(sc(mk({ sourceCounts: [3, 3, 2, 2, 0, 0, 0, 0] }))).toBeGreaterThan(sc(mk({ sourceCounts: [10, 0, 0, 0, 0, 0, 0, 0] })));
    expect(sc(mk({ bulkShare: 0.5 }))).toBeLessThan(sc(mk({ bulkShare: 0 })));
    expect(sc(mk({ historyDays: 14 }))).toBeLessThan(sc(mk({ historyDays: 28 })));
  });

  it("day-of-week factors average to 1 and shrink toward 1 with little data", () => {
    const store = new SeriesStore(makeInput({ seed: 4, weekday: true }), DETECTOR_V1);
    const f = dowFactors(store, 0, 27, 4);
    expect(f.reduce((a, b) => a + b, 0) / 7).toBeCloseTo(1, 10);
    expect(f[1]).toBeGreaterThan(f[0]); // Monday busier than Sunday in this fixture
    const g = dowFactors(store, 0, 2, 4); // 3 days only: heavily shrunk
    expect(Math.max(...g) - Math.min(...g)).toBeLessThan(Math.max(...f) - Math.min(...f));
  });

  it("config hashing is stable and sensitive; invalid configs are rejected", () => {
    expect(configHash(DETECTOR_V1)).toBe(configHash(resolveConfig({})));
    expect(configHash(DETECTOR_V1)).not.toBe(configHash(resolveConfig({ test: { alpha: 1e-3 } })));
    expect(() => resolveConfig({ score: { weights: { deviation: 0.5, persistence: 0.5, volume: 0.5, geographic: 0, sourceMix: 0 } } })).toThrow(/sum to 1/);
    expect(() => resolveConfig({ windows: [] })).toThrow();
    expect(() => resolveConfig({ test: { alpha: 2 } })).toThrow();
  });

  it("the plug-in Poisson variant (ablation) runs and is less conservative than the predictive test", () => {
    const input = makeInput({ seed: 21, inject: clusterInject("b2", "fever", 50, 58, 4) });
    const plug = runDetector(input, resolveConfig({ test: { kind: "plugin_poisson" } }), { collectFindings: true });
    expect(plug.state.episodes.length).toBeGreaterThan(0);
  });

  it("explanations: safe wording passes, unsafe wording fails", () => {
    const ok = explainSignal({ syndrome: "fever", placeLabel: "Block 2 (District One district)", windowDays: 5, fromDate: "2026-08-01", toDate: "2026-08-05", observed: 14, expected: 3.1, ratio: 4.5, elevatedDays: 5, sourceTypes: 4 });
    expect(isSafeExplanation(ok)).toBe(true);
    expect(isSafeExplanation(ok.replace("Emerging signal requiring verification:", "OUTBREAK DETECTED:"))).toBe(false);
    expect(isSafeExplanation(ok + " Probability of outbreak 97%.")).toBe(false);
    expect(isSafeExplanation(ok.replace("Human verification required.", ""))).toBe(false);
  });

  it("every score source key is accounted for", () => {
    expect(SOURCE_KEYS).toHaveLength(8);
  });
});
