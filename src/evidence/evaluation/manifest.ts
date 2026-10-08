// The evaluation manifest and the frozen-configuration discipline (mirroring M3's `eval:detector --freeze`).
//
// FREEZE. Before the held-out TEST split is run, the hashes of everything it depends on are written to frozen-config.json and committed:
// the scenario set (which fixes the dev/test split), the reference judgments, the corpus, the retrieval configurations, the ranking
// configuration, the bundle schema, the generation prompt, and the production source files. The test split REFUSES to run if any of
// them differs, so a result seen on the test split cannot be followed by a production change and a re-run. A change to production
// behaviour is a new version with a new freeze, never a tweak made after looking at test results.
import type { AdversarialReport } from "./adversarial";
import type { Invariant } from "./invariants";
import type { JudgeValidation } from "./judge";
import { PENDING_HUMAN_EVALUATION } from "./review";
import { DISCLAIMER, EVAL_VERSION, MANIFEST_SCHEMA, type ScenarioSet } from "./types";

export const FROZEN_SCHEMA = "m4-eval-frozen/1";

export interface FrozenHashes {
  scenario_set_hash: string;
  judgments_hash: string;
  doc_roles_hash: string;
  corpus_hash: string;
  retrieval_config_hash_dev: string;
  retrieval_config_hash_production: string;
  ranking_config_hash: string;
  query_vocab_version: string;
  bundle_schema_version: string;
  bundle_schema_hash: string;
  prompt_version: string;
  prompt_hash: string;
  production_sources_hash: string;
  m3_detector_config_hash: string;
}

export interface FrozenConfig {
  artefact: "m4-6-frozen-config";
  schema: typeof FROZEN_SCHEMA;
  note: string;
  hashes: FrozenHashes;
}

export interface HashDifference {
  field: string;
  frozen: string;
  current: string;
}

export function diffHashes(frozen: FrozenHashes, current: FrozenHashes): HashDifference[] {
  return (Object.keys(frozen) as Array<keyof FrozenHashes>)
    .filter((k) => frozen[k] !== current[k])
    .map((k) => ({ field: k, frozen: String(frozen[k]), current: String(current[k] ?? "(missing)") }));
}

export function frozenConfig(hashes: FrozenHashes): FrozenConfig {
  return {
    artefact: "m4-6-frozen-config",
    schema: FROZEN_SCHEMA,
    note: "Frozen BEFORE the held-out test split was run. The test split refuses to run, and `eval:evidence --check` fails, if any value here differs from the code and data being evaluated. Re-freezing is a new evaluation version, not a tuning step.",
    hashes,
  };
}

export class FrozenConfigMismatch extends Error {
  constructor(readonly differences: HashDifference[]) {
    super(`The held-out split refuses to run: ${differences.length} frozen value(s) changed (${differences.map((d) => d.field).join(", ")}). Do not tune on the held-out split.`);
    this.name = "FrozenConfigMismatch";
  }
}

/** Throws FrozenConfigMismatch if anything the test split depends on changed since the freeze. */
export function assertFrozen(frozen: FrozenConfig | null, current: FrozenHashes): void {
  if (!frozen) throw new Error("No frozen-config.json: run `npm run eval:evidence -- --freeze` (and commit it) before the held-out split.");
  const diff = diffHashes(frozen.hashes, current);
  if (diff.length) throw new FrozenConfigMismatch(diff);
}

// ------------------------------------------------------------------------------------------------ manifest
export interface ManifestInput {
  hashes: FrozenHashes;
  frozenMatches: boolean;
  set: ScenarioSet;
  judgmentRows: number;
  evaluationCodeHash: string;
  artifacts: Record<string, { hash: string; kind: "json" | "csv" }>;
  judge: JudgeValidation;
  invariants: readonly Invariant[];
  adversarial: AdversarialReport;
  determinism: { rerun_identical: boolean; compared: string[] };
  provider: { id: string; model: string };
}

export function buildManifest(i: ManifestInput) {
  const dev = i.set.scenarios.filter((s) => s.split === "dev").length;
  const failed = i.invariants.filter((v) => v.status === "fail");
  return {
    artefact: "m4-6-evaluation-manifest",
    schema: MANIFEST_SCHEMA,
    evaluation_version: EVAL_VERSION,
    disclaimer: DISCLAIMER,
    hashes: i.hashes,
    frozen: { matches_frozen_config: i.frozenMatches },
    scenario_set: {
      version: i.set.version,
      total: i.set.scenarios.length,
      dev,
      test: i.set.scenarios.length - dev,
      m3_derived: i.set.scenarios.filter((s) => s.family === "m3_derived").length,
      edge_cases: i.set.scenarios.filter((s) => s.family === "edge_case").length,
      split_rule: i.set.split_rule,
    },
    judgments: { label: "synthetic_reference_judgment", rows: i.judgmentRows, expert_judgments: false },
    generation: {
      provider: i.provider.id,
      model: i.provider.model,
      kind: "scripted deterministic MockProvider; stored outputs replayed through the real pipeline",
      live_provider_run: false,
      prompt_version: i.hashes.prompt_version,
      prompt_hash: i.hashes.prompt_hash,
    },
    evaluation_code: { version: EVAL_VERSION, sources_hash: i.evaluationCodeHash },
    artifacts: i.artifacts,
    adversarial: { cases: i.adversarial.cases, fixtures: i.adversarial.fixtures, unsafe_accepted: i.adversarial.unsafe_accepted, cases_hash: i.adversarial.cases_hash },
    invariants: {
      total: i.invariants.length,
      passed: i.invariants.filter((v) => v.status === "pass").length,
      failed: failed.length,
      not_exercised: i.invariants.filter((v) => v.status === "not_exercised").length,
      critical_failures: failed.filter((v) => v.critical).map((v) => v.id),
    },
    judge: { status: i.judge.status, reportable: i.judge.reportable, policy_version: i.judge.policy_version, reasons: i.judge.reasons },
    human_evaluation: { status: "pending", items: PENDING_HUMAN_EVALUATION.map((p) => p.id) },
    determinism: i.determinism,
    limitations: [
      "The corpus and the relevance judgments are synthetic and were authored from the same controlled vocabulary the pipeline uses, so agreement between them is expected and is not evidence of real-world retrieval quality.",
      "Scenarios were authored by the same project that wrote the pipeline, with knowledge of the corpus; the held-out split protects against tuning on test results but is not a blind test.",
      "Generation metrics describe the pipeline driven by a scripted provider, not any language model. Factual consistency is not measured.",
      "No expert judgments, clinical or epidemiological review, or Hindi/Odia evaluation exists; all are pending.",
    ],
  };
}
