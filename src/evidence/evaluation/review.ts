// Layer C of the generation evaluation: HUMAN evaluation. There is no officer UI in this milestone. Instead the harness
// exports a self-contained review dataset - what a public-health or epidemiology rater needs to judge one scenario - with every
// rating field empty. Nothing in it is a judgement: reference grades are shown only so the project can compare them with the
// raters' grades later, and are labelled synthetic_reference_judgment.
import type { MetadataResolver } from "../bundle/fallback";
import type { GenerationResult } from "../llm/generate";
import { QUERY_FACETS } from "../vocab";
import { gradeOf, type indexJudgments } from "./judgments";
import { fallbackCause } from "./generation";
import type { ScenarioRun } from "./run";
import { DISCLAIMER, JUDGMENT_LABEL } from "./types";

export const REVIEW_SCHEMA = "m4-eval-review/1";

/** What no automated metric in this repository can establish. Every item is PENDING until real raters have rated it. */
export const PENDING_HUMAN_EVALUATION = [
  { id: "real_corpus_relevance", description: "Relevance of retrieved evidence on a real, curated, licence-checked corpus (graded 0/1/2) by at least two public-health raters, with inter-rater agreement." },
  { id: "clinical_epidemiological_accuracy", description: "Whether generated statements are clinically and epidemiologically accurate and not misleading, rated by epidemiology / public-health experts." },
  { id: "verifier_usefulness", description: "Whether the evidence and explanation actually help a district surveillance officer verify an emerging signal." },
  { id: "source_tier_appropriateness", description: "Whether the presentation-priority ordering of source classes is appropriate for verification." },
  { id: "hindi_odia_quality", description: "Quality of any Hindi or Odia output. No Hindi or Odia text is generated in M4; this stays pending until such output exists and native-speaker reviewers rate it." },
] as const;

export interface ReviewRecord {
  review_id: string;
  split: string;
  scenario: { id: string; family: string; category: string; description: string };
  signal: {
    syndrome: string;
    region: { name: string; level: string };
    ancestors: string[];
    window: { start: string; end: string };
    involved_blocks: string[];
    spread: string;
    persistence: string;
  };
  retrieved_evidence: Array<{
    facet: string;
    rank: number;
    citation_id: string;
    canonical_id: string | null;
    title: string | null;
    publisher: string | null;
    source_class: string;
    tier_label: string;
    geo_level: string;
    evidence_kind: string | null;
    is_synthetic: boolean;
    excerpt: string;
    why_relevant: string[];
    reference_judgment: { grade: number; label: typeof JUDGMENT_LABEL };
    rating: { relevance_0_to_2: number | null; tier_appropriate: boolean | null; notes: string | null };
  }>;
  bundle: { bundle_hash: string; corpus_digest: string; gaps: Array<{ code: string; facet: string | null; message: string }>; conflicts: number; historical_context_items: number; excluded_candidates: number };
  generated_explanation: {
    status: string;
    shown: "validated_model_explanation" | "deterministic_extractive_fallback";
    fallback_cause: string;
    provider: string | null;
    model: string | null;
    prompt_version: string;
    text: string;
    claims: Array<{
      index: number;
      kind: string;
      text: string;
      citations: string[];
      anchors: Array<{ citation: string; quote: string }>;
      rating: { support: "supported" | "partially_supported" | "unsupported" | null; clinically_accurate: boolean | null; notes: string | null };
    }>;
    uncertainties: string[];
    missing_evidence: string[];
  };
  overall_rating: { useful_to_verifier_1_to_5: number | null; clinical_epidemiological_accuracy_1_to_5: number | null; notes: string | null };
}

export interface ReviewDataset {
  artefact: "m4-6-review-dataset";
  schema: typeof REVIEW_SCHEMA;
  disclaimer: string;
  instructions: string;
  rater_requirements: string;
  rating_status: "pending";
  pending_human_evaluation: typeof PENDING_HUMAN_EVALUATION;
  records: ReviewRecord[];
}

