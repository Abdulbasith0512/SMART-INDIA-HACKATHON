// M4.5 - grounded generation. Shared types.
//
// The model is an EVIDENCE SUMMARISER. It is not a detector, a verifier or a clinician; it does not retrieve evidence,
// browse, call tools or decide whether a signal is real. Its only input is the SignalFacts block and the passages of an
// M4.4 evidence bundle; its output is untrusted until the deterministic validators in this directory accept it.

// ---------------------------------------------------------------- provider contract
export type ProviderErrorKind = "not_configured" | "timeout" | "unavailable" | "rate_limited" | "blocked" | "bad_request" | "unauthorized";

/** A failure to obtain a response. Always safe to turn into the deterministic fallback. */
export class ProviderError extends Error {
  constructor(readonly kind: ProviderErrorKind, message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface LlmRequest {
  /** Instruction layer. Never contains evidence text. */
  system: string;
  /** Trusted fact blocks followed by the nonce-delimited, id-tagged DATA block, then the task. */
  user: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  /** The shape the answer must have. A provider may use it to constrain output; the validators never rely on that. */
  jsonSchema: Record<string, unknown>;
}

export interface LlmResponse {
  text: string;
  /** Provider-reported model version, when it reports one. */
  modelVersion: string | null;
  finishReason: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
}

export interface LlmProvider {
  /** Provider id as stored with the explanation, e.g. "mock" or "gemini". */
  readonly id: string;
  /** Model identifier as stored with the explanation. */
  readonly model: string;
  generate(request: LlmRequest): Promise<LlmResponse>;
}

// ---------------------------------------------------------------- model output
export const POINT_KINDS = ["evidence_statement", "synthesis", "agreement", "disagreement", "terminology"] as const;
export type PointKind = (typeof POINT_KINDS)[number];

export interface Anchor {
  citation: string;
  quote: string;
}
export interface ModelPoint {
  text: string;
  kind: PointKind;
  citations: string[];
  anchors: Anchor[];
}
export interface ModelOutput {
  points: ModelPoint[];
  uncertainties: string[];
  missing_evidence: string[];
}

/** One passage as the model saw it, resolved from the database by the bundle's stored ids. */
export interface Passage {
  citation_id: string;
  evidence_version_id: string;
  chunk_id: string;
  text: string;
  facets: string[];
}
export type PassageMap = ReadonlyMap<string, Passage>;

// ---------------------------------------------------------------- validation vocabulary
/** Every reason a piece of model output can be refused. A fixed vocabulary: reports and retries never echo model text. */
export const FAILURE_CATEGORIES = [
  // transport / shape
  "provider_error", "empty_response", "malformed_json", "schema_violation",
  // citations and anchors
  "citation_unknown", "citation_withheld", "citation_count", "citation_without_anchor", "anchor_citation_mismatch",
  "anchor_not_verbatim", "anchor_too_short", "anchor_forbidden_content", "fabricated_citation",
  // support
  "unsupported_number", "unsupported_date", "unsupported_entity", "unsupported_terminology", "unsupported_causal_claim",
  // forbidden content
  "forbidden_diagnosis", "forbidden_outbreak_confirmation", "forbidden_treatment_advice", "forbidden_overclaim",
  "forbidden_instruction", "forbidden_instruction_override", "forbidden_role_manipulation", "forbidden_tool_call",
  "forbidden_code_execution", "forbidden_secret_request", "forbidden_url", "forbidden_markdown_link", "forbidden_image",
  "forbidden_html", "forbidden_encoded_blob", "hidden_unicode", "non_english_text",
  // whole-generation outcomes
  "no_valid_points", "too_many_dropped", "input_too_large",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** Categories that mean the model was steered or tried to act: the whole generation is refused, not just one claim. */
export const GENERATION_LEVEL: ReadonlySet<FailureCategory> = new Set<FailureCategory>([
  "forbidden_instruction_override", "forbidden_role_manipulation", "forbidden_tool_call", "forbidden_code_execution", "forbidden_secret_request",
]);

/** Categories counted as "unsupported claim" for evaluation (the claim says more than the cited evidence does). */
export const UNSUPPORTED: ReadonlySet<FailureCategory> = new Set<FailureCategory>([
  "citation_unknown", "citation_withheld", "citation_count", "citation_without_anchor", "anchor_citation_mismatch", "anchor_not_verbatim",
  "anchor_too_short", "fabricated_citation", "unsupported_number", "unsupported_date", "unsupported_entity", "unsupported_terminology",
  "unsupported_causal_claim",
]);

export interface Failure {
  category: FailureCategory;
  /** Which field: "points[3].text", "points[1].anchors[0]", "uncertainties[0]", ... Never contains model text. */
  where: string;
  /** Short fixed-vocabulary detail such as a rule id or a citation id. Never contains model text. */
  detail?: string;
}
