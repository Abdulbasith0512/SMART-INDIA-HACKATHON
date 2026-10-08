// File access for the evaluation artefacts (data/evidence/eval/) and the hashes that bind them to the production configuration.
// Scripts and tests only; never imported by application code.
//
// Artefact hashes are computed over the PARSED, canonical JSON (hashJson), not the raw file bytes, so a CRLF checkout on Windows
// and an LF checkout elsewhere hash identically. Source-file hashes normalise line endings for the same reason.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex, hashJson } from "../hash";
import { RETRIEVAL_CONFIG_DEV, RETRIEVAL_CONFIG_V1, retrievalConfigHash } from "../retrieval/config";
import { RANKING_CONFIG_V1, rankingConfigHash } from "../ranking/policy";
import { BUNDLE_SCHEMA_VERSION } from "../bundle/types";
import { PROMPT_HASH, PROMPT_VERSION } from "../llm/prompt";
import { QUERY_VOCAB_VERSION } from "../vocab";
import { authorScenarioSet } from "./authoring";
import { judgeAll, JUDGMENT_CONVENTION, docRolesHash } from "./judgments";
import { inputsFor, type CorpusBase } from "./scenarioCorpus";
import type { FrozenConfig, FrozenHashes } from "./manifest";
import { DISCLAIMER, JUDGMENT_LABEL, JUDGMENT_SCHEMA, docRolesSchema, judgmentsSchema, scenarioSetSchema, type DocRoles, type JudgmentRow, type Judgments, type ScenarioSet } from "./types";

export const EVAL_DIR = join("data", "evidence", "eval");
export const FILES = {
  scenarioSet: "scenario-set.json",
  judgments: "judgments.json",
  docRoles: "doc-roles.json",
  frozen: "frozen-config.json",
  dev: "dev-results.json",
  test: "test-results.json",
  adversarial: "adversarial-results.json",
  metrics: "metrics.json",
  manifest: "evaluation-manifest.json",
  judgeValidation: "judge-validation.json",
  review: "review-dataset.json",
  reviewItemsCsv: "review-items.csv",
  reviewClaimsCsv: "review-claims.csv",
  judgeLabels: "judge-labels.json",
} as const;

/** Hash of what a JSON file would contain (a JSON round trip drops undefined), so in-memory values and re-read artefacts hash identically. */
export const plainHash = (v: unknown): string => hashJson(JSON.parse(JSON.stringify(v)));

const norm = (s: string): string => s.replace(/\r\n/g, "\n");
const path = (root: string, name: string): string => join(root, EVAL_DIR, name);
export const exists = (root: string, name: string): boolean => existsSync(path(root, name));

export function readJson<T = unknown>(root: string, name: string): T {
  return JSON.parse(readFileSync(path(root, name), "utf8")) as T;
}
export function writeJson(root: string, name: string, value: unknown): void {
  mkdirSync(join(root, EVAL_DIR), { recursive: true });
  writeFileSync(path(root, name), `${JSON.stringify(value, null, 2)}\n`);
}
export function writeText(root: string, name: string, text: string): void {
  mkdirSync(join(root, EVAL_DIR), { recursive: true });
  writeFileSync(path(root, name), text);
}
export const readText = (root: string, name: string): string => norm(readFileSync(path(root, name), "utf8"));

/** Hash of a JSON artefact's parsed content (independent of line endings and formatting). */
export const jsonArtifactHash = (root: string, name: string): string => plainHash(readJson(root, name));
export const textArtifactHash = (root: string, name: string): string => sha256Hex(readText(root, name));

// ------------------------------------------------------------------------------------------------ authoring
export function buildJudgmentsArtefact(base: CorpusBase, set: ScenarioSet, roles: DocRoles): Judgments {
  const rows: JudgmentRow[] = judgeAll(set.scenarios, (s) => inputsFor(base, s), roles);
  return judgmentsSchema.parse({
    artefact: "m4-6-judgments", schema: JUDGMENT_SCHEMA, label: JUDGMENT_LABEL, disclaimer: DISCLAIMER, convention: JUDGMENT_CONVENTION,
    doc_roles_hash: docRolesHash(roles), scenario_set_hash: plainHash(set), rows,
  });
}

export const loadDocRoles = (root: string): DocRoles => docRolesSchema.parse(readJson(root, FILES.docRoles));

export interface Authored {
  set: ScenarioSet;
  judgments: Judgments;
  roles: DocRoles;
}

