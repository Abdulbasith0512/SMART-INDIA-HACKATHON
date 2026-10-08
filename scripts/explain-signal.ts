// Grounded explanation for ONE stored signal's evidence bundle (service role). Dry run unless --persist is given.
//   npm run evidence:explain -- --signal=<signal_candidates.id> [--bundle-hash=<hash>] [--provider=mock|gemini|none]
//                               [--scenario=<mock scenario>] [--persist] [--json]
// The model is an evidence SUMMARISER: it sees only the signal facts and the bundle's passages, and its output is shown only
// if every deterministic check passes (cited ids, exact quotes, numbers, names, forbidden content); otherwise the M4.4
// extractive fallback is shown. Provider selection: --provider, else LLM_PROVIDER (default mock). A live Gemini call needs
// LLM_PROVIDER=gemini, GEMINI_API_KEY and LLM_MODEL in .env.local. Raw model output is never printed (administrators read it
// from the database). --persist stores the result in the M4.0 tables; running it again for the same inputs is a cache hit.
import { createProvider, resolveLlmConfig, type LlmChoice } from "../src/evidence/llm/config";
import { generateExplanation } from "../src/evidence/llm/generate";
import { MOCK_SCENARIOS, type MockScenario } from "../src/evidence/llm/mock";
import { explainStoredBundle, loadBundleForGeneration } from "../src/evidence/llm/persist";
import { loadStoredBundle } from "../src/evidence/bundle/persist";
import { supabaseEvidenceDb } from "./lib/evidence-db";
import { arg, flag, loadEnvFile, serviceClient } from "./lib/evidence-cli";

const signal = arg("signal");
if (!signal) {
  console.error("usage: npm run evidence:explain -- --signal=<id> [--bundle-hash=<hash>] [--provider=mock|gemini|none] [--scenario=<mock scenario>] [--persist] [--json]");
  process.exit(2);
}
loadEnvFile();
const db = supabaseEvidenceDb(serviceClient());

const requested = arg("provider");
const env = { ...process.env, ...(requested ? { LLM_PROVIDER: requested } : {}) };
const choice: LlmChoice = resolveLlmConfig(env);
const scenario = arg("scenario") as MockScenario | undefined;
if (scenario && !(MOCK_SCENARIOS as readonly string[]).includes(scenario)) {
  console.error(`unknown mock scenario "${scenario}"; one of: ${MOCK_SCENARIOS.join(", ")}`);
  process.exit(2);
}
const provider = createProvider(choice, { mock: scenario ? { scenario, model: `mock-${scenario}` } : undefined });
if (choice.kind === "none") console.error(`no model will be called: ${choice.reason}`);

const stored = await loadStoredBundle(db, signal, arg("bundle-hash"));
if (!stored) {
  console.error(`signal ${signal} has no stored evidence bundle (run: npm run evidence:bundle -- --signal=${signal} --persist)`);
  process.exit(1);
}

try {
  if (flag("persist")) {
    const out = await explainStoredBundle(db, stored.id, provider);
    console.log(`stored: status ${out.status}${out.cached ? " (served from the cache; no provider call)" : ""}; explanation row ${out.explanationId ?? "none (nothing to store)"}; provider calls ${out.providerCalls}`);
    if (out.generation) print(out.generation);
    else console.log("(cached result: re-run without --persist to see a fresh dry run)");
  } else {
    const loaded = await loadBundleForGeneration(db, stored.id);
    print(await generateExplanation({ bundle: loaded.bundle, passages: loaded.passages, provider, resolveMetadata: (id) => loaded.metadata.get(id) }));
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

function print(r: Awaited<ReturnType<typeof generateExplanation>>): void {
  if (flag("json")) {
    // the raw model answers are deliberately left out
    console.log(JSON.stringify({ ...r, attempts: r.attempts.map((a) => ({ ...a, raw: undefined })), fallback: { ...r.fallback.fallback } }, null, 2));
    return;
  }
  console.log(`\nstatus ${r.status}  provider ${r.provider ?? "-"}  model ${r.model ?? "-"}  prompt ${r.prompt_version} ${r.prompt_hash.slice(0, 12)}  input ${r.input_hash?.slice(0, 12) ?? "-"}  output ${r.output_hash?.slice(0, 12) ?? "-"}`);
  console.log(`metrics ${JSON.stringify({ ...r.metrics, failure_categories: undefined })}`);
  if (Object.keys(r.metrics.failure_categories).length) console.log(`failure categories ${JSON.stringify(r.metrics.failure_categories)}`);
  if (r.skipped_reason) console.log(`not generated: ${r.skipped_reason}`);
  console.log(r.explanation ? `\n${r.explanation.text}` : `\n--- no validated model explanation: showing the deterministic extractive fallback ---\n${r.fallback.fallback.text}`);
}
