// @vitest-environment node
// The whole flow with the MockProvider: prompt -> provider -> parse -> validators -> one retry -> fallback.
import { describe, expect, it } from "vitest";
import { FALLBACK_OPENING, validateFallback } from "../bundle/fallback";
import { referenceBundle } from "../bundle/testkit";
import { viewFromPrepared } from "../retrieval/testkit";
import { generateExplanation, MAX_ATTEMPTS } from "./generate";
import { MockProvider, MOCK_SCENARIOS, type MockScenario } from "./mock";
import { PROMPT_HASH, PROMPT_VERSION } from "./prompt";
import { passagesFor, resolver, runScenario, TEST_NONCE } from "./testkit";
import { ProviderError, type FailureCategory, type LlmProvider } from "./types";

const bundle = referenceBundle();
const passages = passagesFor(bundle);
const categoriesOf = (r: Awaited<ReturnType<typeof runScenario>>): FailureCategory[] => [...new Set(r.attempts.flatMap((a) => Object.keys(a.categories) as FailureCategory[]))];

describe("the fifteen required fixtures", () => {
  const REQUIRED: Array<[string, MockScenario, "validated" | "rejected" | "unavailable", FailureCategory | null]> = [
    ["1 valid grounded response", "valid", "validated", null],
    ["2 invalid citation", "invalid_citation", "rejected", "citation_unknown"],
    ["3 fabricated citation", "fabricated_citation", "rejected", "fabricated_citation"],
    ["4 fabricated quote", "fabricated_quote", "rejected", "anchor_not_verbatim"],
    ["5 unsupported number", "unsupported_number", "rejected", "unsupported_number"],
    ["6 unsupported named entity", "unsupported_entity", "rejected", "unsupported_entity"],
    ["7 diagnosis wording", "diagnosis", "rejected", "forbidden_diagnosis"],
    ["8 outbreak-confirmation wording", "outbreak_confirmation", "rejected", "forbidden_outbreak_confirmation"],
    ["9 treatment advice", "treatment_advice", "rejected", "forbidden_treatment_advice"],
    ["11 malformed JSON", "malformed_json", "rejected", "malformed_json"],
    ["12 empty response", "empty_response", "rejected", "empty_response"],
    ["13 timeout", "timeout", "unavailable", "provider_error"],
    ["14 conflicting evidence", "conflicting_evidence", "validated", null],
    ["15 missing evidence", "missing_evidence", "validated", null],
  ];
  it.each(REQUIRED)("%s", async (_name, scenario, status, category) => {
    const r = await runScenario({ scenario });
    expect(r.status).toBe(status);
    if (category) expect(categoriesOf(r)).toContain(category);
    expect(r.metrics.fallback_used).toBe(status !== "validated");
    expect(r.explanation !== null).toBe(status === "validated");
  });
});

describe("every violating scenario is refused by the pipeline, not by the prompt", () => {
  const MUST_PASS = new Set<MockScenario>(["valid", "conflicting_evidence", "missing_evidence", "mixed_one_bad", "prompt_injection" /* no injected passage here: see injection.test.ts */]);
  const TRANSPORT = new Set<MockScenario>(["timeout", "unavailable", "blocked"]);
  it.each(MOCK_SCENARIOS.filter((s) => !MUST_PASS.has(s)))("%s never produces a validated explanation", async (scenario) => {
    const r = await runScenario({ scenario });
    expect(r.explanation, scenario).toBeNull();
    expect(r.status).toBe(TRANSPORT.has(scenario) ? "unavailable" : "rejected");
    expect(r.metrics.fallback_used).toBe(true);
  });

  it("with the deterministic fallback always available and valid", async () => {
    for (const scenario of MOCK_SCENARIOS) {
      const r = await runScenario({ scenario });
      expect(r.fallback.fallback.status, scenario).toBe("fallback_extractive");
      expect(r.fallback.fallback.text.startsWith(`${FALLBACK_OPENING}\n`)).toBe(true);
      expect(validateFallback(bundle, r.fallback).every((c) => c.ok), scenario).toBe(true);
    }
  });
});

