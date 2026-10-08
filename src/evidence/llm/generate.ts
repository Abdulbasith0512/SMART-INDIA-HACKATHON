// The generation flow, as a pure function of (bundle, passages, provider):
//
//   prompt -> provider call -> strict JSON parse -> schema -> citations -> anchors -> numbers / names -> forbidden content
//
// If the answer is refused, ONE retry is made with a concise corrective instruction that names only fixed failure
// categories (never model text). If the second answer is refused too, or the provider is unavailable, the M4.4 deterministic
// extractive fallback is the result. There is never a third attempt. The fallback is always computed, so every outcome
// carries a safe thing to show.
import { FALLBACK_OPENING, renderExtractive, type MetadataResolver, type RenderedFallback } from "../bundle/fallback";
import type { EvidenceBundle } from "../bundle/types";
import { hashJson, sha256Hex } from "../hash";
import { buildPrompt, DEFAULT_TIMEOUT_MS, GENERATION_PARAMS, inputHashOf, PROMPT_HASH, PROMPT_VERSION, PromptError, selectPassages, type PreparedPrompt } from "./prompt";
import { checkRendered, renderExplanation, type RenderCheck } from "./render";
import { OUTPUT_JSON_SCHEMA, parseModelOutput } from "./schema";
import { ProviderError, type FailureCategory, type LlmProvider, type LlmRequest, type LlmResponse, type PassageMap } from "./types";
import { DEFAULT_POLICY, validateOutput, type DroppedItem, type KeptPoint, type ValidationOutcome, type ValidationPolicy } from "./validate";

export const EXPLANATION_SCHEMA = "grounded-explanation/1";
/** One initial attempt and exactly one retry. */
export const MAX_ATTEMPTS = 2;
const RETRYABLE_PROVIDER_ERRORS = new Set(["timeout", "unavailable", "rate_limited"]);

export interface ValidatedExplanation {
  schema: typeof EXPLANATION_SCHEMA;
  status: "validated";
  bundle_hash: string;
  prompt_version: string;
  prompt_hash: string;
  provider: string;
  model: string;
  model_version: string | null;
  opening: string;
  points: Array<{ index: number; text: string; kind: string; citations: string[]; anchors: Array<{ citation: string; quote: string }>; support: KeptPoint["support"] }>;
  uncertainties: string[];
  missing_evidence: string[];
  bundle_gaps: string[];
  thin: boolean;
  text: string;
}

export interface AttemptRecord {
  attempt: number;
  outcome: "accepted" | "rejected" | "provider_error";
  provider_error: { kind: string } | null;
  /** The raw model answer. Kept for the admin-only raw table; never copied into a report or an officer-readable field. */
  raw: string | null;
  raw_sha256: string | null;
  raw_length: number;
  request_sha256: string;
  finish_reason: string | null;
  model_version: string | null;
  usage: LlmResponse["usage"];
  parse: "ok" | "empty_response" | "malformed_json" | "schema_violation" | null;
  schema_issues: string[];
  rejection: FailureCategory | null;
  categories: Partial<Record<FailureCategory, number>>;
  counts: ValidationOutcome["counts"] | null;
  dropped: DroppedItem[];
  withheld: PreparedPrompt["withheld"];
  latency_ms: number | null;
}

export interface GenerationMetrics {
  claim_count: number;
  citation_count: number;
  validated_claim_count: number;
  rejected_claim_count: number;
  unsupported_claim_count: number;
  forbidden_claim_count: number;
  /** True when the explanation shown is the deterministic extractive fallback rather than a validated model answer. */
  fallback_used: boolean;
  attempts: number;
  failure_categories: Partial<Record<FailureCategory, number>>;
  provider: string | null;
  model: string | null;
  prompt_version: string;
  input_hash: string | null;
  output_hash: string | null;
}

/**
 * validated    a model answer passed every check
 * rejected     the model answered, but no answer passed (after the single retry)
 * unavailable  no model answer was obtained (no provider, timeout, outage, block)
 * skipped      nothing was sent: there is no evidence to summarise, or the input exceeds the limits
 */
export type GenerationStatus = "validated" | "rejected" | "unavailable" | "skipped";

