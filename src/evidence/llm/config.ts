// Provider selection. Pure: it is handed an environment-like object and never reads process.env itself, so no module in
// the browser build or elsewhere can pick up a key by accident, and tests control exactly what is visible.
//
//   LLM_PROVIDER unset or "mock"   MockProvider (the default for tests and CI; never reaches the network)
//   LLM_PROVIDER = "gemini"        live Gemini, ONLY if GEMINI_API_KEY and LLM_MODEL are both set; otherwise "none"
//   LLM_PROVIDER = "none"          no model: the deterministic extractive fallback is used
//
// Keys are server-side only. A `VITE_`-prefixed variable is never consulted (and the secret scan rejects one).
import { GeminiProvider, type GeminiJsonMode } from "./gemini";
import { MockProvider, type MockOptions } from "./mock";
import type { LlmProvider } from "./types";

export type LlmChoice =
  | { kind: "mock" }
  | { kind: "gemini"; model: string; apiKey: string; jsonMode: GeminiJsonMode }
  | { kind: "none"; reason: string };

export type EnvLike = Readonly<Record<string, string | undefined>>;

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function resolveLlmConfig(env: EnvLike): LlmChoice {
  const provider = (env.LLM_PROVIDER ?? "").trim().toLowerCase() || "mock";
  if (provider === "mock") return { kind: "mock" };
  if (provider === "none" || provider === "off") return { kind: "none", reason: "LLM_PROVIDER is none: the extractive fallback is used" };
  if (provider !== "gemini") return { kind: "none", reason: `unknown LLM_PROVIDER "${provider.slice(0, 20)}": the extractive fallback is used` };
  const apiKey = (env.GEMINI_API_KEY ?? "").trim();
  const model = (env.LLM_MODEL ?? "").trim().replace(/^models\//, "");
  if (!apiKey) return { kind: "none", reason: "LLM_PROVIDER=gemini but GEMINI_API_KEY is not set: the extractive fallback is used" };
  if (!model) return { kind: "none", reason: "LLM_PROVIDER=gemini but LLM_MODEL is not set: the extractive fallback is used" };
  if (!MODEL_ID.test(model)) return { kind: "none", reason: "LLM_MODEL is not a valid model identifier: the extractive fallback is used" };
  const mode = (env.LLM_JSON_MODE ?? "").trim().toLowerCase();
  return { kind: "gemini", model, apiKey, jsonMode: mode === "format" || mode === "none" ? mode : "mime" };
}

export interface ProviderDeps {
  fetchImpl?: typeof fetch;
  mock?: MockOptions;
}

/** The provider for a choice, or null when the choice is "none" (the caller then uses the deterministic fallback). */
export function createProvider(choice: LlmChoice, deps: ProviderDeps = {}): LlmProvider | null {
  if (choice.kind === "mock") return new MockProvider(deps.mock);
  if (choice.kind === "gemini") return new GeminiProvider({ apiKey: choice.apiKey, model: choice.model, jsonMode: choice.jsonMode, fetchImpl: deps.fetchImpl });
  return null;
}
