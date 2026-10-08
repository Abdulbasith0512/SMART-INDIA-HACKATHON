// @vitest-environment node
// OPT-IN live smoke test of the Gemini adapter. It NEVER runs in normal CI or in `npm test`: it needs all of
//   RUN_LIVE_GEMINI=1   (set explicitly in the process environment - a key found in .env.local alone does not trigger it)
//   GEMINI_API_KEY      and   LLM_MODEL
// and otherwise it is reported as SKIPPED, not failed. It sends only the committed SYNTHETIC reference bundle's passages and
// signal facts (no personal data, no database rows), records which provider and model answered, and checks that the answer
// reached the pipeline and was either validated or safely refused. It asserts nothing about the model's quality.
import { describe, expect, it } from "vitest";
import { referenceBundle } from "../bundle/testkit";
import { createProvider, resolveLlmConfig } from "./config";
import { generateExplanation } from "./generate";
import { passagesFor, resolver } from "./testkit";

const env = process.env;
const enabled = env.RUN_LIVE_GEMINI === "1" && !!env.GEMINI_API_KEY && !!env.LLM_MODEL;

describe.skipIf(!enabled)("live Gemini smoke test (opt-in)", () => {
  it("answers the synthetic reference bundle through the real adapter, and the pipeline either validates or safely refuses it", async () => {
    const choice = resolveLlmConfig({ ...env, LLM_PROVIDER: "gemini" });
    expect(choice.kind).toBe("gemini");
    const sent: string[] = [];
    const provider = createProvider(choice, {
      fetchImpl: async (input, init) => {
        sent.push(String(init?.body));
        return fetch(input, init);
      },
    })!;
    const bundle = referenceBundle();
    const result = await generateExplanation({ bundle, passages: passagesFor(bundle), provider, resolveMetadata: resolver });

    // privacy: what left the machine is the synthetic facts and passages only
    expect(sent.length).toBeGreaterThan(0);
    for (const body of sent) {
      expect(body).not.toMatch(/service_role|SUPABASE|patient|observed_value|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
      expect(body).not.toContain(env.GEMINI_API_KEY!);
    }
    // provenance
    expect(result.provider).toBe("gemini");
    expect(result.model).toBe(env.LLM_MODEL!.replace(/^models\//, ""));
    console.info(`[live smoke] provider=${result.provider} model=${result.model} model_version=${result.model_version} status=${result.status} attempts=${result.attempts.length} categories=${JSON.stringify(result.metrics.failure_categories)}`);
    // the provider must have been reachable: a request error here means the adapter and the API disagree (try LLM_JSON_MODE=format|none)
    expect(result.attempts.map((a) => a.provider_error)).toEqual(result.attempts.map(() => null));
    expect(["validated", "rejected"]).toContain(result.status);
    expect(result.fallback.fallback.status).toBe("fallback_extractive");
    if (result.status === "validated") expect(result.explanation!.text.startsWith("Evidence relevant to this emerging signal suggests…")).toBe(true);
  }, 180_000);
});

describe("the live smoke test is opt-in", () => {
  it("is skipped unless explicitly enabled with a key and a model", () => {
    expect(enabled).toBe(env.RUN_LIVE_GEMINI === "1" && !!env.GEMINI_API_KEY && !!env.LLM_MODEL);
    if (!enabled) console.info("[live smoke] skipped: set RUN_LIVE_GEMINI=1, GEMINI_API_KEY and LLM_MODEL to run it");
  });
});
