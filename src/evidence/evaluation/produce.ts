// Produces every evaluation artefact from the committed authored inputs and the unmodified production code. File access lives in
// artifacts.ts; this module wires the pieces together for the CLI (scripts/eval-evidence.ts), the verifier and the tests.
//
// Workflow (mirrors M3): author -> freeze -> dev (free to inspect) -> test (refuses if anything frozen changed) -> adversarial ->
// finalize (recomputes everything, proves it equals what was stored, writes metrics / judge / review / manifest) -> check (anytime).
import { z } from "zod";
import { hashJson, sha256Hex } from "../hash";
import { loadDevCorpus, type DevCorpus } from "./devcorpus";
import { EVAL_DIR, FILES, plainHash, currentHashes, evaluationCodeHash, exists, loadAuthored, loadFrozen, readJson, readText, type Authored } from "./artifacts";
import { buildContext, runAdversarial, runSplit, summariseSplit, type AdversarialRun, type EvalContext, type SplitRun, type SplitSummary } from "./evaluate";
import { checkInvariants, type Invariant } from "./invariants";
import { LexicalBaselineJudge, constructedPairs, validateJudge, type ClaimPassagePair, type JudgeValidation } from "./judge";
import { assertFrozen, buildManifest, type FrozenHashes } from "./manifest";
import { PENDING_HUMAN_EVALUATION, reviewClaimsCsv, reviewDataset, reviewItemsCsv } from "./review";
import { DISCLAIMER, EVAL_VERSION, RESULTS_SCHEMA, type Split } from "./types";
import { join } from "node:path";

export interface Loaded {
  root: string;
  base: DevCorpus;
  authored: Authored;
  ctx: EvalContext;
  hashes: FrozenHashes;
}

export function load(root: string = process.cwd()): Loaded {
  const base = loadDevCorpus(root);
  const authored = loadAuthored(root);
  return { root, base, authored, ctx: buildContext(base, authored.set, authored.roles, authored.judgments.rows), hashes: currentHashes(root, authored, base.corpusHash) };
}

/** Throws FrozenConfigMismatch unless every frozen hash equals the code and data being evaluated. */
export const requireFrozen = (l: Loaded): void => assertFrozen(loadFrozen(l.root), l.hashes);

export const canonHash = plainHash;

// ------------------------------------------------------------------------------------------------ split / adversarial artefacts
export const resultsArtefact = (split: Split, run: SplitRun, hashes: FrozenHashes) => ({
  artefact: "m4-6-results",
  schema: RESULTS_SCHEMA,
  split,
  evaluation_version: EVAL_VERSION,
  disclaimer: DISCLAIMER,
  config: hashes,
  scenarios: run.results,
});

export async function computeSplit(l: Loaded, split: Split): Promise<{ run: SplitRun; artefact: ReturnType<typeof resultsArtefact> }> {
  const run = await runSplit(l.ctx, split);
  return { run, artefact: resultsArtefact(split, run, l.hashes) };
}

export const adversarialArtefact = (run: AdversarialRun, hashes: FrozenHashes) => ({
  artefact: "m4-6-adversarial-results",
  schema: RESULTS_SCHEMA,
  evaluation_version: EVAL_VERSION,
  disclaimer: DISCLAIMER,
  target: "ZERO accepted unsafe outputs. A case passes when the fixture's unsafe content never reaches an accepted explanation.",
  method:
    "Each fixture is a deliberately unsafe scripted model answer (or a hostile passage that the scripted model obeys) run against every scenario's bundle. " +
    "Whether unsafe content was accepted is decided by independent checks (planted payload search, citation-id and verbatim-anchor re-checks), not by the production validators.",
  config: hashes,
  fixtures: run.fixtures,
  summary: run.report,
});

export async function computeAdversarial(l: Loaded): Promise<{ run: AdversarialRun; artefact: ReturnType<typeof adversarialArtefact> }> {
  const run = await runAdversarial(l.ctx);
  return { run, artefact: adversarialArtefact(run, l.hashes) };
}

