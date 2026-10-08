// Gemini adapter (raw REST, no SDK). The only file in the repository that knows the provider's endpoint.
//
// Contract used (Google AI for Developers, `models.generateContent`, checked against the official reference and guides at
// implementation time; see docs/M4-5-GENERATION.md for the sources and the points on which the pages disagree):
//
//   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
//   header  x-goog-api-key: <key>            (the key is NEVER placed in the URL, and never in a log or error text)
//   body    { systemInstruction: { parts: [{ text }] },
//             contents: [{ role: "user", parts: [{ text }] }],
//             generationConfig: { temperature, maxOutputTokens, candidateCount: 1, ...jsonMode } }
//   answer  { candidates: [{ content: { parts: [{ text }] }, finishReason }], promptFeedback: { blockReason },
//             usageMetadata: { promptTokenCount, candidatesTokenCount }, modelVersion }
//
// There are no `tools`, no function calling, no code execution, no grounding and no browsing: none is requested, and any
// non-text part in an answer is ignored. The request carries only what the prompt builder produced.
import { ProviderError, type LlmProvider, type LlmRequest, type LlmResponse } from "./types";

export const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";

/**
 * How JSON-only output is requested. The official pages differ: the REST reference lists `generationConfig.responseMimeType`
 * ("mime", the default); the structured-output guide shows `generationConfig.responseFormat.text` ("format"). "none" sends no
 * format hint and relies on the prompt alone. Whatever the provider returns is validated the same way.
 */
export type GeminiJsonMode = "mime" | "format" | "none";

export interface GeminiOptions {
  apiKey: string;
  model: string;
  jsonMode?: GeminiJsonMode;
  fetchImpl?: typeof fetch;
}

export function buildGeminiBody(request: LlmRequest, jsonMode: GeminiJsonMode): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = { temperature: request.temperature, maxOutputTokens: request.maxOutputTokens, candidateCount: 1 };
  if (jsonMode === "mime") generationConfig.responseMimeType = "application/json";
  if (jsonMode === "format") generationConfig.responseFormat = { text: { mimeType: "application/json", schema: request.jsonSchema } };
  return {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: [{ role: "user", parts: [{ text: request.user }] }],
    generationConfig,
  };
}

interface GeminiAnswer {
  candidates?: Array<{ content?: { parts?: Array<{ text?: unknown; thought?: unknown }> }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseGeminiAnswer(json: GeminiAnswer): LlmResponse {
  const cand = json.candidates?.[0];
  if (!cand) throw new ProviderError("blocked", `no candidate returned (${json.promptFeedback?.blockReason ?? "no reason given"})`);
  const text = (cand.content?.parts ?? []).filter((p) => typeof p.text === "string" && p.thought !== true).map((p) => p.text as string).join("");
  const finish = cand.finishReason ?? null;
  if (!text && finish && finish !== "STOP" && finish !== "MAX_TOKENS") throw new ProviderError("blocked", `no text returned (finishReason ${finish})`);
  const u = json.usageMetadata;
  return {
    text,
    modelVersion: typeof json.modelVersion === "string" ? json.modelVersion : null,
    finishReason: finish,
    usage: u ? { inputTokens: num(u.promptTokenCount), outputTokens: num(u.candidatesTokenCount) } : null,
  };
}

export class GeminiProvider implements LlmProvider {
  readonly id = "gemini";
  readonly model: string;
  private readonly apiKey: string;
  private readonly jsonMode: GeminiJsonMode;
  private readonly fetchImpl: typeof fetch;

  constructor(o: GeminiOptions) {
    if (!o.apiKey) throw new ProviderError("not_configured", "GEMINI_API_KEY is not set");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(o.model)) throw new ProviderError("not_configured", "LLM_MODEL is not a valid model identifier");
    this.apiKey = o.apiKey;
    this.model = o.model;
    this.jsonMode = o.jsonMode ?? "mime";
    this.fetchImpl = o.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private redact(s: string): string {
    return s.split(this.apiKey).join("[redacted]").slice(0, 300);
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${GEMINI_ENDPOINT}/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(buildGeminiBody(request, this.jsonMode)),
        signal: controller.signal,
      });
    } catch (e) {
      if ((e as { name?: string }).name === "AbortError") throw new ProviderError("timeout", `no answer within ${request.timeoutMs} ms`);
      throw new ProviderError("unavailable", this.redact(`request failed: ${(e as Error).message}`));
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { error?: { status?: string; message?: string } };
        detail = ` ${body.error?.status ?? ""} ${body.error?.message ?? ""}`.trimEnd();
      } catch {
        /* the error body is optional */
      }
      const kind = res.status === 429 ? "rate_limited" : res.status === 401 || res.status === 403 ? "unauthorized" : res.status >= 500 ? "unavailable" : "bad_request";
      throw new ProviderError(kind, this.redact(`HTTP ${res.status}${detail}`));
    }
    let json: GeminiAnswer;
    try {
      json = (await res.json()) as GeminiAnswer;
    } catch {
      throw new ProviderError("unavailable", "the answer was not JSON");
    }
    return parseGeminiAnswer(json);
  }
}
