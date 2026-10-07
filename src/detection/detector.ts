// Detector engine: per-day (as-of) detection, geographic clustering, episodes, and deterministic replay.
//
// Data flow (all pure; no I/O, no clock, no randomness):
//   FeatureRow[] -> SeriesStore -> per (district, syndrome, as-of day):
//     block tests -> alarmed blocks -> involved-block inference -> pooled cluster test -> gates -> score
//   -> episodes (merge consecutive alarms) -> candidate payloads.
//
// Look-ahead safety: a test at as-of day t reads only days <= t (verified by a mutation test).
import { configHash, validateConfig } from "./config";
import { explainSignal } from "./explain";
import { round } from "./numerics";
import { scoreAlarm } from "./score";
import { SeriesStore, addDaysIso } from "./series";
import { bestWindow, makeContext, testUnit, type TestContext } from "./exceedance";
import { canonicalJson, sha256Hex } from "./sha256";
import {
  SOURCE_KEYS,
  type AlarmSnapshot, type DetectorConfig, type DetectorInput, type EpisodeRecord, type Finding, type GateName,
  type ReplayState, type RunStats, type WindowTest,
} from "./types";

export interface ReplayOptions {
  fromDay?: number;
  toDay?: number;
  collectFindings?: boolean;
  keepAlarmDays?: boolean;
  state?: ReplayState;
}

export interface ReplayResult {
  state: ReplayState;
  findings: Finding[];
  stats: RunStats;
}

interface ClusterAlarm {
  districtIdx: number;
  syndromeIdx: number;
  involved: number[]; // block indices
  test: WindowTest;
}

const emptyStats = (): RunStats => ({
  asOfDays: 0, testsRun: 0, skippedInsufficientHistory: 0, findings: 0, candidatesAlarmDays: 0,
  byDecision: { candidate: 0, watch: 0, gated: 0 },
  byGateFailure: { evidence: 0, persistence: 0, burst: 0, bulk: 0, ratio: 0, concentration: 0 },
});

/**
 * Blocks that define an episode's location: the peak alarm's blocks plus any block involved on at least half of
 * the alarm days (and >= 2 days). A block loosely involved on one noisy day does NOT enter the location, and
 * nothing is sticky (the set can shrink as evidence firms up). `involvedEver` (a superset) is kept separately
 * and used only to exclude days from baselines.
 */
function stableInvolved(ep: EpisodeRecord): string[] {
  const need = Math.max(2, Math.ceil(0.5 * ep.nAlarmDays));
  const persistent = Object.entries(ep.involvedCounts).filter(([, c]) => c >= need).map(([b]) => b);
  return [...new Set([...ep.peak.involved, ...persistent])].sort();
}

/** Share of the total excess carried by the single largest block (0 when there is no excess). */
export function topExcessShare(excesses: readonly number[]): number {
  const total = excesses.reduce((a, b) => a + Math.max(0, b), 0);
  return total > 0 ? Math.max(...excesses.map((x) => Math.max(0, x))) / total : 0;
}

export class DetectorEngine {
  readonly store: SeriesStore;
  readonly ctx: TestContext;
  readonly cfg: DetectorConfig;
  readonly configHash: string;

  constructor(input: DetectorInput, cfg: DetectorConfig) {
    validateConfig(cfg);
    this.cfg = cfg;
    this.configHash = configHash(cfg);
    this.store = new SeriesStore(input, cfg);
    this.ctx = makeContext(this.store, cfg, input.privacyK);
  }

  get evidenceFloor(): number {
    return this.ctx.evidenceFloor;
  }

  private rebuildExclusions(state: ReplayState): void {
    const { store, ctx } = this;
    for (const arr of ctx.excluded) arr.fill(0);
    const nS = store.syndromes.length;
    for (const ep of state.episodes) {
      const si = store.syndromeIndex.get(ep.syndrome);
      if (si === undefined) continue;
      for (const id of ep.involvedEver) {
        const bi = store.blockIndex.get(id);
        if (bi === undefined) continue;
        const arr = ctx.excluded[bi * nS + si];
        for (let d = Math.max(0, ep.windowStartDay); d <= Math.min(store.days - 1, ep.lastAlarmDay); d++) arr[d] = 1;
      }
    }
  }

