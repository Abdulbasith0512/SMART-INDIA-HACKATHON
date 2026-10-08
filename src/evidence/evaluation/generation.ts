// Evaluation of the M4.5 grounded generation, in three clearly separated layers:
//
//   A. DETERMINISTIC VALIDATOR METRICS (this file): computed from model answers and the bundle by code, no judgement involved.
//   B. MODEL-JUDGE METRICS (judge.ts): experimental, never reported unless the judge has first agreed with human labels.
//   C. HUMAN EVALUATION (review.ts): exported for raters; every item is marked pending until real raters have rated it.
//
// WHAT THE NUMBERS BELOW ARE. In this repository the "model" is the deterministic scripted MockProvider, because no live provider
// is configured. So these metrics measure the PIPELINE (parsing, citation and anchor checks, support and safety validators, retry,
// fallback), not the quality of any language model. They say nothing about factual consistency, which a lexical or structural
// check cannot establish: that metric is explicitly NOT MEASURED here.
//
// Generation is evaluated from STORED outputs: the raw answers of each run are recorded and replayed through the real pipeline by
// ReplayProvider, so a comparison never depends on a model being deterministic (temperature 0 does not guarantee it).
import { FALLBACK_OPENING } from "../bundle/fallback";
import type { MetadataResolver } from "../bundle/fallback";
import type { EvidenceBundle } from "../bundle/types";
import { generateExplanation, type GenerationResult, type GenerationStatus } from "../llm/generate";
import { parseModelOutput } from "../llm/schema";
import { ProviderError, UNSUPPORTED, type FailureCategory, type LlmProvider, type LlmResponse, type PassageMap, type ProviderErrorKind } from "../llm/types";
import type { CorpusItem, CorpusView } from "../retrieval/corpus";
import { QUERY_FACETS, type QueryFacet } from "../vocab";
import { hashJson } from "../hash";
import { gradeOf, type indexJudgments } from "./judgments";
import { passagesOf, type ScenarioRun } from "./run";
import { rate, type Rate } from "./stats";

export const EVAL_NONCE = () => "0123456789abcdef01234567";

// ------------------------------------------------------------------------------------------------ stored outputs and replay
export type StoredAttempt = { kind: "text"; text: string } | { kind: "error"; error_kind: ProviderErrorKind | "unavailable" };

export interface StoredGeneration {
  scenario: string;
  provider: string;
  model: string;
  model_version: string | null;
  prompt_version: string;
  prompt_hash: string;
  input_hash: string | null;
  skipped_reason: string | null;
  attempts: StoredAttempt[];
  status: GenerationStatus;
  output_hash: string | null;
}

export function storeGeneration(scenario: string, r: GenerationResult): StoredGeneration {
  return {
    scenario, provider: r.provider ?? "none", model: r.model ?? "none", model_version: r.model_version, prompt_version: r.prompt_version, prompt_hash: r.prompt_hash,
    input_hash: r.input_hash, skipped_reason: r.skipped_reason,
    attempts: r.attempts.map((a): StoredAttempt => (a.raw !== null ? { kind: "text", text: a.raw } : { kind: "error", error_kind: (a.provider_error?.kind ?? "unavailable") as ProviderErrorKind }) ),
    status: r.status, output_hash: r.output_hash,
  };
}

/** Replays recorded answers, in order, through the real pipeline. It never calls a model. */
export class ReplayProvider implements LlmProvider {
  readonly id: string;
  readonly model: string;
  private i = 0;
  constructor(private readonly stored: StoredGeneration) {
    this.id = stored.provider;
    this.model = stored.model;
  }
  async generate(): Promise<LlmResponse> {
    const a = this.stored.attempts[this.i++];
    if (!a) throw new Error(`replay of ${this.stored.scenario}: the stored run made only ${this.stored.attempts.length} attempt(s)`);
    if (a.kind === "error") throw new ProviderError(a.error_kind as ProviderErrorKind, "replayed provider failure");
    return { text: a.text, modelVersion: this.stored.model_version, finishReason: "STOP", usage: null };
  }
}

export async function generateFor(run: ScenarioRun, provider: LlmProvider | null, resolveMetadata: MetadataResolver): Promise<GenerationResult> {
  return generateExplanation({ bundle: run.bundle, passages: passagesOf(run), provider, resolveMetadata, options: { nonce: EVAL_NONCE, now: () => 0 } });
}
export async function replayFor(run: ScenarioRun, stored: StoredGeneration, resolveMetadata: MetadataResolver): Promise<GenerationResult> {
  return generateFor(run, stored.attempts.length ? new ReplayProvider(stored) : null, resolveMetadata);
}

