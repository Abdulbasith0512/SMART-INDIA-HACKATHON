// The canonical evidence bundle (schema "evidence-bundle/1").
//
// A bundle is the complete, immutable, reproducible record of what the evidence engine selected for one signal.
// It is DATA for a human verifier (and, in M4.5, for a model to summarise); it is never an instruction and it does
// not decide whether anything is real. Every excerpt is an exact stored chunk; every citation id maps to exactly one
// (evidence_version_id, chunk_id); user-visible metadata (title, publisher, URL, dates) is NOT copied in - it is
// always rendered from the database through the stored ids.
//
// The rank score inside score_components is presentation priority for a verifier, not the probability that an
// evidence item is correct.
import type { QueryFacet } from "../vocab";

export const BUNDLE_SCHEMA_VERSION = "evidence-bundle/1";

export interface BundleSignal {
  candidate_id: string;
  episode_key: string | null;
  region: { id: string; name: string; level: string; district: string | null; state: string | null };
  syndrome: string;
  window: { start: string; end: string };
  detector_version: string | null;
}

export interface BundleCorpus {
  snapshot_id: string | null;
  corpus_hash: string | null;
  /** Content-addressed digest of exactly what retrieval could see (independent of database ids). */
  corpus_digest: string;
}

export interface BundleConfig {
  retrieval_version: string;
  retrieval_config_hash: string;
  query_vocab_version: string;
  query_config_version: string;
  ranking_version: string;
  ranking_config_hash: string;
  as_of_date: string;
}

export interface BundleProvenance {
  query_hash: string;
  retrieval_result_hash: string;
  historical_retrieval_result_hash: string | null;
  ranking_hash: string;
}

export interface BundleItem {
  citation_id: string;
  /** Rank within this facet (1 = first). */
  rank: number;
  evidence_item_id: string;
  evidence_version_id: string;
  chunk_id: string;
  chunk_ordinal: number;
  chunk_hash: string;
  version_content_hash: string;
  canonical_id: string | null;
  evidence_kind: string | null;
  is_synthetic: boolean;
  tier: { source_class: string; label: string; position: number };
  geo_level: string;
  temporal_status: { rule: string; reason: string; age_days: number | null; factor: number };
  score_components: Record<string, unknown>;
  why_relevant: string[];
  /** The stored chunk text, verbatim. Never rewritten, summarised or paraphrased. */
  excerpt: string;
}

export interface BundleFacet {
  name: QueryFacet;
  query_terms: string[];
  query_topics: string[];
  items: BundleItem[];
  gaps: BundleGap[];
}

export interface BundleHistoricalItem extends BundleItem {
  facet: QueryFacet;
  relation: { status: string; superseded_by: string[] };
}

export interface BundleCitation {
  citation_id: string;
  section: "main" | "historical_context";
  evidence_item_id: string;
  evidence_version_id: string;
  chunk_id: string;
  canonical_id: string | null;
  chunk_ordinal: number;
  chunk_hash: string;
  version_content_hash: string;
  appears_in: Array<{ facet: QueryFacet; rank: number }>;
}

export interface BundleGap {
  code: string;
  scope: string;
  facet: QueryFacet | null;
  message: string;
  basis: Record<string, unknown>;
}

export interface BundleConflict {
  /** Distinguishes curator-authored conflicts from any future model-observed disagreement (not produced in M4.4). */
  kind: "curator_tagged_conflict";
  question_key: string;
  positions: Array<{ position: string; documents: Array<Record<string, unknown> & { citation_ids: string[] }> }>;
  basis: "curator_tags";
  note: string;
}

export interface BundleExclusion {
  id: string;
  reason: string;
  family: string;
  facet: QueryFacet;
  section: "main" | "historical_context";
  candidate: Record<string, unknown>;
  bm25_score: number;
  score_components: Record<string, unknown>;
  detail: Record<string, unknown>;
}

export interface BundleStats {
  eligible_candidates: number;
  selected_chunks: number;
  selected_slots: number;
  selected_documents: number;
  excluded_candidates: number;
  exclusions_by_reason: Record<string, number>;
  facets_covered: number;
  facets_total: number;
  gaps: number;
  conflicts: number;
  historical_context_items: number;
  selected_synthetic: number;
  selected_non_synthetic: number;
  tier_distribution: Record<string, number>;
}

export interface EvidenceBundle {
  schema_version: typeof BUNDLE_SCHEMA_VERSION;
  bundle_hash: string;
  notice: string;
  signal: BundleSignal;
  corpus: BundleCorpus;
  config: BundleConfig;
  provenance: BundleProvenance;
  facets: BundleFacet[];
  citations: BundleCitation[];
  historical_context: BundleHistoricalItem[];
  conflicts: BundleConflict[];
  gaps: BundleGap[];
  excluded: BundleExclusion[];
  retrieval_exclusions: { counts: Record<string, Record<string, number>>; notable: Array<Record<string, unknown>> };
  stats: BundleStats;
  /** Wall-clock time of the build. Excluded from bundle_hash. */
  retrieved_at: string;
}
