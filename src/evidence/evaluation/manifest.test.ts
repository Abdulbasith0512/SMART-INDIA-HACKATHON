// @vitest-environment node
// The freeze discipline: the held-out split refuses to run if ANY frozen value differs, and the manifest records everything.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { currentHashes, evaluationCodeHash, loadFrozen, productionSourcesHash } from "./artifacts";
import { FrozenConfigMismatch, assertFrozen, buildManifest, diffHashes, frozenConfig, type FrozenHashes } from "./manifest";
import { kit } from "./testkit";
import { summariseAdversarial } from "./adversarial";
import { checkInvariants } from "./invariants";
import { validateJudge, LexicalBaselineJudge } from "./judge";

const { root, base } = kit();
const authored = () => ({ set: kit().set, judgments: kit().judgments, roles: kit().roles });
const now = (): FrozenHashes => currentHashes(root, authored(), base.corpusHash);

describe("frozen configuration", () => {
  it("passes when nothing changed", () => {
    expect(() => assertFrozen(frozenConfig(now()), now())).not.toThrow();
    expect(diffHashes(now(), now())).toEqual([]);
  });

  it("REFUSES the held-out split when ANY frozen value differs, naming the value", () => {
    const frozen = frozenConfig(now());
    for (const field of Object.keys(frozen.hashes) as Array<keyof FrozenHashes>) {
      const changed = { ...now(), [field]: `${frozen.hashes[field]}-changed` };
      try {
        assertFrozen(frozen, changed);
        throw new Error(`no refusal when ${field} changed`);
      } catch (e) {
        expect(e, field).toBeInstanceOf(FrozenConfigMismatch);
        expect((e as FrozenConfigMismatch).differences.map((d) => d.field), field).toEqual([field]);
        expect((e as Error).message).toMatch(/refuses to run/);
      }
    }
  });

  it("freezes every production configuration the plan names, and the M3 detector", () => {
    const keys = Object.keys(now());
    for (const k of ["scenario_set_hash", "judgments_hash", "corpus_hash", "retrieval_config_hash_dev", "retrieval_config_hash_production", "ranking_config_hash", "bundle_schema_hash", "prompt_hash", "production_sources_hash", "m3_detector_config_hash"]) {
      expect(keys).toContain(k);
    }
    expect(now().m3_detector_config_hash).toBe("23188f021f80bd84113165469456f72165be682522243f908cbb715793d104ba");
  });

  it("refuses when there is no frozen configuration at all", () => {
    expect(() => assertFrozen(null, now())).toThrow(/frozen-config\.json/);
  });

  it("the committed frozen-config.json equals the code and data being evaluated (production has not been touched since the freeze)", () => {
    const frozen = loadFrozen(root);
    expect(frozen).not.toBeNull();
    expect(diffHashes(frozen!.hashes, now())).toEqual([]);
  });
});

describe("the production-sources hash", () => {
  const tmpRoot = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "m46-src-"));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    return dir;
  };
  const baseFiles = (): Record<string, string> => ({
    "src/evidence/retrieval/a.ts": "export const a = 1;\n",
    "src/evidence/ranking/b.ts": "export const b = 2;\n",
    "src/evidence/bundle/c.ts": "export const c = 3;\n",
    "src/evidence/llm/d.ts": "export const d = 4;\n",
    "src/evidence/vocab.ts": "export const v = 5;\n",
    "src/evidence/hash.ts": "export const h = 6;\n",
  });

  it("changes when any production source changes, and ignores tests and line endings", () => {
    const dirs: string[] = [];
    try {
      const a = tmpRoot(baseFiles());
      dirs.push(a);
      const h = productionSourcesHash(a);
      for (const rel of Object.keys(baseFiles())) {
        const files = baseFiles();
        files[rel] += "// edit\n";
        const d = tmpRoot(files);
        dirs.push(d);
        expect(productionSourcesHash(d), rel).not.toBe(h);
      }
      const withTest = tmpRoot({ ...baseFiles(), "src/evidence/retrieval/a.test.ts": "it('x')\n" });
      dirs.push(withTest);
      expect(productionSourcesHash(withTest)).toBe(h);
      const crlf = tmpRoot(Object.fromEntries(Object.entries(baseFiles()).map(([k, v]) => [k, v.replace(/\n/g, "\r\n")])));
      dirs.push(crlf);
      expect(productionSourcesHash(crlf)).toBe(h);
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    }
  });

  it("covers the real production directories, and the harness code is hashed separately (a harness fix is not a production change)", () => {
    expect(productionSourcesHash(root)).toMatch(/^[0-9a-f]{64}$/);
    expect(evaluationCodeHash(root)).toMatch(/^[0-9a-f]{64}$/);
    expect(evaluationCodeHash(root)).not.toBe(productionSourcesHash(root));
  });
});

describe("manifest", () => {
  it("records every hash, the provider, the prompt, the judge status and the pending human evaluation, and no timestamp", async () => {
    const adv = summariseAdversarial([]);
    const judge = await validateJudge(new LexicalBaselineJudge(), []);
    const m = buildManifest({
      hashes: now(), frozenMatches: true, set: kit().set, judgmentRows: kit().judgments.rows.length, evaluationCodeHash: "e".repeat(64), artifacts: { "x.json": { hash: "1".repeat(64), kind: "json" } },
      judge, invariants: checkInvariants({ results: [], adversarial: null }), adversarial: adv, determinism: { rerun_identical: true, compared: ["a"] }, provider: { id: "mock", model: "mock-1" },
    });
    expect(m.hashes.corpus_hash).toBe(base.corpusHash);
    expect(m.hashes.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(m.scenario_set).toMatchObject({ total: 64, m3_derived: 40, edge_cases: 24 });
    expect(m.scenario_set.dev + m.scenario_set.test).toBe(64);
    expect(m.judgments).toMatchObject({ label: "synthetic_reference_judgment", expert_judgments: false });
    expect(m.generation).toMatchObject({ provider: "mock", model: "mock-1", live_provider_run: false });
    expect(m.judge.status).toBe("not_validated");
    expect(m.human_evaluation.status).toBe("pending");
    expect(m.human_evaluation.items).toContain("hindi_odia_quality");
    expect(m.limitations.length).toBeGreaterThanOrEqual(4);
    expect(m.evaluation_code.version).toBe("m4-eval/1.0.0");
    expect(JSON.stringify(m)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
  });
});