// ------------------------------------------------------------------------------------------------ independent checks
const strict = (s: string): string => s.normalize("NFC").replace(/\s+/gu, " ").trim();
const verbatim = (passage: string, quote: string): boolean => strict(quote).length > 0 && strict(passage).includes(strict(quote));

const HALLUCINATION: ReadonlySet<FailureCategory> = new Set<FailureCategory>([
  "citation_unknown", "fabricated_citation", "anchor_not_verbatim", "unsupported_number", "unsupported_date", "unsupported_entity", "unsupported_terminology",
]);
const isForbidden = (c: FailureCategory): boolean => c.startsWith("forbidden_") || c === "hidden_unicode" || c === "non_english_text";

export type FallbackCause = "none" | "provider_failure" | "schema_failure" | "validator_rejection" | "fallback_extraction";

export function fallbackCause(r: GenerationResult): FallbackCause {
  if (r.status === "validated") return "none";
  if (r.status === "unavailable") return "provider_failure";
  if (r.status === "skipped") return "fallback_extraction";
  const last = [...r.attempts].reverse().find((a) => a.outcome !== "provider_error");
  return last && last.parse !== "ok" ? "schema_failure" : "validator_rejection";
}

export interface GenerationFacts {
  scenario: string;
  status: GenerationStatus;
  fallback_cause: FallbackCause;
  attempts: { total: number; accepted: number; provider_error: number; schema_failure: number; validator_rejection: number };
  /** Across every parseable provider answer (all attempts, accepted or not). */
  claims: number;
  claims_fully_anchored: number;
  claims_unsupported: number;
  claims_hallucinated: number;
  claims_forbidden: number;
  citations_listed: number;
  citations_existing: number;
  anchors_listed: number;
  anchors_verbatim: number;
  /** Validated explanations only. */
  validated_claims: number;
  metadata_cited_passages: number;
  metadata_cited_passages_correct: number;
  facets_with_selected: number;
  facets_with_cited: number;
  grade2_selected: number;
  grade2_cited: number;
  opens_with_required_sentence: boolean | null;
}

export function generationFacts(run: ScenarioRun, r: GenerationResult, passages: PassageMap, resolve: MetadataResolver, judgments: ReturnType<typeof indexJudgments>): GenerationFacts {
  const ids = new Set(run.bundle.citations.map((c) => c.citation_id));
  const f: GenerationFacts = {
    scenario: run.scenario.id, status: r.status, fallback_cause: fallbackCause(r),
    attempts: { total: r.attempts.length, accepted: 0, provider_error: 0, schema_failure: 0, validator_rejection: 0 },
    claims: 0, claims_fully_anchored: 0, claims_unsupported: 0, claims_hallucinated: 0, claims_forbidden: 0, citations_listed: 0, citations_existing: 0, anchors_listed: 0, anchors_verbatim: 0,
    validated_claims: 0, metadata_cited_passages: 0, metadata_cited_passages_correct: 0, facets_with_selected: 0, facets_with_cited: 0, grade2_selected: 0, grade2_cited: 0, opens_with_required_sentence: null,
  };
  for (const a of r.attempts) {
    if (a.outcome === "provider_error") {
      f.attempts.provider_error += 1;
      continue;
    }
    if (a.outcome === "accepted") f.attempts.accepted += 1;
    else if (a.parse !== "ok") f.attempts.schema_failure += 1;
    else f.attempts.validator_rejection += 1;
    const parsed = parseModelOutput(a.raw ?? "");
    if (parsed.ok === false) continue;
    for (const p of parsed.value.points) {
      f.claims += 1;
      // a citation reference is any id in the claim's citation list OR written as [E#] in its text, so a fabricated in-text token is not missed
      const refs = new Set([...p.citations, ...(p.text.match(/\[(E\d+)\]/g) ?? []).map((t) => t.slice(1, -1))]);
      for (const c of refs) {
        f.citations_listed += 1;
        if (ids.has(c)) f.citations_existing += 1;
      }
      const anchoredIds = new Set<string>();
      for (const an of p.anchors) {
        f.anchors_listed += 1;
        const text = passages.get(an.citation)?.text;
        if (text !== undefined && p.citations.includes(an.citation) && verbatim(text, an.quote)) {
          f.anchors_verbatim += 1;
          anchoredIds.add(an.citation);
        }
      }
      if (refs.size > 0 && [...refs].every((c) => ids.has(c) && anchoredIds.has(c))) f.claims_fully_anchored += 1;
    }
    for (const d of a.dropped.filter((x) => x.where.startsWith("points["))) {
      if (d.categories.some((c) => UNSUPPORTED.has(c))) f.claims_unsupported += 1;
      if (d.categories.some((c) => HALLUCINATION.has(c))) f.claims_hallucinated += 1;
      if (d.categories.some(isForbidden)) f.claims_forbidden += 1;
    }
  }

  if (r.explanation) {
    const e = r.explanation;
    f.validated_claims = e.points.length;
    f.opens_with_required_sentence = e.text.startsWith(`${FALLBACK_OPENING}\n`);
    const cited = new Set(e.points.flatMap((p) => p.citations));
    for (const id of cited) {
      const c = run.bundle.citations.find((x) => x.citation_id === id)!;
      const m = resolve(c.evidence_version_id);
      f.metadata_cited_passages += 1;
      // the Source line printed directly under this passage must carry the database metadata of exactly this citation's version
      const start = e.text.indexOf(`[${id}] "`);
      const next = e.text.indexOf("\n[E", start + 1);
      const segment = e.text.slice(start, next < 0 ? undefined : next);
      if (m && start >= 0 && segment.includes(`Source: ${m.title} - ${m.publisher}`)) f.metadata_cited_passages_correct += 1;
    }
    for (const facet of QUERY_FACETS) {
      const sel = run.bundle.facets.find((x) => x.name === facet)!.items;
      if (sel.length === 0) continue;
      f.facets_with_selected += 1;
      if (sel.some((i) => cited.has(i.citation_id))) f.facets_with_cited += 1;
      for (const i of sel) {
        if (gradeOf(judgments, run.scenario.id, facet as QueryFacet, i.canonical_id ?? i.evidence_item_id, i.chunk_ordinal) === 2) {
          f.grade2_selected += 1;
          if (cited.has(i.citation_id)) f.grade2_cited += 1;
        }
      }
    }
  }
  return f;
}

