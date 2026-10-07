// Runs the detector (and comparators / ablations) on a dataset and scores it against the oracle.
// The detector is called with DetectorInput only; the oracle is built separately from the dataset.
import { DETECTOR_V1, DetectorEngine, resolveConfig, type DetectorConfig, type DetectorInput } from "../detection";
import type { EpisodeRecord, Finding } from "../detection/types";
import { generateSyntheticDataset, type EventInput, type SyntheticDataset } from "../synthetic/generate";
import { datasetToDetectorInput } from "./adapter";
import { earsC2Episodes, fixedThresholdEpisodes } from "./comparators";
import { evaluateRun, type EvalEpisode, type MatchRules, type RunEvaluation } from "./match";
import { buildOracle, type OracleEvent } from "./oracle";
import { randomEvents } from "./replicates";

export interface Variant { name: string; cfg: DetectorConfig }

/** The detector variants evaluated alongside the frozen config (ablations). */
export const ABLATIONS: Variant[] = [
  { name: "no_gates", cfg: resolveConfig({ gates: { persistence: false, burst: false, bulk: false, ratio: false } }) },
  { name: "no_bulk_gate", cfg: resolveConfig({ gates: { bulk: false } }) },
  { name: "no_burst_persistence_gate", cfg: resolveConfig({ gates: { persistence: false, burst: false } }) },
  { name: "plugin_poisson", cfg: resolveConfig({ test: { kind: "plugin_poisson" } }) },
];

export function toEvalEpisodes(eps: EpisodeRecord[]): EvalEpisode[] {
  return eps.map((e) => ({
    id: e.key, syndrome: e.syndrome, firstAlarmDay: e.firstAlarmDay, lastAlarmDay: e.lastAlarmDay, involved: e.involved,
    score: e.peak.score.score, priority: e.peak.score.priority,
    alarms: (e.alarmDays ?? []).map((a) => ({ day: a.day, windowStart: a.windowStart, windowEnd: a.windowEnd, involved: a.involved })),
  }));
}

export function rulesFor(input: DetectorInput, cfg: DetectorConfig): MatchRules {
  const days = Math.round((Date.parse(input.endDate) - Date.parse(input.startDate)) / 86_400_000) + 1;
  return {
    tauDays: 2,
    maxWindow: Math.max(...cfg.windows),
    // earliest as-of day on which a test is possible: minHistory usable days + guard + shortest window
    firstEvalDay: cfg.baseline.minHistoryDays - 1 + cfg.baseline.guardDays + Math.min(...cfg.windows),
    lastDay: days - 1,
    syndromes: cfg.syndromes,
    allBlocks: input.regions.filter((r) => r.type === "block").map((r) => r.id).sort(),
  };
}

export interface DatasetEvaluation {
  seed: number;
  oracle: OracleEvent[];
  primary: RunEvaluation;
  comparators: Record<string, RunEvaluation>;
  ablations: Record<string, RunEvaluation>;
  /** Per decoy: was it examined by the detector and rejected by a gate (proof it was seen, not ignored)? */
  decoyGates: Record<string, { examined: boolean; reasons: string[] }>;
  gateFailures: Record<string, number>;
  findings: number;
}

export interface EvaluateOptions {
  cfg?: DetectorConfig;
  variants?: Variant[]; // ablations to run (default: none)
  comparators?: boolean;
  decoyVariants?: Record<string, string>;
  privacyK?: number;
}

function decoyGateProof(oracle: OracleEvent[], findings: Finding[], store: DetectorEngine["store"], maxWindow: number) {
  const out: DatasetEvaluation["decoyGates"] = {};
  for (const ev of oracle.filter((e) => e.kind === "decoy_reporting_artifact")) {
    const reasons = new Set<string>();
    let examined = false;
    for (const f of findings) {
      if (f.test.decision !== "gated" || f.syndrome !== ev.syndrome) continue;
      if (f.asOfDay < ev.startDay || f.asOfDay > ev.endDay + maxWindow) continue;
      if (!f.blocks.some((b) => ev.blocks.includes(b))) continue;
      examined = true;
      for (const r of f.test.failed) reasons.add(r);
    }
    void store;
    out[ev.id] = { examined, reasons: [...reasons].sort() };
  }
  return out;
}

export function evaluateDataset(ds: SyntheticDataset, seed: number, opts: EvaluateOptions = {}): DatasetEvaluation {
  const cfg = opts.cfg ?? DETECTOR_V1;
  const input = datasetToDetectorInput(ds, opts.privacyK ?? 5);
  const rules = rulesFor(input, cfg);
  const engine = new DetectorEngine(input, cfg);
  const oracle = buildOracle(ds, engine.evidenceFloor, opts.decoyVariants ?? {});

  const run = engine.replay({ collectFindings: true, keepAlarmDays: true });
  const primary = evaluateRun(oracle, toEvalEpisodes(run.state.episodes), rules);

  const ablations: Record<string, RunEvaluation> = {};
  for (const v of opts.variants ?? []) {
    const e = new DetectorEngine(input, v.cfg);
    ablations[v.name] = evaluateRun(oracle, toEvalEpisodes(e.replay({ keepAlarmDays: true }).state.episodes), rulesFor(input, v.cfg));
  }

  const comparators: Record<string, RunEvaluation> = {};
  if (opts.comparators) {
    comparators.fixed_threshold = evaluateRun(oracle, fixedThresholdEpisodes(input, cfg.syndromes), rules);
    comparators.ears_c2 = evaluateRun(oracle, earsC2Episodes(input, cfg.syndromes), rules);
  }

  const gateFailures: Record<string, number> = { ...run.stats.byGateFailure };
  return {
    seed, oracle, primary, comparators, ablations,
    decoyGates: decoyGateProof(oracle, run.findings, engine.store, rules.maxWindow),
    gateFailures, findings: run.stats.findings,
  };
}

/** Generate a randomised replicate (true clusters + decoy variants) and evaluate it. */
export function evaluateReplicate(seed: number, opts: EvaluateOptions = {}): DatasetEvaluation {
  const { events, meta } = randomEvents(seed);
  const ds = generateSyntheticDataset({ seed, events: events as EventInput[], batch: `replicate-${seed}` });
  return evaluateDataset(ds, seed, { ...opts, decoyVariants: meta.decoyVariants });
}

/** A null dataset: no planted events at all. Every episode is a false alarm. */
export function evaluateNull(seed: number, opts: EvaluateOptions = {}): DatasetEvaluation {
  const ds = generateSyntheticDataset({ seed, events: [], batch: `null-${seed}` });
  return evaluateDataset(ds, seed, opts);
}
