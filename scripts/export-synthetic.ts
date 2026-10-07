// Regenerates the committed reproducibility artefacts for the synthetic dataset:
//   data/synthetic/m2-odisha-v1.manifest.json      (counts + SHA-256 of the canonical report stream)
//   data/synthetic/m2-odisha-v1.ground-truth.json  (planted clusters + decoy, for M3 evaluation)
// Usage: npm run synth:export
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  DAYS, START_DATE, SYNTHETIC_BATCH, SYNTHETIC_SEED, canonicalReportLine, generateSyntheticDataset,
} from "../src/synthetic/generate";

export function buildManifest() {
  const ds = generateSyntheticDataset();
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const countBy = <T,>(xs: T[], f: (x: T) => string) =>
    Object.fromEntries([...xs.reduce((m, x) => m.set(f(x), (m.get(f(x)) ?? 0) + 1), new Map<string, number>())].sort());
  const reportStream = ds.reports.map(canonicalReportLine).join("\n");
  return {
    ds,
    manifest: {
      batch: SYNTHETIC_BATCH,
      seed: SYNTHETIC_SEED,
      start_date: START_DATE,
      days: DAYS,
      region_count: ds.geography.regions.length,
      report_count: ds.reports.length,
      case_count: ds.reports.reduce((s, r) => s + r.case_count, 0),
      reports_by_source: countBy(ds.reports, (r) => r.source_type),
      reports_by_syndrome: countBy(ds.reports, (r) => r.syndrome),
      reports_sha256: sha(reportStream),
      regions_sha256: sha(JSON.stringify(ds.geography.regions)),
      ground_truth_sha256: sha(JSON.stringify(ds.groundTruth)),
      note: "Entirely synthetic. No real patients, no real personal data. Administrative codes are fictional (SYN-*).",
    },
  };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("export-synthetic.ts")) {
  const { ds, manifest } = buildManifest();
  mkdirSync("data/synthetic", { recursive: true });
  writeFileSync(`data/synthetic/${SYNTHETIC_BATCH}.manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(`data/synthetic/${SYNTHETIC_BATCH}.ground-truth.json`, JSON.stringify(ds.groundTruth, null, 2) + "\n");
  console.log(JSON.stringify(manifest, null, 2));
}