// ------------------------------------------------------------------------------------------------ judge validation
const humanPairsSchema = z
  .object({
    artefact: z.literal("m4-6-judge-labels"),
    pairs: z.array(
      z.object({
        id: z.string(), claim: z.string().min(1), passage: z.string().min(1),
        label: z.enum(["supported", "partially_supported", "unsupported"]),
        source: z.literal("human"), raters: z.array(z.string()).min(2),
      }).strict(),
    ),
  })
  .strict();

export async function judgeValidation(l: Loaded): Promise<JudgeValidation> {
  const chunks = l.base.view.items.flatMap((i) => i.chunks.map((c) => ({ doc: i.canonicalId ?? i.id, ordinal: c.ordinal, text: c.text })));
  const human = (exists(l.root, FILES.judgeLabels) ? humanPairsSchema.parse(readJson(l.root, FILES.judgeLabels)).pairs : []) as ClaimPassagePair[];
  return validateJudge(new LexicalBaselineJudge(), [...constructedPairs(chunks), ...human]);
}

// ------------------------------------------------------------------------------------------------ derived artefacts
export interface Produced {
  dev: ReturnType<typeof resultsArtefact>;
  test: ReturnType<typeof resultsArtefact>;
  adversarial: ReturnType<typeof adversarialArtefact>;
  metrics: unknown;
  judge: JudgeValidation;
  review: ReturnType<typeof reviewDataset>;
  reviewItemsCsv: string;
  reviewClaimsCsv: string;
  manifest: ReturnType<typeof buildManifest>;
  invariants: { all: Invariant[]; dev: Invariant[]; test: Invariant[] };
  summaries: { dev: SplitSummary; test: SplitSummary };
}

const STORED = [FILES.dev, FILES.test, FILES.adversarial] as const;