  private findingOf(asOfDay: number, di: number, scope: Finding["scope"], blocks: number[], si: number, test: WindowTest): Finding {
    return {
      asOfDay, districtId: this.store.districts[di], scope, blocks: blocks.map((b) => this.store.blocks[b]),
      syndrome: this.store.syndromes[si], test,
    };
  }

  /** Evaluate one (district, syndrome) as of day t. Returns the cluster alarm (if any) and records findings. */
  private evaluateDistrict(t: number, di: number, si: number, findings: Finding[] | null): ClusterAlarm | null {
    const { store, cfg, ctx } = this;
    const blocksIn = store.blocksOfDistrict[di];
    const record = (scope: Finding["scope"], blocks: number[], test: WindowTest | null) => {
      if (findings && test && test.decision !== null) findings.push(this.findingOf(t, di, scope, blocks, si, test));
    };

    const blockTests = blocksIn.map((bi) => cfg.windows.map((w) => testUnit(ctx, [bi], si, t, w)));
    const blockBest = blockTests.map((tests) => bestWindow(tests));
    blocksIn.forEach((bi, j) => record("block", [bi], blockBest[j]));
    const alarmed = blocksIn.filter((_, j) => blockBest[j]?.decision === "candidate");

    if (alarmed.length > 0) {
      const involved = new Set(alarmed);
      blocksIn.forEach((bi, j) => {
        const b = blockBest[j];
        if (!involved.has(bi) && b && b.p <= cfg.geography.involvedAlpha && b.ratio >= cfg.geography.involvedMinRatio
          && b.observed >= cfg.geography.involvedMinReports) involved.add(bi);
      });
      const inv = [...involved].sort((a, b) => a - b);
      let test: WindowTest | null = null;
      if (inv.length === 1) {
        test = blockBest[blocksIn.indexOf(inv[0])];
      } else {
        test = bestWindow(cfg.windows.map((w) => testUnit(ctx, inv, si, t, w)));
        record("cluster", inv, test);
      }
      if (test && test.decision === "candidate") return { districtIdx: di, syndromeIdx: si, involved: inv, test };
      // Pooled cluster failed a gate: fall back to the strongest individually alarmed block.
      const strongest = alarmed
        .map((bi) => ({ bi, b: blockBest[blocksIn.indexOf(bi)]! }))
        .sort((x, y) => x.b.p - y.b.p || x.bi - y.bi)[0];
      return { districtIdx: di, syndromeIdx: si, involved: [strongest.bi], test: strongest.b };
    }

    let dist = bestWindow(cfg.windows.map((w) => testUnit(ctx, blocksIn, si, t, w)));
    let districtInvolved: number[] = [...blocksIn];
    if (dist && dist.decision === "candidate") {
      // Concentration rule: if one block carries most of the excess, this pooled alarm is really that block's
      // phenomenon, and that block's own gates (burst / bulk-source / persistence) have already ruled on it.
      // Pooling must not launder a single-block artifact into a district-wide "signal".
      const wi = cfg.windows.indexOf(dist.w);
      let total = 0;
      let top = 0;
      blocksIn.forEach((_, j) => {
        const bt = blockTests[j][wi];
        const excess = bt ? Math.max(0, bt.observed - bt.expected) : 0;
        total += excess;
        top = Math.max(top, excess);
      });
      if (total > 0 && top / total >= cfg.geography.maxSingleBlockExcessShare) {
        dist = { ...dist, failed: [...dist.failed, "concentration"], decision: "gated" };
      } else {
        // Diffuse alarm: the involved blocks are those carrying a meaningful share of the excess.
        const involvedByExcess = blocksIn.filter((_, j) => {
          const bt = blockTests[j][wi];
          return bt && total > 0 && Math.max(0, bt.observed - bt.expected) / total >= cfg.geography.involvedExcessShare;
        });
        districtInvolved = involvedByExcess.length > 0 ? involvedByExcess : [...blocksIn];
      }
    }
    record("district", blocksIn, dist);
    if (dist && dist.decision === "candidate") return { districtIdx: di, syndromeIdx: si, involved: districtInvolved, test: dist };
    return null;
  }

