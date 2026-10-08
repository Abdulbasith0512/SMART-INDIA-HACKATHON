// Result types of the M4.3 ranking stage. Nothing here is a probability: see RANK_NOTICE in policy.ts.
import type { Candidate } from "../retrieval/retrieve";
import type { QueryFacet } from "../vocab";
import type { ClassComponent, GeoComponent, TemporalComponent } from "./factors";

export const RANKING_SCHEMA = "evidence-ranking/1";

/** Every term of the rank score, kept so a verifier (and the bundle, later) can see exactly why an item sits where it does. */
export interface ScoreComponents {
  formula: "normalised_relevance x class_factor x geo_factor x temporal_factor";
  relevance: { bm25: number; normalisedBy: number; value: number; method: string };
  classFactor: ClassComponent;
  geoFactor: GeoComponent;
  temporalFactor: TemporalComponent;
  rankScore: number;
}

export interface CandidateRef {
  chunkId: string;
  evidenceItemId: string;
  evidenceVersionId: string;
  canonicalId: string | null;
  chunkOrdinal: number;
  chunkHash: string;
  publisher: string;
  sourceClass: string;
}

export type RankedCandidate = Omit<Candidate, "rank"> & {
  /** 1-based position within the facet's presented (selected) evidence. */
  rank: number;
  /** The M4.2 lexical position this candidate came from. */
  retrievalRank: number;
  tierLabel: string;
  scoreComponents: ScoreComponents;
};

export type ExclusionReason =
  | "superseded" | "withdrawn" | "historical" | "not_current" | "expired" | "look_ahead" | "not_yet_valid" | "unknown_evidence_kind"
  | "geographic_ineligible" | "source_class_not_rankable" | "below_relevance_floor"
  | "duplicate" | "near_duplicate" | "document_diversity" | "publisher_diversity" | "beyond_top_k";

export type ExclusionFamily = "temporal_ineligible" | "geographic_ineligible" | "source_ineligible" | "relevance" | "duplicate" | "diversity" | "selection";

export const FAMILY_OF: Record<ExclusionReason, ExclusionFamily> = {
  superseded: "temporal_ineligible", withdrawn: "temporal_ineligible", historical: "temporal_ineligible", not_current: "temporal_ineligible",
  expired: "temporal_ineligible", look_ahead: "temporal_ineligible", not_yet_valid: "temporal_ineligible", unknown_evidence_kind: "temporal_ineligible",
  geographic_ineligible: "geographic_ineligible", source_class_not_rankable: "source_ineligible", below_relevance_floor: "relevance",
  duplicate: "duplicate", near_duplicate: "duplicate", document_diversity: "diversity", publisher_diversity: "diversity", beyond_top_k: "selection",
};

export interface RankingExclusion {
  facet: QueryFacet;
  section: "main" | "historical_context";
  reason: ExclusionReason;
  family: ExclusionFamily;
  candidate: CandidateRef;
  bm25Score: number;
  /** Whatever had been computed when the candidate was removed (all of it for dedup / diversity / top-K removals). */
  scoreComponents: Partial<ScoreComponents>;
  detail: {
    message: string;
    rule?: string;
    basis?: string;
    jaccard?: number | null;
    retained?: CandidateRef;
    limit?: number;
    key?: string;
    successorsPresent?: string[];
  };
}

export interface RankedFacet {
  facet: QueryFacet;
  selected: RankedCandidate[];
  excluded: RankingExclusion[];
  stats: { retrieved: number; rankable: number; afterFloor: number; afterDedup: number; selected: number; normalisedBy: number };
}

export interface HistoricalEntry extends RankedCandidate {
  section: "historical_context";
  relation: { status: string; supersededBy: string[] };
}

export interface ConflictDocument {
  canonicalId: string | null;
  evidenceItemId: string;
  publisher: string;
  sourceClass: string;
  facets: QueryFacet[];
  chunkIds: string[];
}
export interface ConflictEntry {
  questionKey: string;
  positions: Array<{ position: string; documents: ConflictDocument[] }>;
  basis: "curator_tags";
  note: string;
}

export type GapCode =
  | "no_eligible_evidence" | "facet_not_covered" | "missing_local_evidence" | "no_current_guidance" | "all_evidence_old" | "only_synthetic_evidence"
  | "contradicting_evidence";
export interface Gap {
  code: GapCode;
  scope: "signal" | "facet";
  facet: QueryFacet | null;
  message: string;
  basis: Record<string, unknown>;
}

export interface RetrievalExclusionSummary {
  /** Counts of document-level M4.2 exclusions by mapped reason, per facet. */
  counts: Record<string, Record<string, number>>;
  /** Plausible documents (right topic and syndrome) that did not compete, and why. */
  notable: Array<{ facet: QueryFacet; evidenceItemId: string; canonicalId: string | null; reasons: string[] }>;
}

export interface RankedEvidence {
  schema: typeof RANKING_SCHEMA;
  notice: string;
  signalId: string;
  asOfDate: string;
  ranking: { version: string; configHash: string };
  retrieval: { configHash: string; queryHash: string; resultHash: string; corpusDigest: string; historicalResultHash: string | null };
  facets: RankedFacet[];
  historicalContext: HistoricalEntry[];
  conflicts: ConflictEntry[];
  gaps: Gap[];
  exclusions: {
    ranking: RankingExclusion[];
    retrieval: RetrievalExclusionSummary;
    counts: Record<string, number>;
  };
  /** Content-addressed fingerprint (no database ids, no timestamps). */
  rankingHash: string;
}
