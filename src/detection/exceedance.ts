// Baseline estimation + windowed exceedance test.
//
// Baseline: exponentially WEIGHTED moving history (half-life) of day-of-week-normalised report counts, with a
// Gamma prior derived from the unit's own overall report volume x the state-wide syndrome mix (so sparse cells
// borrow strength without using any knowledge of how the data were generated).
// Test: Gamma-Poisson posterior predictive (negative binomial) upper tail  P(X >= observed)  for the window.
//
// NOTE: the exponential weighting is a plain weighting of baseline history. This module does NOT implement an
// EWMA control chart; control-chart detectors (EWMA/CUSUM) are deliberately deferred (see docs/M3-DETECTION.md).
import { clamp, negBinSf, poissonSf, zFromUpperTail } from "./numerics";
import type { SeriesStore } from "./series";
import { SOURCE_KEYS, type DetectorConfig, type GateName, type WindowTest } from "./types";

export interface TestContext {
  store: SeriesStore;
  cfg: DetectorConfig;
  /** Effective evidence floor = max(config floor, privacy threshold k). */
  evidenceFloor: number;
  /** Days excluded from the baseline per (block, syndrome): index bi * nSyndromes + si. */
  excluded: Uint8Array[];
  weights: Float64Array; // weights[age] = 0.5 ** (age / halfLife)
  stats: { tests: number; insufficient: number };
}

export function makeContext(store: SeriesStore, cfg: DetectorConfig, privacyK: number): TestContext {
  const weights = new Float64Array(cfg.baseline.historyDays + 1);
  for (let a = 0; a < weights.length; a++) weights[a] = 0.5 ** (a / cfg.baseline.halfLifeDays);
  const excluded = Array.from({ length: store.blocks.length * store.syndromes.length }, () => new Uint8Array(store.days));
  return {
    store, cfg, evidenceFloor: Math.max(cfg.evidence.floor, privacyK), excluded, weights,
    stats: { tests: 0, insufficient: 0 },
  };
}

/** Day-of-week factors (mean 1) from pooled, non-bulk, state-wide counts over [hStart, hEnd], shrunk toward 1. */
export function dowFactors(store: SeriesStore, hStart: number, hEnd: number, shrink: number): Float64Array {
  const sum = new Float64Array(7);
  const n = new Float64Array(7);
  for (let d = hStart; d <= hEnd; d++) {
    sum[store.dow[d]] += store.stateTotalNonBulk[d];
    n[store.dow[d]]++;
  }
  let total = 0;
  let count = 0;
  for (let k = 0; k < 7; k++) {
    total += sum[k];
    count += n[k];
  }
  const f = new Float64Array(7).fill(1);
  if (count === 0 || total <= 0) return f;
  const overall = total / count;
  for (let k = 0; k < 7; k++) {
    const raw = n[k] > 0 ? sum[k] / n[k] / overall : 1;
    f[k] = (n[k] * raw + shrink) / (n[k] + shrink);
  }
  const mean = f.reduce((a, b) => a + b, 0) / 7;
  for (let k = 0; k < 7; k++) f[k] /= mean;
  return f;
}

export function evaluateGates(
  cfg: DetectorConfig, evidenceFloor: number,
  s: { observed: number; elevatedDays: number; maxDayShare: number; bulkShare: number; ratio: number; pLeaveOneDayOut: number; pNonBulk: number },
): GateName[] {
  const failed: GateName[] = [];
  // Evidence is a privacy invariant: it cannot be disabled.
  if (s.observed < evidenceFloor || s.observed < cfg.evidence.minDistinctReports) failed.push("evidence");
  if (cfg.gates.persistence && s.elevatedDays < cfg.evidence.minElevatedDays) failed.push("persistence");
  // Burst gate: dominated by one day, OR the signal does not survive removing its largest day.
  if (cfg.gates.burst && (s.maxDayShare > cfg.evidence.maxSingleDayShare || s.pLeaveOneDayOut > cfg.evidence.leaveOneDayOutAlpha)) failed.push("burst");
  // Bulk gate: dominated by bulk-source reports, OR the signal does not survive removing them.
  if (cfg.gates.bulk && (s.bulkShare >= cfg.evidence.maxBulkShare || s.pNonBulk > cfg.evidence.nonBulkAlpha)) failed.push("bulk");
  if (cfg.gates.ratio && s.ratio < cfg.evidence.minRatio) failed.push("ratio");
  return failed;
}

/**
 * Test one unit (a set of block indices in one district) for one syndrome, as of day t, with window length w.
 * Returns null when there is not enough usable history (the test is skipped, never guessed).
 */
