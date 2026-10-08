// Public surface of the M4.5 grounded-generation layer. The only directory that may name a model provider.
export { createProvider, resolveLlmConfig } from "./config";
export type { EnvLike, LlmChoice, ProviderDeps } from "./config";
export { generateExplanation, MAX_ATTEMPTS } from "./generate";
export type { AttemptRecord, GenerateInput, GenerateOptions, GenerationMetrics, GenerationResult, GenerationStatus, ValidatedExplanation } from "./generate";
export { GeminiProvider, buildGeminiBody, parseGeminiAnswer } from "./gemini";
export { MockProvider, MOCK_SCENARIOS, readPrompt } from "./mock";
export type { MockOptions, MockScenario } from "./mock";
export { explainSignal } from "./pipeline";
export { buildPrompt, GENERATION_PARAMS, PROMPT_HASH, PROMPT_VERSION } from "./prompt";
export { explainStoredBundle, loadBundleForGeneration, revalidateStoredExplanation, selectExplanation } from "./persist";
export type { ExplainOutcome, RevalidationReport } from "./persist";
export { parseModelOutput, OUTPUT_JSON_SCHEMA } from "./schema";
export { scanAnchor, scanModelText } from "./forbidden";
export { checkSupport } from "./support";
export { validateOutput } from "./validate";
export { ProviderError, FAILURE_CATEGORIES } from "./types";
export type { FailureCategory, LlmProvider, LlmRequest, LlmResponse } from "./types";