describe("retry exactly once, with a corrective instruction, then fall back", () => {
  it("makes a second attempt after a refused answer, naming only fixed categories, and accepts a good second answer", async () => {
    const provider = new MockProvider({ scenario: ["unsupported_number", "valid"] });
    const r = await runScenario(provider);
    expect(r.status).toBe("validated");
    expect(r.attempts.map((a) => a.outcome)).toEqual(["rejected", "accepted"]);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0].user).not.toContain("CORRECTION");
    expect(provider.calls[1].user).toContain("CORRECTION");
    expect(provider.calls[1].user).toContain("unsupported_number");
    expect(provider.calls[1].user).not.toContain("87"); // the offending model text is never echoed back
    expect(r.metrics.attempts).toBe(2);
    expect(r.metrics.fallback_used).toBe(false);
  });

  it("retries after malformed JSON and after an empty answer", async () => {
    for (const first of ["malformed_json", "empty_response", "fenced_json", "extra_field"] as const) {
      const r = await runScenario(new MockProvider({ scenario: [first, "valid"] }));
      expect(r.status, first).toBe("validated");
      expect(r.attempts).toHaveLength(2);
    }
  });

  it("retries once after a timeout or outage, with no corrective message (nothing was wrong with the answer)", async () => {
    const provider = new MockProvider({ scenario: ["timeout", "valid"] });
    const r = await runScenario(provider);
    expect(r.status).toBe("validated");
    expect(r.attempts.map((a) => a.outcome)).toEqual(["provider_error", "accepted"]);
    expect(provider.calls[1].user).not.toContain("CORRECTION");
  });

  it("never makes a third attempt, however bad the answers are", async () => {
    expect(MAX_ATTEMPTS).toBe(2);
    for (const scenario of ["diagnosis", "malformed_json", "timeout", "unavailable"] as const) {
      const provider = new MockProvider({ scenario });
      const r = await runScenario(provider);
      expect(provider.calls, scenario).toHaveLength(2);
      expect(r.attempts, scenario).toHaveLength(2);
    }
  });

  it("does not retry a blocked or unauthorised request", async () => {
    for (const kind of ["blocked", "unauthorized", "bad_request", "not_configured"] as const) {
      const calls: number[] = [];
      const provider: LlmProvider = { id: "x", model: "y", generate: async () => { calls.push(1); throw new ProviderError(kind, "no"); } };
      const r = await runScenario(provider);
      expect(calls, kind).toHaveLength(1);
      expect(r.status).toBe("unavailable");
    }
  });

  it("falls back after two refused answers, and reports 'rejected' (the model did answer)", async () => {
    const r = await runScenario(new MockProvider({ scenario: ["diagnosis", "outbreak_confirmation"] }));
    expect(r.status).toBe("rejected");
    expect(r.explanation).toBeNull();
    expect(r.fallback.fallback.status).toBe("fallback_extractive");
    expect(r.attempts.map((a) => a.rejection)).toEqual(expect.arrayContaining(["no_valid_points"]));
  });

  it("reports 'unavailable' when no answer was ever obtained, and 'rejected' when one answer arrived before an outage", async () => {
    expect((await runScenario(new MockProvider({ scenario: ["timeout", "timeout"] }))).status).toBe("unavailable");
    expect((await runScenario(new MockProvider({ scenario: ["diagnosis", "timeout"] }))).status).toBe("rejected");
  });

  it("guards against a provider that never answers", async () => {
    const hang: LlmProvider = { id: "slow", model: "m", generate: () => new Promise(() => undefined) };
    const r = await runScenario(hang, { options: { timeoutMs: 20 } });
    expect(r.status).toBe("unavailable");
    expect(r.attempts.map((a) => a.provider_error?.kind)).toEqual(["timeout", "timeout"]);
  });

  it("treats an unexpected provider exception as an outage, not a crash", async () => {
    const boom: LlmProvider = { id: "boom", model: "m", generate: async () => { throw new Error("socket exploded"); } };
    const r = await runScenario(boom);
    expect(r.status).toBe("unavailable");
    expect(r.attempts[0].provider_error).toEqual({ kind: "unavailable" });
  });
});

