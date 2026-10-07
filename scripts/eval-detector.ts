// Detector evaluation against the planted ground truth (in-memory; no database).
//
//   npm run eval:detector -- --split=dev      calibration on DEV seeds only (free to inspect)
//   npm run eval:detector -- --freeze         write the frozen-config file (do this BEFORE the test split)
//   npm run eval:detector -- --split=test     primary M2 dataset + HELD-OUT replicates + null runs (write artefacts)
//
// The held-out split refuses to run unless the committed frozen config matches the code's config hash.
// Results validate the IMPLEMENTATION and its CALIBRATION on synthetic Poisson data. They are not
// estimates of real-world epidemiological performance.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DETECTOR_V1, configHash } from "../src/detection";
import { MATCHING_RULES_VERSION } from "../src/evaluation/match";
import { summarise, type Summary } from "../src/evaluation/metrics";
import { SEED_SPLITS } from "../src/evaluation/replicates";
import { ABLATIONS, evaluateDataset, evaluateNull, evaluateReplicate, type DatasetEvaluation } from "../src/evaluation/runner";
import { SYNTHETIC_SEED, generateSyntheticDataset } from "../src/synthetic/generate";

const FREEZE_FILE = "data/detection/m3-detector-v1.config.json";
const RESULT_FILE = "data/detection/m3-evaluation-v1.json";
const DEV_FILE = "data/detection/m3-calibration-dev.json";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}`))?.split("=")[1] ?? (process.argv.includes(`--${name}`) ? "true" : undefined);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hashOf = (o: unknown) => sha(JSON.stringify(o));

function progress(label: string, i: number, n: number) {
  if (i === 0 || (i + 1) % 25 === 0 || i + 1 === n) console.log(`  ${label}: ${i + 1}/${n}`);
}

function summaries(evals: DatasetEvaluation[], label: string) {
  const out: Record<string, Summary> = { detector: summarise(evals.map((e) => e.primary), `${label}|detector`) };
  for (const name of Object.keys(evals[0]?.comparators ?? {})) out[`comparator:${name}`] = summarise(evals.map((e) => e.comparators[name]), `${label}|${name}`);
  for (const name of Object.keys(evals[0]?.ablations ?? {})) out[`ablation:${name}`] = summarise(evals.map((e) => e.ablations[name]), `${label}|${name}`);
  return out;
}

function brief(name: string, s: Summary) {
  const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : "n/a");
  console.log(
    `${name.padEnd(34)} recall ${s.clusters.all.k}/${s.clusters.all.n} (${pct(s.clusters.all.value)} ci ${pct(s.clusters.all.ci95[0])}-${pct(s.clusters.all.ci95[1])})` +
    ` | evaluable ${s.clusters.evaluable.k}/${s.clusters.evaluable.n} | delay med ${s.delay.median}d` +
    ` | FP ep/run ${s.episodes.falsePerRun.mean} (decoy ${s.episodes.falseDecoy}, spurious ${s.episodes.falseSpurious})` +
    ` | prec ${pct(s.episodes.precision.value)} | decoy rejected ${s.decoys.all.k}/${s.decoys.all.n}`);
}

async function main() {
  const cfgHash = configHash(DETECTOR_V1);

  if (arg("freeze")) {
    mkdirSync("data/detection", { recursive: true });
    writeFileSync(FREEZE_FILE, JSON.stringify({
      note: "Detector configuration frozen BEFORE the held-out evaluation. Every value was chosen a priori; none was fitted to planted ground truth.",
      detector_version: DETECTOR_V1.version, config_hash: cfgHash, config: DETECTOR_V1,
    }, null, 2) + "\n");
    console.log(`froze config ${cfgHash} -> ${FREEZE_FILE}`);
    return;
  }

  const split = arg("split") ?? "dev";

  if (split === "dev") {
    console.log(`DEV split (free to inspect). config ${cfgHash}`);
    const nulls: DatasetEvaluation[] = [];
    SEED_SPLITS.devNull.forEach((seed, i) => { nulls.push(evaluateNull(seed, { comparators: true })); progress("dev null", i, SEED_SPLITS.devNull.length); });
    const reps: DatasetEvaluation[] = [];
    SEED_SPLITS.devReplicates.forEach((seed, i) => { reps.push(evaluateReplicate(seed, { comparators: true })); progress("dev replicates", i, SEED_SPLITS.devReplicates.length); });
    const nullSummary = summaries(nulls, "devnull");
    const repSummary = summaries(reps, "devrep");
    console.log("\n-- NULL runs (no planted events): every episode is a false alarm");
    for (const [k, v] of Object.entries(nullSummary)) console.log(`${k.padEnd(28)} false episodes/run ${v.episodes.falsePerRun.mean} (ci ${v.episodes.falsePerRun.ci95.join("-")}) runs with any ${v.episodes.falsePerRun.runsWithAny}/${v.runs}  unit FPR ${(v.units.fpr * 1e4).toFixed(2)} per 10k`);
    console.log("\n-- DEV replicates");
    for (const [k, v] of Object.entries(repSummary)) brief(k, v);
    mkdirSync("data/detection", { recursive: true });
    writeFileSync(DEV_FILE, JSON.stringify({ config_hash: cfgHash, matching_rules_version: MATCHING_RULES_VERSION, split: "dev", seeds: { null: SEED_SPLITS.devNull, replicates: SEED_SPLITS.devReplicates }, null_runs: nullSummary, replicates: repSummary }, null, 2) + "\n");
    console.log(`\nwrote ${DEV_FILE}`);
    return;
  }

  if (split === "test") {
    if (!existsSync(FREEZE_FILE)) throw new Error(`Missing ${FREEZE_FILE}: run --freeze (and commit it) before the held-out split.`);
    const frozen = JSON.parse(readFileSync(FREEZE_FILE, "utf8"));
    if (frozen.config_hash !== cfgHash) throw new Error(`Config changed since freeze (${frozen.config_hash} != ${cfgHash}). Re-freeze and re-evaluate; do not tune on the held-out split.`);
    console.log(`TEST split (held-out). frozen config ${cfgHash} verified.`);

    // 1. Primary: the committed M2 dataset with its planted P1-P4 and decoy D1 (seen during planning: illustrative).
    const ds = generateSyntheticDataset();
    const primary = evaluateDataset(ds, SYNTHETIC_SEED, { variants: ABLATIONS, comparators: true });
    const primarySummary = summaries([primary], "primary");

    // 2. Held-out replicates (randomised clusters + decoy variants), ablations and comparators on identical data.
    const reps: DatasetEvaluation[] = [];
    SEED_SPLITS.testReplicates.forEach((seed, i) => { reps.push(evaluateReplicate(seed, { variants: ABLATIONS, comparators: true })); progress("held-out replicates", i, SEED_SPLITS.testReplicates.length); });
    const repSummary = summaries(reps, "testrep");

    // 3. Null calibration on held-out null seeds.
    const nulls: DatasetEvaluation[] = [];
    SEED_SPLITS.testNull.forEach((seed, i) => { nulls.push(evaluateNull(seed, { variants: ABLATIONS, comparators: true })); progress("held-out null", i, SEED_SPLITS.testNull.length); });
    const nullSummary = summaries(nulls, "testnull");

    // decoy gate proof: examined and rejected by which gates
    const gateProof: Record<string, { examined: number; n: number; reasons: Record<string, number> }> = {};
    for (const r of reps) for (const [id, g] of Object.entries(r.decoyGates)) {
      const variant = r.oracle.find((o) => o.id === id)?.variant ?? id;
      const e = (gateProof[variant] ??= { examined: 0, n: 0, reasons: {} });
      e.n++;
      if (g.examined) e.examined++;
      for (const reason of g.reasons) e.reasons[reason] = (e.reasons[reason] ?? 0) + 1;
    }

    const primaryDetail = primary.primary.events.map((e) => ({
      id: e.id, kind: e.kind, syndrome: e.syndrome, shape: e.shape, multiplier: e.multiplier, evaluable: e.evaluable, realized_reports: e.realizedReports,
      detected: e.detected, late_detected: e.lateDetected, credited_day: e.creditedDay, delay_days: e.delayDays, normalized_delay: e.normalizedDelay,
      episodes: e.episodes, localization: e.localization, decoy_alerted: e.kind === "decoy_reporting_artifact" ? e.alerted : undefined,
      decoy_gate_proof: primary.decoyGates[e.id],
    }));

    const result = {
      artefact: "m3-evaluation-v1",
      disclaimer: "Synthetic Poisson benchmark. Validates implementation correctness and calibration; it does NOT estimate real-world epidemiological performance.",
      detector: { version: DETECTOR_V1.version, method_code: DETECTOR_V1.methodCode, config_hash: cfgHash },
      matching_rules_version: MATCHING_RULES_VERSION,
      hashes: {
        m2_manifest_reports_sha256: JSON.parse(readFileSync("data/synthetic/m2-odisha-v1.manifest.json", "utf8")).reports_sha256,
        m2_ground_truth_sha256: JSON.parse(readFileSync("data/synthetic/m2-odisha-v1.manifest.json", "utf8")).ground_truth_sha256,
        results_summary_sha256: hashOf({ primarySummary, repSummary, nullSummary }),
      },
      seeds: { test_replicates: [SEED_SPLITS.testReplicates[0], SEED_SPLITS.testReplicates[SEED_SPLITS.testReplicates.length - 1]], test_null: [SEED_SPLITS.testNull[0], SEED_SPLITS.testNull[SEED_SPLITS.testNull.length - 1]], primary_seed: SYNTHETIC_SEED },
      primary_m2_dataset: { note: "Seen by the developers during planning; illustrative, not held-out.", events: primaryDetail, summary: primarySummary },
      held_out_replicates: { n: reps.length, summary: repSummary, decoy_gate_proof: gateProof },
      null_calibration: { n: nulls.length, summary: nullSummary },
    };
    mkdirSync("data/detection", { recursive: true });
    writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2) + "\n");
    console.log(`\nwrote ${RESULT_FILE}`);

    console.log("\n== PRIMARY (M2 dataset)");
    for (const e of primaryDetail) console.log(`  ${e.id} ${e.kind === "true_cluster" ? "cluster" : "decoy  "} detected=${e.detected} delay=${e.delay_days} loc=${JSON.stringify(e.localization)} alerted=${e.decoy_alerted} gates=${JSON.stringify(e.decoy_gate_proof?.reasons)}`);
    for (const [k, v] of Object.entries(primarySummary)) brief(k, v);
    console.log("\n== HELD-OUT replicates");
    for (const [k, v] of Object.entries(repSummary)) brief(k, v);
    console.log("\n== HELD-OUT null calibration");
    for (const [k, v] of Object.entries(nullSummary)) console.log(`${k.padEnd(34)} false episodes/run ${v.episodes.falsePerRun.mean} (ci ${v.episodes.falsePerRun.ci95.join("-")}) runs with any ${v.episodes.falsePerRun.runsWithAny}/${v.runs}`);
    return;
  }
  throw new Error(`unknown split '${split}'`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