  /** Process one as-of day against a state; returns the updated state. */
  private step(t: number, state: ReplayState, opts: ReplayOptions, findings: Finding[] | null, stats: RunStats): ReplayState {
    const { store, cfg } = this;
    const next: ReplayState = {
      episodes: state.episodes.map((e) => ({
        ...e, involved: [...e.involved], involvedEver: [...e.involvedEver], involvedCounts: { ...e.involvedCounts },
        alarmDays: e.alarmDays ? [...e.alarmDays] : undefined,
      })),
    };
    this.rebuildExclusions(next);

    for (let di = 0; di < store.districts.length; di++) {
      for (let si = 0; si < store.syndromes.length; si++) {
        const before = findings ? findings.length : 0;
        const alarm = this.evaluateDistrict(t, di, si, findings);
        if (findings) {
          for (let i = before; i < findings.length; i++) {
            const f = findings[i];
            stats.findings++;
            stats.byDecision[f.test.decision!]++;
            for (const g of f.test.failed) stats.byGateFailure[g as GateName]++;
          }
        }
        const districtId = store.districts[di];
        const syndrome = store.syndromes[si];
        const open = next.episodes.find((e) => e.open && e.districtId === districtId && e.syndrome === syndrome);

        if (alarm) {
          stats.candidatesAlarmDays++;
          const snap = this.snapshot(t, alarm);
          if (open && t - open.lastAlarmDay <= cfg.episodes.maxGapDays + 1) {
            open.lastAlarmDay = t;
            open.nAlarmDays++;
            for (const b of snap.involved) open.involvedCounts[b] = (open.involvedCounts[b] ?? 0) + 1;
            open.involvedEver = [...new Set([...open.involvedEver, ...snap.involved])].sort();
            if (snap.score.score > open.peak.score.score) open.peak = snap;
            open.latest = snap;
            open.involved = stableInvolved(open);
            if (opts.keepAlarmDays) (open.alarmDays ??= []).push(snap);
          } else {
            if (open) open.open = false;
            const key = sha256Hex(`${cfg.methodCode}|${syndrome}|${districtId}|${store.dates[t]}`);
            next.episodes.push({
              key, districtId, syndrome, firstAlarmDay: t, lastAlarmDay: t, windowStartDay: snap.windowStart,
              involved: [...snap.involved].sort(), involvedEver: [...snap.involved].sort(),
              involvedCounts: Object.fromEntries(snap.involved.map((b) => [b, 1])),
              nAlarmDays: 1, peak: snap, latest: snap, open: true,
              alarmDays: opts.keepAlarmDays ? [snap] : undefined,
            });
          }
        } else if (open && t - open.lastAlarmDay >= cfg.episodes.maxGapDays + 1) {
          open.open = false;
        }
      }
    }
    return next;
  }

  private snapshot(day: number, a: ClusterAlarm): AlarmSnapshot {
    const nBlocks = this.store.blocksOfDistrict[a.districtIdx].length;
    const score = scoreAlarm(this.cfg, a.test, a.involved.length, nBlocks);
    const t = a.test;
    return {
      day, w: t.w, windowStart: t.windowStart, windowEnd: t.windowEnd, involved: a.involved.map((b) => this.store.blocks[b]).sort(),
      observed: t.observed, expected: round(t.expected, 3), ratio: round(t.ratio, 3), p: Number(t.p.toPrecision(4)), z: round(t.z, 3),
      cases: t.cases, elevatedDays: t.elevatedDays, sourceTypes: t.sourceCounts.filter((c) => c > 0).length, score,
    };
  }

  /** Deterministic replay of as-of days [fromDay, toDay]. Reads only data up to each as-of day. */
  replay(opts: ReplayOptions = {}): ReplayResult {
    const from = opts.fromDay ?? 0;
    const to = Math.min(opts.toDay ?? this.store.days - 1, this.store.days - 1);
    const findings: Finding[] | null = opts.collectFindings ? [] : null;
    const stats = emptyStats();
    const t0 = this.ctx.stats.tests;
    const i0 = this.ctx.stats.insufficient;
    let state: ReplayState = opts.state ?? { episodes: [] };
    for (let t = from; t <= to; t++) {
      state = this.step(t, state, opts, findings, stats);
      stats.asOfDays++;
    }
    stats.testsRun = this.ctx.stats.tests - t0;
    stats.skippedInsufficientHistory = this.ctx.stats.insufficient - i0;
    return { state, findings: findings ?? [], stats };
  }