describe("no provider, empty evidence, thin evidence", () => {
  it("uses the fallback and makes no call when no provider is configured", async () => {
    const r = await runScenario(null);
    expect(r.status).toBe("unavailable");
    expect(r.skipped_reason).toMatch(/no provider/);
    expect(r.attempts).toEqual([]);
    expect(r.fallback.fallback.points.length).toBeGreaterThan(0);
    expect(r.input_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not ask a model about an empty bundle", async () => {
    const empty = referenceBundle({ view: { items: [], activeSnapshot: null }, historicalView: null });
    const provider = new MockProvider();
    const r = await runScenario(provider, { bundle: empty, passages: new Map() });
    expect(r.status).toBe("skipped");
    expect(r.skipped_reason).toBe("the bundle holds no current evidence to summarise"); // the empty-bundle guard, not the later "no passage can be sent" guard
    expect(provider.calls).toHaveLength(0);
    expect(r.fallback.fallback.text).toContain("No eligible evidence was selected for this signal, so there is nothing to quote.");
    expect(r.metrics.fallback_used).toBe(true);
  });

  it("generates for thin evidence and says it is thin", async () => {
    const thin = referenceBundle({ view: { ...viewFromPrepared(), items: viewFromPrepared().items.filter((i) => i.canonicalId === "syn-ads-case-definition") }, historicalView: null });
    const r = await runScenario(new MockProvider(), { bundle: thin, passages: passagesFor(thin) });
    expect(r.status).toBe("validated");
    expect(r.explanation!.thin).toBe(true);
  });

  it("skips (rather than send a huge prompt) when the input exceeds the limits", async () => {
    const big = passagesFor(bundle, { E1: "x".repeat(70_000) });
    const provider = new MockProvider();
    const r = await runScenario(provider, { passages: big });
    expect(r.status).toBe("skipped");
    expect(provider.calls).toHaveLength(0);
  });
});

describe("what is recorded for evaluation (M4.6 hooks)", () => {
  it("counts claims, citations, validated, rejected and unsupported claims", async () => {
    const ok = await runScenario({ scenario: "valid" });
    expect(ok.metrics).toMatchObject({ claim_count: 4, validated_claim_count: 4, rejected_claim_count: 0, unsupported_claim_count: 0, forbidden_claim_count: 0, fallback_used: false, attempts: 1, provider: "mock", model: "mock-1", prompt_version: PROMPT_VERSION });
    expect(ok.metrics.citation_count).toBeGreaterThanOrEqual(3);
    expect(ok.metrics.input_hash).toBe(ok.input_hash);
    expect(ok.metrics.output_hash).toBe(ok.output_hash);

    const mixed = await runScenario({ scenario: "mixed_one_bad" });
    expect(mixed.metrics).toMatchObject({ claim_count: 4, validated_claim_count: 3, rejected_claim_count: 1, forbidden_claim_count: 1, fallback_used: false });
    expect(mixed.metrics.failure_categories).toMatchObject({ forbidden_outbreak_confirmation: 1 });

    const bad = await runScenario({ scenario: "unsupported_number" });
    expect(bad.metrics).toMatchObject({ validated_claim_count: 0, rejected_claim_count: 1, unsupported_claim_count: 1, fallback_used: true, attempts: 2 });
    expect(bad.metrics.failure_categories.unsupported_number).toBe(2); // once per attempt
    expect(bad.metrics.output_hash).toBeNull();
  });

  it("records provider, model, prompt version and hash, parameters, input hash and output hash", async () => {
    const r = await runScenario({ scenario: "valid" });
    expect(r).toMatchObject({ provider: "mock", model: "mock-1", model_version: "mock-model-1", prompt_version: PROMPT_VERSION, prompt_hash: PROMPT_HASH, params: { temperature: 0, max_output_tokens: 2048 } });
    expect(r.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.output_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.explanation).toMatchObject({ schema: "grounded-explanation/1", status: "validated", bundle_hash: bundle.bundle_hash, provider: "mock", model: "mock-1", prompt_hash: PROMPT_HASH });
  });

  it("keeps the raw answer and its hash per attempt (for the admin-only table), and a hash of the request", async () => {
    const r = await runScenario({ scenario: "diagnosis" });
    for (const a of r.attempts) {
      expect(a.raw).toContain("consistent with cholera");
      expect(a.raw_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.raw_length).toBe(a.raw!.length);
      expect(a.request_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(r.attempts[0].request_sha256).not.toBe(r.attempts[1].request_sha256); // the retry carries the corrective message
  });

  it("is reproducible: the same inputs and nonce give identical results", async () => {
    const run = () => runScenario({ scenario: "mixed_one_bad" }, { options: { now: () => 1 } });
    const a = JSON.stringify(await run());
    const b = JSON.stringify(await run());
    expect(a).toBe(b);
  });
});

describe("what the provider receives", () => {
  it("is the fixed-parameter request: temperature 0, bounded output, the JSON schema, the instruction layer apart from the data", async () => {
    const provider = new MockProvider();
    await runScenario(provider);
    const req = provider.calls[0];
    expect(req).toMatchObject({ temperature: 0, maxOutputTokens: 2048 });
    expect(req.jsonSchema).toHaveProperty("required");
    expect(req.system).toContain(TEST_NONCE);
    expect(req.user).toContain(`DATA_START ${TEST_NONCE}`);
    for (const p of passages.values()) expect(req.system.includes(p.text.slice(0, 50))).toBe(false);
  });

  it("is built fresh (a new nonce) for each attempt when none is fixed", async () => {
    const provider = new MockProvider({ scenario: ["diagnosis", "valid"] });
    await generateExplanation({ bundle, passages, provider, resolveMetadata: resolver });
    const nonces = provider.calls.map((c) => /DATA_START (\S+)/.exec(c.user)![1]);
    expect(nonces[0]).not.toBe(nonces[1]);
  });
});