export interface GenerationResult {
  status: GenerationStatus;
  provider: string | null;
  model: string | null;
  model_version: string | null;
  prompt_version: string;
  prompt_hash: string;
  input_hash: string | null;
  params: typeof GENERATION_PARAMS;
  attempts: AttemptRecord[];
  explanation: ValidatedExplanation | null;
  output_hash: string | null;
  /** Checks run on the rendered text of a validated explanation (all true, or the explanation would not exist). */
  render_checks: RenderCheck[] | null;
  /** Always present: what to show when there is no validated explanation. */
  fallback: RenderedFallback;
  metrics: GenerationMetrics;
  skipped_reason: string | null;
}

export interface GenerateOptions {
  nonce?: () => string;
  timeoutMs?: number;
  policy?: ValidationPolicy;
  now?: () => number;
}

export interface GenerateInput {
  bundle: EvidenceBundle;
  /** Passages resolved from the database by the bundle's stored ids. */
  passages: PassageMap;
  /** Null when no provider is configured: the result is then the fallback. */
  provider: LlmProvider | null;
  resolveMetadata: MetadataResolver;
  options?: GenerateOptions;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderError("timeout", `no answer within ${ms} ms`)), ms + 250);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const summarise = (cats: Partial<Record<FailureCategory, number>>, into: Partial<Record<FailureCategory, number>>): void => {
  for (const [k, v] of Object.entries(cats) as Array<[FailureCategory, number]>) into[k] = (into[k] ?? 0) + (v ?? 0);
};

