// Types for the statistical signal detector (M3).
//
// ISOLATION RULE: nothing in src/detection may import from src/synthetic or src/evaluation, and no type here
// carries a synthetic/ground-truth marker. The detector sees deidentified feature rows and the region
// hierarchy only. (Enforced by src/detection/isolation.test.ts.)

/** Source types as they appear in deidentified observations. */
export const SOURCE_KEYS = [
  "citizen", "clinician", "health_facility", "public_health_officer",
  "survey", "environmental", "imported_dataset", "system_generated",
] as const;
export type SourceKey = (typeof SOURCE_KEYS)[number];

/** One block x day x syndrome cell of deidentified observations (zero cells may be omitted). */
export interface FeatureRow {
  regionId: string; // block id
  date: string; // India-local date, yyyy-mm-dd
  syndrome: string;
  reports: number; // distinct report RECORDS (never distinct reporters)
  cases: number; // sum of case_count (volume feature; not the test statistic)
  unknownSeverity: number; // reports with severity = unknown
  bySource: Partial<Record<SourceKey, number>>; // reports per source type
}

export interface RegionNode {
  id: string;
  type: "country" | "state" | "district" | "block" | "locality";
  parentId: string | null;
  name: string;
}

export interface DetectorInput {
  rows: FeatureRow[];
  regions: RegionNode[];
  /** Range of days the series cover (inclusive, yyyy-mm-dd). */
  startDate: string;
  endDate: string;
  /** Suppression threshold k from privacy_settings; the evidence floor is never below it. */
  privacyK: number;
}

export type TestKind = "gamma_poisson_predictive" | "plugin_poisson";

export interface DetectorConfig {
  /** Human-readable detector version recorded on every run/candidate. */
  version: string;
  methodCode: string;
  syndromes: string[];
  windows: number[];
  baseline: {
    historyDays: number; // L
    guardDays: number; // g: days between baseline and window
    minHistoryDays: number;
    halfLifeDays: number; // EWMA-style exponential WEIGHTING of the baseline history (not a control chart)
    priorExposureDays: number; // k0: strength of the pooled prior, in exposure-days
    dowShrinkage: number; // pseudo-observations pulling day-of-week factors toward 1
    rateFloorPerDay: number; // floor of the prior rate (per block-day) to keep the posterior proper
  };
  test: { kind: TestKind; alpha: number };
  evidence: {
    floor: number; // reports in the window; the effective floor is max(floor, privacyK)
    minDistinctReports: number; // distinct report RECORDS (not reporters)
    minElevatedDays: number;
    minRatio: number; // observed / expected
    elevatedDayFactor: number;
    maxSingleDayShare: number;
    maxBulkShare: number;
    /** Survival check (burst gate): after removing the single largest day, the rest of the window must still exceed baseline at this level. */
    leaveOneDayOutAlpha: number;
    /** Survival check (bulk gate): after removing bulk-source reports, the rest must still exceed baseline at this level. */
    nonBulkAlpha: number;
  };
  /** Gates may be switched off for ablation studies, except `evidence` (privacy invariant). */
  gates: { persistence: boolean; burst: boolean; bulk: boolean; ratio: boolean };
  bulkSources: SourceKey[];
  geography: {
    involvedAlpha: number;
    involvedMinRatio: number;
    involvedMinReports: number;
    /** In a district-level alarm, a block is "involved" when it carries at least this share of the excess. */
    involvedExcessShare: number;
    /** A district-pooled alarm is attributed to a single block (and left to that block's own gates) when one block carries at least this share of the excess. */
    maxSingleBlockExcessShare: number;
  };
  episodes: { maxGapDays: number };
  score: {
    weights: { deviation: number; persistence: number; volume: number; geographic: number; sourceMix: number };
    volumeReference: number;
    deviationPMinLog10: number;
    deviationPSpanLog10: number;
    ratioSpanLog2: number;
    effectiveSourcesSaturation: number;
    mediumFrom: number;
    highFrom: number;
    qualityHistoryReferenceDays: number;
    confidenceVolumeReference: number;
  };
}

export type GateName = "evidence" | "persistence" | "burst" | "bulk" | "ratio" | "concentration";
export type Decision = "candidate" | "watch" | "gated";

/** Result of testing one unit (a set of blocks) for one syndrome and one window length. */
export interface WindowTest {
  w: number;
  windowStart: number; // day index, inclusive
  windowEnd: number; // day index, inclusive (= as-of day)
  observed: number; // reports in the window
  expected: number; // posterior-predictive mean for the window
  ratio: number;
  p: number;
  z: number; // standard-normal equivalent of p (informational)
  cases: number;
  elevatedDays: number;
  maxDayShare: number;
  bulkShare: number;
  unknownSeverityShare: number;
  sourceCounts: number[]; // aligned with SOURCE_KEYS
  historyDays: number; // usable baseline days
  baselineRate: number; // posterior mean rate per exposure-day
  pLeaveOneDayOut: number; // p-value of the window after removing its single largest day
  pNonBulk: number; // p-value of the window after removing bulk-source reports
  failed: GateName[]; // gates that failed (empty => all passed)
  decision: Decision | null; // null when p > alpha (not a finding)
}

export interface ScoreComponents {
  deviation: number;
  persistence: number;
  volume: number;
  geographic: number;
  sourceMix: number;
  quality: number;
  qualityParts: { history: number; bulk: number; severity: number };
  effectiveSources: number;
  involvedBlocks: number;
  blocksInDistrict: number;
}

export interface ScoreResult {
  score: number; // 0-100, ranking/priority only. NOT a probability.
  priority: "low" | "medium" | "high";
  confidence: number; // 0-1 evidence SUFFICIENCY (data quality x volume). NOT a probability of a real event.
  components: ScoreComponents;
  formulaVersion: string;
}

/** One as-of day on which an episode was alarming. */
export interface AlarmSnapshot {
  day: number;
  w: number;
  windowStart: number;
  windowEnd: number;
  involved: string[]; // block ids
  observed: number;
  expected: number;
  ratio: number;
  p: number;
  z: number;
  cases: number;
  elevatedDays: number;
  sourceTypes: number;
  score: ScoreResult;
}

export interface EpisodeRecord {
  key: string;
  districtId: string;
  syndrome: string;
  firstAlarmDay: number;
  lastAlarmDay: number;
  windowStartDay: number; // start of the first alarm's window
  involved: string[]; // blocks persistently involved (monotone: only grows); drives region and localisation
  involvedEver: string[]; // every block ever involved (superset; used only to exclude days from baselines)
  involvedCounts: Record<string, number>; // alarm days on which each block was involved
  nAlarmDays: number;
  peak: AlarmSnapshot; // highest score (ties: earliest)
  latest: AlarmSnapshot;
  open: boolean;
  alarmDays?: AlarmSnapshot[]; // only when requested (evaluation)
}

export interface ReplayState {
  episodes: EpisodeRecord[];
}

/** A screened test that crossed the alpha threshold (candidate / watch / gated). */
export interface Finding {
  asOfDay: number;
  districtId: string;
  scope: "block" | "cluster" | "district";
  blocks: string[];
  syndrome: string;
  test: WindowTest;
}

export interface RunStats {
  asOfDays: number;
  testsRun: number;
  skippedInsufficientHistory: number;
  findings: number;
  candidatesAlarmDays: number;
  byDecision: Record<Decision, number>;
  byGateFailure: Record<GateName, number>;
}