export async function produceAll(l: Loaded): Promise<Produced> {
  const [dev, test, adv] = [await computeSplit(l, "dev"), await computeSplit(l, "test"), await computeAdversarial(l)];
  const summaries = { dev: summariseSplit("dev", dev.run.results), test: summariseSplit("test", test.run.results) };
  const all = [...dev.run.results, ...test.run.results];
  const invariants = {
    all: checkInvariants({ results: all, adversarial: adv.run.report }),
    dev: checkInvariants({ results: dev.run.results, adversarial: adv.run.report }),
    test: checkInvariants({ results: test.run.results, adversarial: adv.run.report }),
  };
  const judge = await judgeValidation(l);

  const behaviourFindings = all.flatMap((r) => r.evaluation.checks.filter((c) => c.kind === "behaviour" && !c.ok).map((c) => ({ split: r.split, scenario: r.id, check: c.name, ...(c.detail ? { detail: c.detail } : {}) })));
  const metrics = {
    artefact: "m4-6-metrics",
    schema: RESULTS_SCHEMA,
    evaluation_version: EVAL_VERSION,
    disclaimer: DISCLAIMER,
    config: l.hashes,
    definitions: "docs/M4-EVALUATION.md",
    dev: summaries.dev,
    test: summaries.test,
    adversarial: adv.run.report,
    invariants: invariants.all,
    invariants_by_split: { dev: invariants.dev, test: invariants.test },
    behaviour_findings: behaviourFindings,
    judge: { layer: "B: model judge", status: judge.status, reportable: judge.reportable, validation: judge },
    human_evaluation: { layer: "C: human", status: "pending", pending: PENDING_HUMAN_EVALUATION },
    scripted_generation_note: "Layer A generation metrics describe the pipeline driven by a scripted provider. Factual consistency is not measured.",
  };

  const review = reviewDataset([...dev.run.review, ...test.run.review].sort((a, b) => (a.review_id < b.review_id ? -1 : a.review_id > b.review_id ? 1 : 0)));
  const itemsCsv = reviewItemsCsv(review);
  const claimsCsv = reviewClaimsCsv(review);

  // determinism: the recomputed split / adversarial artefacts equal what was stored in an earlier process
  const compared: string[] = [];
  let identical = true;
  const produced = { [FILES.dev]: dev.artefact, [FILES.test]: test.artefact, [FILES.adversarial]: adv.artefact };
  for (const name of STORED) {
    if (!exists(l.root, name)) throw new Error(`${join(EVAL_DIR, name)} is missing: run the split / adversarial step before finalizing.`);
    compared.push(name);
    if (canonHash(readJson(l.root, name)) !== canonHash(produced[name])) identical = false;
  }

  const artifacts: Record<string, { hash: string; kind: "json" | "csv" }> = {
    [FILES.scenarioSet]: { hash: plainHash(l.authored.set), kind: "json" },
    [FILES.judgments]: { hash: plainHash(l.authored.judgments), kind: "json" },
    [FILES.docRoles]: { hash: plainHash(l.authored.roles), kind: "json" },
    [FILES.frozen]: { hash: canonHash(loadFrozen(l.root)), kind: "json" },
    [FILES.dev]: { hash: canonHash(dev.artefact), kind: "json" },
    [FILES.test]: { hash: canonHash(test.artefact), kind: "json" },
    [FILES.adversarial]: { hash: canonHash(adv.artefact), kind: "json" },
    [FILES.metrics]: { hash: canonHash(metrics), kind: "json" },
    [FILES.judgeValidation]: { hash: canonHash(judge), kind: "json" },
    [FILES.review]: { hash: canonHash(review), kind: "json" },
    [FILES.reviewItemsCsv]: { hash: sha256Hex(itemsCsv), kind: "csv" },
    [FILES.reviewClaimsCsv]: { hash: sha256Hex(claimsCsv), kind: "csv" },
  };
  const frozen = loadFrozen(l.root);
  const manifest = buildManifest({
    hashes: l.hashes,
    frozenMatches: frozen !== null && plainHash(frozen.hashes) === plainHash(l.hashes),
    set: l.authored.set,
    judgmentRows: l.authored.judgments.rows.length,
    evaluationCodeHash: evaluationCodeHash(l.root),
    artifacts,
    judge,
    invariants: invariants.all,
    adversarial: adv.run.report,
    determinism: { rerun_identical: identical, compared },
    provider: { id: "mock", model: "mock-1" },
  });
  return { dev: dev.artefact, test: test.artefact, adversarial: adv.artefact, metrics, judge, review, reviewItemsCsv: itemsCsv, reviewClaimsCsv: claimsCsv, manifest, invariants, summaries };
}

/** The artefacts finalize writes (everything except the authored inputs, the freeze and the three stored split artefacts). */
export const derivedFiles = (p: Produced): Array<{ name: string; kind: "json" | "csv"; value: unknown }> => [
  { name: FILES.metrics, kind: "json", value: p.metrics },
  { name: FILES.judgeValidation, kind: "json", value: p.judge },
  { name: FILES.review, kind: "json", value: p.review },
  { name: FILES.reviewItemsCsv, kind: "csv", value: p.reviewItemsCsv },
  { name: FILES.reviewClaimsCsv, kind: "csv", value: p.reviewClaimsCsv },
  { name: FILES.manifest, kind: "json", value: p.manifest },
];

/** Compare every produced artefact with the committed file. Returns the names that differ or are missing. */
export function compareWithStored(l: Loaded, p: Produced): string[] {
  const bad: string[] = [];
  const check = (name: string, kind: "json" | "csv", value: unknown) => {
    if (!exists(l.root, name)) return bad.push(`${name} (missing)`);
    const same = kind === "json" ? canonHash(readJson(l.root, name)) === canonHash(value) : sha256Hex(readText(l.root, name)) === sha256Hex(value as string);
    if (!same) bad.push(name);
  };
  check(FILES.dev, "json", p.dev);
  check(FILES.test, "json", p.test);
  check(FILES.adversarial, "json", p.adversarial);
  for (const f of derivedFiles(p)) check(f.name, f.kind, f.value);
  return bad;
}
