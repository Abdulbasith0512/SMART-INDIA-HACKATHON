import type { DetectorConfig } from "./types";
import { canonicalJson, sha256Hex } from "./sha256";

/**
 * Detector v1 configuration. FROZEN before the first oracle evaluation (see data/detection/*.config.json
 * and the freeze check in the evaluation harness). Every value is chosen a priori from statistical
 * reasoning documented in docs/M3-DETECTION.md; none was fitted to the planted ground truth.
 */
export const DETECTOR_V1: DetectorConfig = {
  version: "windowed-gamma-poisson/1.0.0",
  methodCode: "windowed_gamma_poisson_v1",
  syndromes: ["acute_diarrhoeal_illness", "fever", "fever_with_rash", "jaundice", "respiratory_illness"],
  windows: [3, 5, 7, 14],
  baseline: {
    historyDays: 28,
    guardDays: 2,
    minHistoryDays: 14,
    halfLifeDays: 14,
    priorExposureDays: 7,
    dowShrinkage: 4,
    rateFloorPerDay: 0.01,
  },
  test: { kind: "gamma_poisson_predictive", alpha: 1e-4 },
  evidence: {
    floor: 5,
    minDistinctReports: 3,
    minElevatedDays: 2,
    minRatio: 2,
    elevatedDayFactor: 1.5,
    maxSingleDayShare: 0.7,
    maxBulkShare: 0.8,
    // Survival checks use the SAME level as detection: after removing its largest day / its bulk-source reports,
    // the remainder must still be an alarm on its own. (Initially 0.05; strengthened after dev diagnostics showed a
    // bulk day plus a weak chance excess could pass a looser level. Disclosed in docs/M3-DETECTION.md.)
    leaveOneDayOutAlpha: 1e-4,
    nonBulkAlpha: 1e-4,
  },
  gates: { persistence: true, burst: true, bulk: true, ratio: true },
  bulkSources: ["imported_dataset", "system_generated"],
  geography: { involvedAlpha: 0.005, involvedMinRatio: 1.5, involvedMinReports: 2, involvedExcessShare: 0.15, maxSingleBlockExcessShare: 0.7 },
  episodes: { maxGapDays: 2 },
  score: {
    weights: { deviation: 0.35, persistence: 0.2, volume: 0.15, geographic: 0.15, sourceMix: 0.15 },
    volumeReference: 30,
    deviationPMinLog10: 4,
    deviationPSpanLog10: 8,
    ratioSpanLog2: 3,
    effectiveSourcesSaturation: 4,
    mediumFrom: 40,
    highFrom: 65,
    qualityHistoryReferenceDays: 28,
    confidenceVolumeReference: 20,
  },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Merge overrides (used for ablations) onto a base config, with validation. */
export function resolveConfig(overrides: DeepPartial<DetectorConfig> = {}, base: DetectorConfig = DETECTOR_V1): DetectorConfig {
  const merge = (a: unknown, b: unknown): unknown => {
    if (b === undefined) return a;
    if (Array.isArray(b) || b === null || typeof b !== "object") return b;
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = merge((a as Record<string, unknown>)?.[k], v);
    return out;
  };
  const cfg = merge(base, overrides) as DetectorConfig;
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg: DetectorConfig): void {
  const fail = (m: string): never => {
    throw new Error(`invalid detector config: ${m}`);
  };
  const w = cfg.score.weights;
  const wsum = w.deviation + w.persistence + w.volume + w.geographic + w.sourceMix;
  if (Math.abs(wsum - 1) > 1e-9) fail(`score weights must sum to 1 (got ${wsum})`);
  if (!(cfg.test.alpha > 0 && cfg.test.alpha < 1)) fail("alpha must be in (0,1)");
  if (cfg.windows.length === 0 || cfg.windows.some((x) => !Number.isInteger(x) || x < 1)) fail("windows must be positive integers");
  if (cfg.baseline.minHistoryDays > cfg.baseline.historyDays) fail("minHistoryDays cannot exceed historyDays");
  if (cfg.evidence.floor < 1 || cfg.evidence.minDistinctReports < 1) fail("evidence floors must be >= 1");
  if (cfg.baseline.priorExposureDays <= 0) fail("priorExposureDays must be > 0");
  if (cfg.baseline.halfLifeDays <= 0) fail("halfLifeDays must be > 0");
}

/** Stable hash of a config: recorded on every run and evaluation. */
export function configHash(cfg: DetectorConfig): string {
  return sha256Hex(canonicalJson(cfg));
}
