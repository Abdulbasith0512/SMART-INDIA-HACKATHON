// @vitest-environment node
// The committed evaluation artefacts (data/evidence/eval/): they are exactly what the harness produces from the committed inputs
// and the unmodified production code, they were produced under the frozen configuration, and they claim nothing they cannot.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVAL_DIR, FILES, authoredDifferences, exists, jsonArtifactHash, loadFrozen, readJson, textArtifactHash } from "./artifacts";
import { canonHash, compareWithStored, load, produceAll, requireFrozen } from "./produce";
import { diffHashes } from "./manifest";
import { kit } from "./testkit";

const root = process.cwd();
const dir = join(root, EVAL_DIR);
// parsed artefact JSON, read by key in the assertions below (the shapes are asserted, not typed)
const json = (name: string): ReturnType<typeof JSON.parse> => readJson(root, name);

describe("committed artefacts exist", () => {
  it("has every artefact the milestone promises", () => {
    for (const f of Object.values(FILES).filter((n) => n !== FILES.judgeLabels)) expect(exists(root, f), f).toBe(true);
    expect(exists(root, FILES.judgeLabels)).toBe(false); // no human labels exist, and none are invented
  });
});

describe("reproducibility", () => {
  it("every committed artefact equals the recomputed artefact (determinism rerun, regression detection)", async () => {
    const l = load(root);
    requireFrozen(l);
    expect(authoredDifferences(l.base, root)).toEqual([]);
    const p = await produceAll(l);
    expect(compareWithStored(l, p)).toEqual([]);
    expect(p.manifest.determinism.rerun_identical).toBe(true);
  }, 180_000);

  it("the manifest's artefact hashes are the hashes of the files on disk", () => {
    const m = json(FILES.manifest);
    for (const [name, a] of Object.entries<{ hash: string; kind: string }>(m.artifacts)) {
      if (name === FILES.manifest) continue;
      expect(a.kind === "csv" ? textArtifactHash(root, name) : jsonArtifactHash(root, name), name).toBe(a.hash);
    }
  });

  it("every result was produced under the frozen configuration, which still equals the code being run", () => {
    const frozen = loadFrozen(root)!;
    for (const f of [FILES.dev, FILES.test, FILES.adversarial, FILES.metrics]) expect(diffHashes(frozen.hashes, json(f).config), f).toEqual([]);
    expect(diffHashes(frozen.hashes, json(FILES.manifest).hashes)).toEqual([]);
    expect(json(FILES.manifest).frozen.matches_frozen_config).toBe(true);
    expect(canonHash(frozen.hashes)).toBe(canonHash(load(root).hashes));
  });

  it("records the corpus, scenario, judgment, retrieval, ranking, bundle, prompt and provider identity", () => {
    const m = json(FILES.manifest);
    for (const k of ["corpus_hash", "scenario_set_hash", "judgments_hash", "retrieval_config_hash_dev", "retrieval_config_hash_production", "ranking_config_hash", "bundle_schema_version", "bundle_schema_hash", "prompt_version", "prompt_hash"]) {
      expect(String(m.hashes[k]).length, k).toBeGreaterThan(8);
    }
    expect(m.generation).toMatchObject({ provider: "mock", model: "mock-1", live_provider_run: false });
    expect(m.evaluation_code.version).toBe("m4-eval/1.0.0");
    expect(m.hashes.corpus_hash).toBe(kit().base.corpusHash);
  });

  it("contains no timestamps, absolute paths or secrets", () => {
    const files = readdirSync(dir).filter((f) => /\.(json|csv)$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(12);
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, f).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(text, f).not.toMatch(/[A-Za-z]:[\\/]Users[\\/]/);
      expect(text, f).not.toMatch(/AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{30,}\.|sk-[A-Za-z0-9]{20,}/);
    }
  });

  it("the experiments directory (raw provider output) is git-ignored and absent", () => {
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toMatch(/data\/evidence\/eval\/experiments\//);
    expect(existsSync(join(dir, "experiments"))).toBe(false);
  });
});

describe("what the committed results claim", () => {
  const metrics = json(FILES.metrics);
  const manifest = json(FILES.manifest);

  it("splits 64 scenarios into 36 dev and 28 held-out test, 40 derived from M3 episode shapes and 24 hand-authored", () => {
    expect(manifest.scenario_set).toMatchObject({ total: 64, dev: 36, test: 28, m3_derived: 40, edge_cases: 24 });
    expect(metrics.dev.scenarios).toBe(36);
    expect(metrics.test.scenarios).toBe(28);
  });

  it("every safety and integrity invariant passed, with its denominator, and none was left unexercised", () => {
    expect(metrics.invariants.length).toBe(15);
    for (const i of metrics.invariants) {
      expect(i.status, i.id).toBe("pass");
      expect(i.units, i.id).toBeGreaterThan(0);
      expect(i.violations, i.id).toBe(0);
    }
    expect(manifest.invariants).toMatchObject({ failed: 0, not_exercised: 0, critical_failures: [] });
    for (const split of ["dev", "test"]) for (const i of metrics.invariants_by_split[split]) expect(i.status, `${split}/${i.id}`).not.toBe("fail");
  });

  it("zero adversarial outputs were accepted across 45 fixtures and 11 categories, and no fixture was vacuous", () => {
    const a = json(FILES.adversarial).summary;
    expect(a.cases).toBe(2880);
    expect(a.fixtures).toBe(45);
    expect(a.unsafe_accepted).toBe(0);
    expect(a.fixtures_never_challenged).toEqual([]);
    expect(a.failures).toEqual([]);
    expect(Object.keys(a.by_category).length).toBe(12);
  });

  it("synthetic evaluation is never presented as real-world quality, and weak retrieval is reported", () => {
    expect(metrics.disclaimer).toMatch(/NOT evidence of real-world retrieval quality/);
    expect(JSON.stringify(manifest.limitations)).toMatch(/not a blind test/);
    // the finding that keyword-stuffed distractors reach the final selection is in the artefact, not hidden
    for (const split of ["dev", "test"]) {
      expect(metrics[split].retrieval.filler.breakdown.annotated_distractor, split).toBeGreaterThan(0);
      expect(metrics[split].retrieval.filler.scenarios_presenting_an_annotated_distractor.k, split).toBeGreaterThan(0);
    }
    expect(metrics.behaviour_findings.length).toBeGreaterThan(0);
  });

  it("generation metrics are labelled as scripted-pipeline metrics and factual consistency is not measured", () => {
    for (const split of ["dev", "test"]) {
      expect(metrics[split].generation.factual_consistency.status).toBe("not_measured");
      expect(metrics[split].generation.provider_kind).toBe("scripted_mock_provider");
      expect(metrics[split].generation.caveat).toMatch(/not a measure of any language model/);
    }
  });

  it("the model judge is NOT validated and its numbers are not reportable; human evaluation is pending", () => {
    expect(metrics.judge).toMatchObject({ status: "not_validated", reportable: false });
    expect(metrics.judge.validation.human_validation).toBeNull();
    expect(metrics.human_evaluation.status).toBe("pending");
    expect(metrics.human_evaluation.pending.map((p: { id: string }) => p.id)).toEqual(["real_corpus_relevance", "clinical_epidemiological_accuracy", "verifier_usefulness", "source_tier_appropriateness", "hindi_odia_quality"]);
    expect(json(FILES.review).rating_status).toBe("pending");
  });

  it("the test split was run with the same scenario set, judgments and configuration as the dev split", () => {
    expect(json(FILES.dev).config).toEqual(json(FILES.test).config);
  });
});
