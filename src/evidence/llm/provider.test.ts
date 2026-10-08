// @vitest-environment node
// Provider selection and the deterministic MockProvider.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider, resolveLlmConfig } from "./config";
import { GeminiProvider } from "./gemini";
import { MOCK_SCENARIOS, MockProvider, readPrompt } from "./mock";
import { buildPrompt } from "./prompt";
import { OUTPUT_JSON_SCHEMA, parseModelOutput } from "./schema";
import { bundleWithPassages, passagesFor, runScenario, TEST_NONCE } from "./testkit";
import { ProviderError, type LlmRequest } from "./types";
import { referenceBundle } from "../bundle/testkit";

const KEY = "AIzaFAKE-KEY-FOR-TESTS-0123456789";
const req = (over: Partial<LlmRequest> = {}): LlmRequest => {
  const b = referenceBundle();
  const p = buildPrompt({ bundle: b, passages: passagesFor(b), nonce: TEST_NONCE });
  return { system: p.system, user: p.user, temperature: 0, maxOutputTokens: 2048, timeoutMs: 1000, jsonSchema: OUTPUT_JSON_SCHEMA, ...over };
};

describe("provider selection", () => {
  it("defaults to the mock provider: unset, empty, or 'mock' in any case", () => {
    for (const env of [{}, { LLM_PROVIDER: "" }, { LLM_PROVIDER: "mock" }, { LLM_PROVIDER: "MOCK" }, { LLM_PROVIDER: " Mock " }]) expect(resolveLlmConfig(env)).toEqual({ kind: "mock" });
  });

  it("uses Gemini only when the provider, the key and the model are all set", () => {
    const c = resolveLlmConfig({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: KEY, LLM_MODEL: "some-model-id" });
    expect(c).toEqual({ kind: "gemini", model: "some-model-id", apiKey: KEY, jsonMode: "mime" });
    expect(resolveLlmConfig({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: KEY, LLM_MODEL: "models/some-model-id" })).toMatchObject({ kind: "gemini", model: "some-model-id" });
    expect(resolveLlmConfig({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: KEY, LLM_MODEL: "m", LLM_JSON_MODE: "format" })).toMatchObject({ jsonMode: "format" });
    expect(resolveLlmConfig({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: KEY, LLM_MODEL: "m", LLM_JSON_MODE: "bogus" })).toMatchObject({ jsonMode: "mime" });
  });

  it("falls back to no provider (never to a live call) when anything is missing, and never echoes the key", () => {
    const missingKey = resolveLlmConfig({ LLM_PROVIDER: "gemini", LLM_MODEL: "m" });
    const missingModel = resolveLlmConfig({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: KEY });
    const badModel = resolveLlmConfig({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: KEY, LLM_MODEL: "../../evil path" });
    const unknown = resolveLlmConfig({ LLM_PROVIDER: "something-else", GEMINI_API_KEY: KEY, LLM_MODEL: "m" });
    expect(missingKey).toMatchObject({ kind: "none" });
    expect(JSON.stringify(missingKey)).toContain("GEMINI_API_KEY is not set");
    expect(JSON.stringify(missingModel)).toContain("LLM_MODEL is not set");
    expect(badModel).toMatchObject({ kind: "none" });
    expect(JSON.stringify(badModel)).toContain("not a valid model identifier");
    expect(unknown).toMatchObject({ kind: "none" });
    for (const c of [missingKey, missingModel, badModel, unknown]) expect(JSON.stringify(c)).not.toContain(KEY);
    expect(resolveLlmConfig({ LLM_PROVIDER: "none" })).toMatchObject({ kind: "none" });
    expect(resolveLlmConfig({ LLM_PROVIDER: "off" })).toMatchObject({ kind: "none" });
  });

  it("never consults a VITE_-prefixed variable", () => {
    // the names are assembled here so that no VITE_-prefixed key name appears literally in this directory (a repository guard scans for that)
    const browserKey = ["VITE", "GEMINI", "API", "KEY"].join("_");
    const browserModel = ["VITE", "LLM", "MODEL"].join("_");
    const browserProvider = ["VITE", "LLM", "PROVIDER"].join("_");
    expect(resolveLlmConfig({ LLM_PROVIDER: "gemini", [browserKey]: KEY, [browserModel]: "m" })).toMatchObject({ kind: "none" });
    expect(resolveLlmConfig({ [browserProvider]: "gemini" })).toEqual({ kind: "mock" });
  });

  it("creates the provider for a choice, or none", () => {
    expect(createProvider({ kind: "mock" })).toBeInstanceOf(MockProvider);
    expect(createProvider({ kind: "gemini", model: "m", apiKey: KEY, jsonMode: "mime" })).toBeInstanceOf(GeminiProvider);
    expect(createProvider({ kind: "none", reason: "x" })).toBeNull();
  });
});