export async function generateExplanation(input: GenerateInput): Promise<GenerationResult> {
  const { bundle, passages, provider, resolveMetadata } = input;
  const opts = input.options ?? {};
  const now = opts.now ?? (() => Date.now());
  const fallback = renderExtractive(bundle, resolveMetadata);
  const attempts: AttemptRecord[] = [];
  const allCategories: Partial<Record<FailureCategory, number>> = {};

  const finish = (status: GenerationStatus, extra: { explanation?: ValidatedExplanation; checks?: RenderCheck[]; skipped?: string; inputHash?: string | null } = {}): GenerationResult => {
    const last = [...attempts].reverse().find((a) => a.counts);
    const explanation = extra.explanation ?? null;
    const output_hash = explanation ? hashJson(explanation) : null;
    const counts = last?.counts;
    return {
      status,
      provider: provider?.id ?? null,
      model: provider?.model ?? null,
      model_version: [...attempts].reverse().find((a) => a.model_version)?.model_version ?? null,
      prompt_version: PROMPT_VERSION,
      prompt_hash: PROMPT_HASH,
      input_hash: extra.inputHash ?? null,
      params: GENERATION_PARAMS,
      attempts,
      explanation,
      output_hash,
      render_checks: extra.checks ?? null,
      fallback,
      skipped_reason: extra.skipped ?? null,
      metrics: {
        claim_count: counts?.points_total ?? 0,
        citation_count: explanation ? new Set(explanation.points.flatMap((p) => p.citations)).size : (counts?.citations_kept ?? 0),
        validated_claim_count: explanation ? explanation.points.length : 0,
        rejected_claim_count: counts?.points_dropped ?? 0,
        unsupported_claim_count: counts?.unsupported_claims ?? 0,
        forbidden_claim_count: counts?.forbidden_claims ?? 0,
        fallback_used: status !== "validated",
        attempts: attempts.length,
        failure_categories: allCategories,
        provider: provider?.id ?? null,
        model: provider?.model ?? null,
        prompt_version: PROMPT_VERSION,
        input_hash: extra.inputHash ?? null,
        output_hash,
      },
    };
  };

  // Nothing to summarise: do not call a model about an empty bundle.
  if (!bundle.citations.some((c) => c.section === "main")) return finish("skipped", { skipped: "the bundle holds no current evidence to summarise" });

  let selection: ReturnType<typeof selectPassages>;
  try {
    selection = selectPassages(bundle, passages);
  } catch (e) {
    if (e instanceof PromptError) return finish("skipped", { skipped: e.message });
    throw e;
  }
  const inputHash = inputHashOf(bundle, passages, selection.sent);
  if (selection.sent.length === 0) return finish("skipped", { skipped: "no passage can be sent to the model", inputHash });
  if (!provider) return finish("unavailable", { skipped: "no provider is configured", inputHash });

  let correction: FailureCategory[] | undefined;
  for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
    let prompt: PreparedPrompt;
    try {
      prompt = buildPrompt({ bundle, passages, nonce: opts.nonce?.(), correction });
    } catch (e) {
      if (e instanceof PromptError) return finish("skipped", { skipped: e.message, inputHash });
      throw e;
    }
    const request: LlmRequest = {
      system: prompt.system,
      user: prompt.user,
      temperature: GENERATION_PARAMS.temperature,
      maxOutputTokens: GENERATION_PARAMS.max_output_tokens,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      jsonSchema: OUTPUT_JSON_SCHEMA,
    };
    const record: AttemptRecord = {
      attempt: n, outcome: "rejected", provider_error: null, raw: null, raw_sha256: null, raw_length: 0, request_sha256: sha256Hex(`${request.system}\n${request.user}`),
      finish_reason: null, model_version: null, usage: null, parse: null, schema_issues: [], rejection: null, categories: {}, counts: null, dropped: [], withheld: prompt.withheld, latency_ms: null,
    };
    attempts.push(record);

    const started = now();
    let response: LlmResponse;
    try {
      response = await withTimeout(provider.generate(request), request.timeoutMs);
    } catch (e) {
      const kind = e instanceof ProviderError ? e.kind : "unavailable";
      record.outcome = "provider_error";
      record.provider_error = { kind };
      record.latency_ms = now() - started;
      record.categories = { provider_error: 1 };
      summarise(record.categories, allCategories);
      if (RETRYABLE_PROVIDER_ERRORS.has(kind) && n < MAX_ATTEMPTS) {
        correction = undefined;
        continue;
      }
      break;
    }
    record.latency_ms = now() - started;
    record.raw = response.text;
    record.raw_sha256 = sha256Hex(response.text);
    record.raw_length = response.text.length;
    record.finish_reason = response.finishReason;
    record.model_version = response.modelVersion;
    record.usage = response.usage;

    const parsed = parseModelOutput(response.text);
    if (parsed.ok === false) {
      record.parse = parsed.category;
      record.schema_issues = parsed.issues;
      record.rejection = parsed.category;
      record.categories = { [parsed.category]: 1 };
      summarise(record.categories, allCategories);
      correction = [parsed.category];
      continue;
    }
    record.parse = "ok";

    const outcome = validateOutput({ bundle, passages, sent: new Set(prompt.sent), factsText: prompt.factsText, output: parsed.value, policy: opts.policy ?? DEFAULT_POLICY });
    record.rejection = outcome.rejection;
    record.categories = outcome.categories;
    record.counts = outcome.counts;
    record.dropped = outcome.dropped;
    summarise(outcome.categories, allCategories);
    if (!outcome.accepted) {
      correction = [...new Set([outcome.rejection!, ...(Object.keys(outcome.categories) as FailureCategory[])])].slice(0, 8);
      continue;
    }

    const rendered = renderExplanation({ bundle, kept: outcome.kept, uncertainties: outcome.uncertainties, missing_evidence: outcome.missing_evidence, passages, resolve: resolveMetadata });
    const checks = checkRendered(bundle, rendered, outcome.kept, passages);
    const failed = checks.filter((c) => !c.ok);
    if (failed.length) throw new Error(`rendered explanation failed its own checks: ${failed.map((c) => c.name).join("; ")}`);
    record.outcome = "accepted";
    const explanation: ValidatedExplanation = {
      schema: EXPLANATION_SCHEMA,
      status: "validated",
      bundle_hash: bundle.bundle_hash,
      prompt_version: PROMPT_VERSION,
      prompt_hash: PROMPT_HASH,
      provider: provider.id,
      model: provider.model,
      model_version: response.modelVersion,
      opening: FALLBACK_OPENING,
      points: outcome.kept.map((p) => ({ index: p.index, text: p.text, kind: p.kind, citations: p.citations, anchors: p.anchors, support: p.support })),
      uncertainties: outcome.uncertainties,
      missing_evidence: outcome.missing_evidence,
      bundle_gaps: bundle.gaps.map((g) => g.message),
      thin: rendered.thin,
      text: rendered.text,
    };
    return finish("validated", { explanation, checks, inputHash });
  }

  return finish(attempts.some((a) => a.outcome === "rejected") ? "rejected" : "unavailable", { inputHash });
}