// ------------------------------------------------------------------------------------------------ aggregation
const total = (xs: readonly GenerationFacts[], f: (x: GenerationFacts) => number): number => xs.reduce((n, x) => n + f(x), 0);

export interface GenerationAggregate {
  provider_kind: string;
  caveat: string;
  scenarios: number;
  final_status: Record<GenerationStatus, number>;
  fallback: { fallback_rate: Rate; by_cause: Record<FallbackCause, number> };
  attempts: GenerationFacts["attempts"];
  /** A. deterministic validator metrics; denominators are over PROVIDER-PRODUCED claims in parseable answers, failed generations included. */
  validator: {
    claims_produced: number;
    citation_existence: Rate;
    anchor_verbatim: Rate;
    citation_completeness: Rate;
    structural_groundedness: Rate;
    unsupported_claim_rate: Rate;
    hallucination_rate: Rate;
    forbidden_claim_rate: Rate;
    metadata_integrity: Rate;
    evidence_coverage_facets: Rate;
    evidence_coverage_highly_relevant: Rate;
    required_opening_present: Rate;
  };
  /** B and C. */
  factual_consistency: { status: "not_measured"; reason: string };
}

export function aggregateGeneration(facts: readonly GenerationFacts[], providerKind: string): GenerationAggregate {
  const statuses: Record<GenerationStatus, number> = { validated: 0, rejected: 0, unavailable: 0, skipped: 0 };
  const causes: Record<FallbackCause, number> = { none: 0, provider_failure: 0, schema_failure: 0, validator_rejection: 0, fallback_extraction: 0 };
  for (const f of facts) {
    statuses[f.status] += 1;
    causes[f.fallback_cause] += 1;
  }
  const claims = total(facts, (f) => f.claims);
  const validated = facts.filter((f) => f.status === "validated");
  return {
    provider_kind: providerKind,
    caveat: "These metrics measure the generation PIPELINE (parsing, citation / anchor / support / safety validators, retry, fallback) driven by a scripted provider. They are not a measure of any language model's quality.",
    scenarios: facts.length,
    final_status: statuses,
    fallback: { fallback_rate: rate(facts.length - statuses.validated, facts.length), by_cause: causes },
    attempts: {
      total: total(facts, (f) => f.attempts.total), accepted: total(facts, (f) => f.attempts.accepted), provider_error: total(facts, (f) => f.attempts.provider_error),
      schema_failure: total(facts, (f) => f.attempts.schema_failure), validator_rejection: total(facts, (f) => f.attempts.validator_rejection),
    },
    validator: {
      claims_produced: claims,
      citation_existence: rate(total(facts, (f) => f.citations_existing), total(facts, (f) => f.citations_listed)),
      anchor_verbatim: rate(total(facts, (f) => f.anchors_verbatim), total(facts, (f) => f.anchors_listed)),
      citation_completeness: rate(total(facts, (f) => f.claims_fully_anchored), claims),
      structural_groundedness: rate(claims - total(facts, (f) => f.claims_unsupported), claims),
      unsupported_claim_rate: rate(total(facts, (f) => f.claims_unsupported), claims),
      hallucination_rate: rate(total(facts, (f) => f.claims_hallucinated), claims),
      forbidden_claim_rate: rate(total(facts, (f) => f.claims_forbidden), claims),
      metadata_integrity: rate(total(validated, (f) => f.metadata_cited_passages_correct), total(validated, (f) => f.metadata_cited_passages)),
      evidence_coverage_facets: rate(total(validated, (f) => f.facets_with_cited), total(validated, (f) => f.facets_with_selected)),
      evidence_coverage_highly_relevant: rate(total(validated, (f) => f.grade2_cited), total(validated, (f) => f.grade2_selected)),
      required_opening_present: rate(validated.filter((f) => f.opens_with_required_sentence === true).length, validated.length),
    },
    factual_consistency: { status: "not_measured", reason: "Factual consistency needs a judge validated against human labels or human review; a deterministic check can prove provenance and form, not truth." },
  };
}