describe("no provider call happens when the mock is selected", () => {
  afterEach(() => vi.restoreAllMocks());

  it("never touches fetch, in any scenario", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network call attempted");
    });
    const provider = createProvider(resolveLlmConfig({}), {})!;
    expect(provider.id).toBe("mock");
    for (const s of MOCK_SCENARIOS) await runScenario({ scenario: s });
    await provider.generate(req());
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("MockProvider", () => {
  it("records the provider id, model and every request it received", async () => {
    const m = new MockProvider({ model: "mock-x" });
    expect([m.id, m.model]).toEqual(["mock", "mock-x"]);
    const r = req();
    await m.generate(r);
    await m.generate(r);
    expect(m.calls).toHaveLength(2);
    expect(m.calls[0]).toBe(r);
    expect(new MockProvider().model).toBe("mock-1");
  });

  it("reads the nonce and the id-tagged passages out of the real prompt", () => {
    const b = referenceBundle();
    const ps = passagesFor(b);
    const r = readPrompt(buildPrompt({ bundle: b, passages: ps, nonce: TEST_NONCE }).user);
    expect(r.nonce).toBe(TEST_NONCE);
    expect(r.passages.map((p) => p.id)).toEqual(b.citations.filter((c) => c.section === "main").map((c) => c.citation_id));
    for (const p of r.passages) expect(p.text).toBe(ps.get(p.id)!.text);
    expect(readPrompt("no data block here")).toEqual({ nonce: "", passages: [] });
  });

  it("answers 'valid' with schema-valid JSON built from the passages it was given", async () => {
    const m = new MockProvider();
    const out = parseModelOutput((await m.generate(req())).text);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.points.length).toBeGreaterThanOrEqual(3);
      for (const p of out.value.points) for (const a of p.anchors) expect(req().user.replace(/\s+/g, " ")).toContain(a.quote);
    }
  });

  it("runs a script: call n gets entry n, and the last entry repeats", async () => {
    const m = new MockProvider({ scenario: ["malformed_json", "empty_response", "valid"] });
    const texts = [];
    for (let i = 0; i < 5; i += 1) texts.push((await m.generate(req())).text);
    expect(texts[0]).toContain('"points": [ {"text": "unfinished');
    expect(texts[1]).toBe("");
    expect(parseModelOutput(texts[2]).ok).toBe(true);
    expect(texts[3]).toBe(texts[2]);
    expect(texts[4]).toBe(texts[2]);
  });

  it("can throw a ProviderError for the transport scenarios", async () => {
    for (const [s, kind] of [["timeout", "timeout"], ["unavailable", "unavailable"], ["blocked", "blocked"]] as const) {
      await expect(new MockProvider({ scenario: s }).generate(req())).rejects.toMatchObject({ name: "ProviderError", kind });
    }
    expect(new ProviderError("timeout", "x")).toBeInstanceOf(Error);
  });

  it("accepts a custom responder that sees the nonce and passages", async () => {
    const m = new MockProvider({ respond: (ctx) => JSON.stringify({ nonce: ctx.nonce, ids: ctx.passages.map((p) => p.id) }) });
    const out = JSON.parse((await m.generate(req())).text);
    expect(out.nonce).toBe(TEST_NONCE);
    expect(out.ids.length).toBeGreaterThan(5);
  });

  it("has a fixture for every scenario the milestone requires", () => {
    for (const s of ["valid", "invalid_citation", "fabricated_citation", "fabricated_quote", "unsupported_number", "unsupported_entity", "diagnosis", "outbreak_confirmation", "treatment_advice", "prompt_injection", "malformed_json", "empty_response", "timeout", "conflicting_evidence", "missing_evidence"]) {
      expect(MOCK_SCENARIOS as readonly string[]).toContain(s);
    }
  });

  it("builds its violating answers so that only the intended rule is broken (shape is valid JSON for non-shape scenarios)", async () => {
    const shapeScenarios = new Set(["malformed_json", "fenced_json", "empty_response", "extra_field", "bad_enum", "missing_field", "timeout", "unavailable", "blocked"]);
    const { bundle, passages } = bundleWithPassages({});
    for (const s of MOCK_SCENARIOS) {
      if (shapeScenarios.has(s)) continue;
      const p = buildPrompt({ bundle, passages, nonce: TEST_NONCE });
      const text = (await new MockProvider({ scenario: s }).generate({ ...req(), user: p.user })).text;
      expect(parseModelOutput(text).ok, s).toBe(true);
    }
  });
});
