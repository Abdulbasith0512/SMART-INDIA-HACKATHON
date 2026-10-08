// OPT-IN live smoke test of the Gemini adapter (explicitly invoked: it is not part of `npm test`).
//   npm run smoke:gemini
// Needs LLM_PROVIDER=gemini, GEMINI_API_KEY and LLM_MODEL in .env.local (or the environment). If any is missing it prints
// SKIPPED and exits 0 - a skip is not a failure. It sends only the committed SYNTHETIC reference bundle (no database, no
// personal data), prints the provider/model that answered, and exits non-zero only if the provider could not be reached
// (which means the adapter and the live API disagree). It makes no claim about the model's quality.
import { referenceBundle } from "../src/evidence/bundle/testkit";
import { createProvider, resolveLlmConfig } from "../src/evidence/llm/config";
import { generateExplanation } from "../src/evidence/llm/generate";
import { passagesFor, resolver } from "../src/evidence/llm/testkit";
import { loadEnvFile } from "./lib/evidence-cli";

loadEnvFile();
const choice = resolveLlmConfig(process.env);
if (choice.kind !== "gemini") {
  console.log(`SKIPPED: ${choice.kind === "none" ? choice.reason : "LLM_PROVIDER is not gemini (set LLM_PROVIDER=gemini, GEMINI_API_KEY and LLM_MODEL to run the live smoke test)"}`);
  process.exit(0);
}
const provider = createProvider(choice)!;
const bundle = referenceBundle();
const result = await generateExplanation({ bundle, passages: passagesFor(bundle), provider, resolveMetadata: resolver });
console.log(JSON.stringify({
  provider: result.provider, model: result.model, model_version: result.model_version, json_mode: choice.jsonMode, status: result.status, attempts: result.attempts.length,
  provider_errors: result.attempts.map((a) => a.provider_error?.kind ?? null), failure_categories: result.metrics.failure_categories,
  validated_claims: result.metrics.validated_claim_count, rejected_claims: result.metrics.rejected_claim_count, usage: result.attempts.map((a) => a.usage),
}, null, 2));
const unreachable = result.attempts.some((a) => a.provider_error);
if (unreachable) console.error("The provider could not be used. If the error is bad_request, try LLM_JSON_MODE=format or LLM_JSON_MODE=none (see docs/M4-5-GENERATION.md).");
process.exit(unreachable ? 1 : 0);