// ------------------------------------------------------------------------------------------------ stale-citation detection
export type StaleKind = "superseded" | "withdrawn" | "content_changed";
export const STALE_KINDS: readonly StaleKind[] = ["superseded", "withdrawn", "content_changed"];

/** The same rules production re-validation applies to stored citations: the document is no longer current, or a newer version replaced the cited one. */
export function detectStaleCitations(bundle: EvidenceBundle, later: CorpusView): string[] {
  const byId = new Map(later.items.map((i) => [i.id, i]));
  return bundle.citations
    .filter((c) => c.section === "main")
    .filter((c) => {
      const item = byId.get(c.evidence_item_id);
      return !item || item.status !== "current" || item.version?.contentHash !== c.version_content_hash;
    })
    .map((c) => c.citation_id);
}

export function mutateItem(view: CorpusView, itemId: string, kind: StaleKind): CorpusView {
  const change = (i: CorpusItem): CorpusItem =>
    kind === "superseded" ? { ...i, status: "superseded" } : kind === "withdrawn" ? { ...i, status: "withdrawn" } : { ...i, version: i.version ? { ...i.version, contentHash: hashJson(`${i.version.contentHash}|edited`) } : i.version };
  return { ...view, items: view.items.map((i) => (i.id === itemId ? change(i) : i)) };
}

export interface StaleProbe {
  scenario: string;
  /** Citations that ARE stale after the mutation (every main citation of the mutated document), summed over the three mutations. */
  truth: number;
  detected: number;
  false_positives: number;
  /** Detections on the unchanged corpus (must be none). */
  control_false_positives: number;
}

export function staleProbe(run: ScenarioRun): StaleProbe | null {
  const main = run.bundle.citations.filter((c) => c.section === "main");
  if (main.length === 0) return null;
  const target = main[0].evidence_item_id;
  const truthIds = new Set(main.filter((c) => c.evidence_item_id === target).map((c) => c.citation_id));
  const out: StaleProbe = { scenario: run.scenario.id, truth: 0, detected: 0, false_positives: 0, control_false_positives: detectStaleCitations(run.bundle, run.inputs.view).length };
  for (const kind of STALE_KINDS) {
    const flagged = new Set(detectStaleCitations(run.bundle, mutateItem(run.inputs.view, target, kind)));
    out.truth += truthIds.size;
    out.detected += [...flagged].filter((id) => truthIds.has(id)).length;
    out.false_positives += [...flagged].filter((id) => !truthIds.has(id)).length;
  }
  return out;
}

export function aggregateStale(probes: ReadonlyArray<StaleProbe | null>): { stale_citation_detection_recall: Rate; false_positive_detections: number; control_false_positives: number; scenarios_probed: number } {
  const ps = probes.filter((p): p is StaleProbe => p !== null);
  return {
    stale_citation_detection_recall: rate(ps.reduce((n, p) => n + p.detected, 0), ps.reduce((n, p) => n + p.truth, 0)),
    false_positive_detections: ps.reduce((n, p) => n + p.false_positives, 0),
    control_false_positives: ps.reduce((n, p) => n + p.control_false_positives, 0),
    scenarios_probed: ps.length,
  };
}