export function reviewRecord(run: ScenarioRun, gen: GenerationResult, resolve: MetadataResolver, judgments: ReturnType<typeof indexJudgments>, split: string): ReviewRecord {
  const f = run.inputs.facts;
  const items = QUERY_FACETS.flatMap((facet) =>
    run.bundle.facets
      .find((x) => x.name === facet)!
      .items.map((i) => {
        const meta = resolve(i.evidence_version_id);
        return {
          facet, rank: i.rank, citation_id: i.citation_id, canonical_id: i.canonical_id, title: meta?.title ?? null, publisher: meta?.publisher ?? null,
          source_class: i.tier.source_class, tier_label: i.tier.label, geo_level: i.geo_level, evidence_kind: i.evidence_kind, is_synthetic: i.is_synthetic, excerpt: i.excerpt,
          why_relevant: i.why_relevant,
          reference_judgment: { grade: gradeOf(judgments, run.scenario.id, facet, i.canonical_id ?? i.evidence_item_id, i.chunk_ordinal), label: JUDGMENT_LABEL },
          rating: { relevance_0_to_2: null, tier_appropriate: null, notes: null },
        };
      }),
  );
  const e = gen.explanation;
  return {
    review_id: run.scenario.id,
    split,
    scenario: { id: run.scenario.id, family: run.scenario.family, category: run.scenario.category, description: run.scenario.description },
    signal: {
      syndrome: f.syndrome, region: { name: f.region.name, level: f.region.level }, ancestors: f.ancestors.map((a) => a.name), window: f.window as { start: string; end: string },
      involved_blocks: f.involved_blocks.map((b) => b.name), spread: f.spread, persistence: f.persistence,
    },
    retrieved_evidence: items,
    bundle: {
      bundle_hash: run.bundle.bundle_hash, corpus_digest: run.bundle.corpus.corpus_digest, gaps: run.bundle.gaps.map((g) => ({ code: g.code, facet: g.facet, message: g.message })),
      conflicts: run.bundle.conflicts.length, historical_context_items: run.bundle.historical_context.length, excluded_candidates: run.bundle.stats.excluded_candidates,
    },
    generated_explanation: {
      status: gen.status,
      shown: e ? "validated_model_explanation" : "deterministic_extractive_fallback",
      fallback_cause: fallbackCause(gen),
      provider: gen.provider,
      model: gen.model,
      prompt_version: gen.prompt_version,
      text: e ? e.text : gen.fallback.fallback.text,
      claims: e ? e.points.map((p) => ({ index: p.index, kind: p.kind, text: p.text, citations: p.citations, anchors: p.anchors, rating: { support: null, clinically_accurate: null, notes: null } })) : [],
      uncertainties: e ? e.uncertainties : [],
      missing_evidence: e ? e.missing_evidence : [],
    },
    overall_rating: { useful_to_verifier_1_to_5: null, clinical_epidemiological_accuracy_1_to_5: null, notes: null },
  };
}

export function reviewDataset(records: ReviewRecord[]): ReviewDataset {
  return {
    artefact: "m4-6-review-dataset",
    schema: REVIEW_SCHEMA,
    disclaimer: DISCLAIMER,
    instructions:
      "For each record, rate every retrieved passage's relevance to verifying the signal (0 irrelevant, 1 partly relevant, 2 highly relevant), whether the source tier is appropriate, " +
      "and each generated claim against its cited passage (supported / partially_supported / unsupported). Rate independently of the other rater; do not look at reference_judgment until all ratings are complete. " +
      "The shown explanation may be a deterministic extractive fallback; its claims list is then empty.",
    rater_requirements: "At least two raters with public-health or epidemiology training, working independently, with agreement (Cohen's kappa) computed before adjudication and the adjudicated judgments frozen before use.",
    rating_status: "pending",
    pending_human_evaluation: PENDING_HUMAN_EVALUATION,
    records,
  };
}

// ------------------------------------------------------------------------------------------------ CSV flattening
/** RFC 4180 quoting, plus a guard against spreadsheet formula injection: a cell that starts with = + - @ tab or CR is prefixed with an apostrophe. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (columns: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): string =>
  `${[columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\n")}\n`;

export const ITEM_COLUMNS = ["review_id", "split", "facet", "rank", "citation_id", "canonical_id", "title", "publisher", "tier_label", "geo_level", "evidence_kind", "is_synthetic", "excerpt", "rater_relevance_0_to_2", "rater_tier_appropriate", "rater_notes"] as const;
export const CLAIM_COLUMNS = ["review_id", "split", "claim_index", "kind", "claim", "citations", "anchors", "rater_support", "rater_clinically_accurate", "rater_notes"] as const;

export function reviewItemsCsv(ds: ReviewDataset): string {
  return toCsv(
    ITEM_COLUMNS,
    ds.records.flatMap((r) =>
      r.retrieved_evidence.map((i) => ({
        review_id: r.review_id, split: r.split, facet: i.facet, rank: i.rank, citation_id: i.citation_id, canonical_id: i.canonical_id, title: i.title, publisher: i.publisher, tier_label: i.tier_label,
        geo_level: i.geo_level, evidence_kind: i.evidence_kind, is_synthetic: i.is_synthetic, excerpt: i.excerpt, rater_relevance_0_to_2: "", rater_tier_appropriate: "", rater_notes: "",
      })),
    ),
  );
}
export function reviewClaimsCsv(ds: ReviewDataset): string {
  return toCsv(
    CLAIM_COLUMNS,
    ds.records.flatMap((r) =>
      r.generated_explanation.claims.map((c) => ({
        review_id: r.review_id, split: r.split, claim_index: c.index, kind: c.kind, claim: c.text, citations: c.citations.join(" "), anchors: c.anchors.map((a) => `[${a.citation}] ${a.quote}`).join(" | "),
        rater_support: "", rater_clinically_accurate: "", rater_notes: "",
      })),
    ),
  );
}