  // ---- candidate payloads (pure) --------------------------------------------------------------
  private placeLabel(ep: EpisodeRecord): { regionId: string; label: string } {
    const names = ep.involved.map((id) => this.store.names.get(id) ?? id);
    const district = this.store.names.get(ep.districtId) ?? ep.districtId;
    if (ep.involved.length === 1) return { regionId: ep.involved[0], label: `${names[0]} (${district} district)` };
    return { regionId: ep.districtId, label: `${district} district (blocks: ${names.join(", ")})` };
  }

  /** The row to upsert into signal_candidates for an episode. Never contains a count below the evidence floor. */
  buildCandidate(ep: EpisodeRecord) {
    const { store, cfg } = this;
    const peak = ep.peak;
    const { regionId, label } = this.placeLabel(ep);
    const explanation = explainSignal({
      syndrome: ep.syndrome, placeLabel: label, windowDays: peak.w, fromDate: store.dates[peak.windowStart],
      toDate: store.dates[peak.windowEnd], observed: peak.observed, expected: peak.expected, ratio: peak.ratio,
      elevatedDays: peak.elevatedDays, sourceTypes: peak.sourceTypes,
    });
    const istStart = (d: number) => new Date(`${addDaysIso(store.startDate, d)}T00:00:00+05:30`).toISOString();
    return {
      methodCode: cfg.methodCode,
      episodeKey: ep.key,
      regionId,
      districtId: ep.districtId,
      syndrome: ep.syndrome,
      windowStart: istStart(ep.windowStartDay),
      windowEnd: istStart(ep.lastAlarmDay + 1),
      observedValue: peak.observed,
      baselineValue: peak.expected,
      deviation: peak.z,
      signalScore: peak.score.score,
      sampleCount: peak.observed,
      minimumSampleCount: this.ctx.evidenceFloor,
      confidence: peak.score.confidence,
      explanation,
      firstDetectedOn: store.dates[ep.firstAlarmDay],
      lastSeenOn: store.dates[ep.lastAlarmDay],
      scoreComponents: {
        ...peak.score.components,
        priority: peak.score.priority,
        formulaVersion: peak.score.formulaVersion,
        weights: cfg.score.weights,
        window_days: peak.w,
        note: "signal_score ranks priority and confidence is evidence sufficiency; this is not a probability and neither estimates the chance that an event is real",
      },
      evidence: {
        detector_version: cfg.version,
        first_alarm_date: store.dates[ep.firstAlarmDay],
        last_alarm_date: store.dates[ep.lastAlarmDay],
        peak_alarm_date: store.dates[peak.day],
        n_alarm_days: ep.nAlarmDays,
        involved_blocks: ep.involved.map((id) => ({ id, name: store.names.get(id) ?? id })),
        peak: { window_days: peak.w, observed: peak.observed, expected: peak.expected, ratio: peak.ratio, p_value: peak.p, elevated_days: peak.elevatedDays, source_types: peak.sourceTypes },
        latest: { date: store.dates[ep.latest.day], window_days: ep.latest.w, observed: ep.latest.observed, expected: ep.latest.expected, score: ep.latest.score.score },
        source_types_possible: SOURCE_KEYS.length,
      },
      open: ep.open,
    };
  }
}

/** Canonical SHA-256 over feature rows (order-independent) recorded on every run. */
export function hashFeatureRows(rows: readonly { regionId: string; date: string; syndrome: string; reports: number; cases: number; unknownSeverity: number; bySource: Record<string, number | undefined> }[]): string {
  const lines = rows
    .map((r) => canonicalJson([r.regionId, r.date, r.syndrome, r.reports, r.cases, r.unknownSeverity, Object.fromEntries(Object.entries(r.bySource).filter(([, v]) => v))]))
    .sort();
  return sha256Hex(lines.join("\n"));
}

export function runDetector(input: DetectorInput, cfg: DetectorConfig, opts: ReplayOptions = {}) {
  const engine = new DetectorEngine(input, cfg);
  const result = engine.replay(opts);
  return { engine, ...result };
}