export function author(base: CorpusBase, root: string): Authored {
  const roles = loadDocRoles(root);
  const set = authorScenarioSet(base);
  return { set, judgments: buildJudgmentsArtefact(base, set, roles), roles };
}

export function loadAuthored(root: string): Authored {
  const set = scenarioSetSchema.parse(readJson(root, FILES.scenarioSet));
  const judgments = judgmentsSchema.parse(readJson(root, FILES.judgments));
  const roles = loadDocRoles(root);
  if (judgments.scenario_set_hash !== plainHash(set)) throw new Error("judgments.json was built from a different scenario set than scenario-set.json");
  if (judgments.doc_roles_hash !== docRolesHash(roles)) throw new Error("judgments.json was built from different document roles than doc-roles.json");
  return { set, judgments, roles };
}

/** The committed authored artefacts must equal what the deterministic generators produce now (nothing hand-edited, nothing stale). */
export function authoredDifferences(base: CorpusBase, root: string): string[] {
  const out: string[] = [];
  const committed = loadAuthored(root);
  const fresh = author(base, root);
  if (plainHash(committed.set) !== plainHash(fresh.set)) out.push("scenario-set.json differs from the deterministic authoring output");
  if (plainHash(committed.judgments) !== plainHash(fresh.judgments)) out.push("judgments.json differs from the deterministic judgment rules applied to doc-roles.json");
  return out;
}

// ------------------------------------------------------------------------------------------------ hashes
function sourceFiles(root: string, dir: string, include: (name: string) => boolean): Array<[string, string]> {
  const full = join(root, dir);
  return readdirSync(full, { withFileTypes: true })
    .filter((d) => d.isFile() && include(d.name))
    .map((d): [string, string] => [`${dir.replace(/\\/g, "/")}/${d.name}`, sha256Hex(norm(readFileSync(join(full, d.name), "utf8")))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
const isProductionSource = (n: string): boolean => /\.ts$/.test(n) && !/\.test\.ts$/.test(n);

/** Every non-test production source file the evaluation exercises: retrieval, ranking, bundle, generation, vocabulary and hashing. */
export function productionSourcesHash(root: string): string {
  const files = [
    ...["retrieval", "ranking", "bundle", "llm"].flatMap((d) => sourceFiles(root, join("src", "evidence", d), isProductionSource)),
    ...["vocab.ts", "hash.ts"].map((n): [string, string] => [`src/evidence/${n}`, sha256Hex(norm(readFileSync(join(root, "src", "evidence", n), "utf8")))]),
  ];
  return hashJson(files);
}

/** The evaluation harness' own sources (recorded in the manifest, NOT part of the freeze: a harness bug fix is allowed, a production change is not). */
export function evaluationCodeHash(root: string): string {
  return hashJson(sourceFiles(root, join("src", "evidence", "evaluation"), isProductionSource));
}

const bundleSchemaHash = (root: string): string => sha256Hex(norm(readFileSync(join(root, "src", "evidence", "bundle", "types.ts"), "utf8")));

export function currentHashes(root: string, authored: Authored, corpusHash: string): FrozenHashes {
  const m3 = JSON.parse(readFileSync(join(root, "data", "detection", "m3-detector-v1.config.json"), "utf8")) as { config_hash: string };
  return {
    scenario_set_hash: plainHash(authored.set),
    judgments_hash: plainHash(authored.judgments),
    doc_roles_hash: docRolesHash(authored.roles),
    corpus_hash: corpusHash,
    retrieval_config_hash_dev: retrievalConfigHash(RETRIEVAL_CONFIG_DEV),
    retrieval_config_hash_production: retrievalConfigHash(RETRIEVAL_CONFIG_V1),
    ranking_config_hash: rankingConfigHash(RANKING_CONFIG_V1),
    query_vocab_version: QUERY_VOCAB_VERSION,
    bundle_schema_version: BUNDLE_SCHEMA_VERSION,
    bundle_schema_hash: bundleSchemaHash(root),
    prompt_version: PROMPT_VERSION,
    prompt_hash: PROMPT_HASH,
    production_sources_hash: productionSourcesHash(root),
    m3_detector_config_hash: m3.config_hash,
  };
}

export const loadFrozen = (root: string): FrozenConfig | null => (exists(root, FILES.frozen) ? readJson<FrozenConfig>(root, FILES.frozen) : null);