export function testUnit(ctx: TestContext, blocks: number[], si: number, t: number, w: number): WindowTest | null {
  const { store, cfg } = ctx;
  const nS = store.syndromes.length;
  const winStart = t - w + 1;
  if (winStart < 0) return null;
  const hEnd = t - w - cfg.baseline.guardDays;
  const hStart = Math.max(0, hEnd - cfg.baseline.historyDays + 1);
  if (hEnd < hStart) {
    ctx.stats.insufficient++;
    return null;
  }
  const district = store.districtOfBlock[blocks[0]];

  // Usable baseline days: the district reported something, and no block of the unit is excluded for this syndrome.
  const usable: number[] = [];
  for (let d = hStart; d <= hEnd; d++) {
    if (!store.districtActive[district][d]) continue;
    let ok = true;
    for (const bi of blocks) if (ctx.excluded[bi * nS + si][d]) { ok = false; break; }
    if (ok) usable.push(d);
  }
  if (usable.length < cfg.baseline.minHistoryDays) {
    ctx.stats.insufficient++;
    return null;
  }
  ctx.stats.tests++;

  const f = dowFactors(store, hStart, hEnd, cfg.baseline.dowShrinkage);
  let B = 0; // weighted observed baseline reports
  let Bbulk = 0; // ... of which from bulk sources
  let Nb = 0; // weighted baseline exposure (in "average-day" units)
  let stateS = 0;
  let stateT = 0;
  const blockT = new Float64Array(blocks.length);
  for (const d of usable) {
    const om = ctx.weights[hEnd - d];
    const fd = f[store.dow[d]];
    Nb += om * fd;
    stateS += om * store.stateBySyndrome[si][d];
    stateT += om * store.stateTotal[d];
    for (let j = 0; j < blocks.length; j++) {
      B += om * store.reports[blocks[j]][si][d];
      for (const k of store.bulkIdx) Bbulk += om * store.sources[blocks[j]][si][k][d];
      blockT[j] += om * store.blockTotal[blocks[j]][d];
    }
  }

  // Prior rate: the unit's overall report volume x the state-wide share of this syndrome.
  const mix = stateT > 0 ? stateS / stateT : 0;
  let priorRate = 0;
  for (let j = 0; j < blocks.length; j++) priorRate += (blockT[j] / Nb) * mix;
  priorRate = Math.max(priorRate, cfg.baseline.rateFloorPerDay * blocks.length);
  const k0 = cfg.baseline.priorExposureDays;
  const a0 = priorRate * k0;
  const shape = a0 + B;
  const rateParam = k0 + Nb;
  const posteriorRate = shape / rateParam;

  // Window.
  let O = 0;
  let cases = 0;
  let Nw = 0;
  let unknownSev = 0;
  const dayCounts: number[] = [];
  const sourceCounts = new Array<number>(SOURCE_KEYS.length).fill(0);
  for (let d = winStart; d <= t; d++) {
    let y = 0;
    for (const bi of blocks) {
      y += store.reports[bi][si][d];
      cases += store.cases[bi][si][d];
      unknownSev += store.unknownSev[bi][si][d];
      for (let k = 0; k < SOURCE_KEYS.length; k++) sourceCounts[k] += store.sources[bi][si][k][d];
    }
    dayCounts.push(y);
    O += y;
    Nw += f[store.dow[d]];
  }
  const E = posteriorRate * Nw;

  let elevatedDays = 0;
  let maxDay = 0;
  for (let i = 0; i < dayCounts.length; i++) {
    const Ed = posteriorRate * f[store.dow[winStart + i]];
    if (dayCounts[i] >= Math.max(1, Math.ceil(cfg.evidence.elevatedDayFactor * Ed))) elevatedDays++;
    if (dayCounts[i] > maxDay) maxDay = dayCounts[i];
  }
  const bulk = store.bulkIdx.reduce((acc, k) => acc + sourceCounts[k], 0);

  // Survival checks. (1) remove the single largest day; (2) remove bulk-source reports. A genuine signal survives both.
  const maxIdx = dayCounts.indexOf(maxDay);
  const NwRest = Nw - f[store.dow[winStart + maxIdx]];
  const pLeaveOneDayOut = NwRest > 0 ? negBinSf(O - maxDay, shape, rateParam / (rateParam + NwRest)) : 1;
  const bulkBaseShare = B > 0 ? clamp(Bbulk / B, 0, 0.5) : 0;
  const pNonBulk = negBinSf(O - bulk, Math.max(shape * (1 - bulkBaseShare), 1e-6), rateParam / (rateParam + Nw));

  const p = cfg.test.kind === "gamma_poisson_predictive"
    ? negBinSf(O, shape, rateParam / (rateParam + Nw))
    : poissonSf(O, Math.max((B / Nb) * Nw, 0.02 * w));
  const ratio = E > 0 ? O / E : O > 0 ? Infinity : 0;
  const maxDayShare = O > 0 ? maxDay / O : 0;
  const bulkShare = O > 0 ? bulk / O : 0;

  const failed = evaluateGates(cfg, ctx.evidenceFloor, { observed: O, elevatedDays, maxDayShare, bulkShare, ratio, pLeaveOneDayOut, pNonBulk });
  let decision: WindowTest["decision"] = null;
  if (p <= cfg.test.alpha) {
    decision = failed.length === 0 ? "candidate" : failed.length === 1 && failed[0] === "evidence" ? "watch" : "gated";
  }
  return {
    w, windowStart: winStart, windowEnd: t, observed: O, expected: E, ratio: Number.isFinite(ratio) ? ratio : 1e9, p,
    z: O > 0 ? zFromUpperTail(clamp(p, 1e-300, 0.5)) : 0, cases, elevatedDays, maxDayShare, bulkShare,
    unknownSeverityShare: O > 0 ? unknownSev / O : 0, sourceCounts, historyDays: usable.length, baselineRate: posteriorRate,
    pLeaveOneDayOut, pNonBulk, failed, decision,
  };
}

/** Best window for a unit: lowest-p candidate if any, else lowest-p screened finding, else null. Ties -> shorter window. */
export function bestWindow(tests: Array<WindowTest | null>): WindowTest | null {
  const live = tests.filter((x): x is WindowTest => x !== null);
  const pick = (xs: WindowTest[]) => xs.reduce<WindowTest | null>((best, x) => (best === null || x.p < best.p || (x.p === best.p && x.w < best.w) ? x : best), null);
  const cands = live.filter((x) => x.decision === "candidate");
  if (cands.length > 0) return pick(cands);
  const found = live.filter((x) => x.decision !== null);
  if (found.length > 0) return pick(found);
  return pick(live);
}
