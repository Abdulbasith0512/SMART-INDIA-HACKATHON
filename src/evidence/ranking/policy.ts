// M4.3 ranking policy: every number that influences how eligible evidence is ORDERED for a human verifier.
//
// These are POLICY CONSTANTS, not learned or estimated parameters. They were written down before any result was
// looked at, are not tuned on any data, and are covered by a sensitivity analysis (sensitivity.ts) instead of
// being defended as "right". Changing any value changes the ranking config hash.
//
//   The rank score represents presentation priority for a verifier, not the probability that an evidence item is correct.
//
// What each factor means:
//   relevance  how well the chunk's wording matches the facet's query, RELATIVE to the best match in the same facet
//   class      ordinal tier of the issuing source (a presentation-priority ladder, NOT trustworthiness or accuracy)
//   geo        how closely the evidence's stated scope fits the signal's place (a ladder; wrong place is excluded)
//   temporal   whether the evidence is in force and, for time-sensitive kinds only, how recent it is
import { hashJson } from "../hash";
import { SOURCE_CLASS_TIERS, type SourceClass } from "../vocab";

export const RANKING_VERSION = "ranking/1.0.0";

export const RANK_NOTICE =
  "The rank score represents presentation priority for a verifier, not the probability that an evidence item is correct. It is not a probability of a real outbreak, not a diagnosis, and not a statement that any source is accurate.";

export const TIER_LABELS: Record<SourceClass, string> = {
  intergovernmental_health_authority: "Intergovernmental health authority",
  national_government_health_agency: "National government health agency",
  state_government_health_agency: "State government health agency",
  peer_reviewed_literature: "Peer-reviewed literature",
  recognized_institution: "Recognized institution",
  professional_society_guideline: "Professional society guideline",
  other_verified: "Other verified source",
  unverified: "Unverified source",
};

/** Geography specificity, used only as a dedup / tie-break preference (never as a probability). */
export const GEO_SPECIFICITY: Record<string, number> = { district: 5, state: 4, national: 3, regional: 2, global: 1 };

export type GeoLevel = "district" | "state" | "national" | "regional" | "global";

export interface AgeBucket {
  /** Inclusive upper bound in days; null = no upper bound. */
  maxDays: number | null;
  factor: number;
}

export interface RankingConfig {
  version: string;
  notice: string;
  relevance: { method: string; formula: string; emptySet: string; zeroMaximum: string; floor: number; floorMeaning: string };
  classFactor: { meaning: string; basis: string; table: Record<SourceClass, number | null> };
  geoFactor: { meaning: string; table: Record<GeoLevel, number>; hardExclusion: string };
  temporalFactor: {
    meaning: string;
    hardExclusions: readonly string[];
    expiryKinds: readonly string[];
    noDecayKinds: readonly string[];
    ageDecayKinds: readonly string[];
    neutralKinds: readonly string[];
    ageBasis: string;
    ageBuckets: readonly AgeBucket[];
    unknownAge: string;
  };
  dedup: { order: readonly string[]; shingleSize: number; jaccardThreshold: { numerator: number; denominator: number }; retention: readonly string[] };
  diversity: { maxChunksPerDocument: number; maxChunksPerPublisher: number };
  selection: { topKPerFacet: number; historicalTopKPerFacet: number; historicalMaxChunksPerDocument: number };
  tieBreak: { version: string; order: readonly string[] };
  precision: number;
}

/**
 * Source-class ladder: the ORDER is the M4 plan's tier order (SOURCE_CLASS_TIERS, M4.0). The plan calls the factor
 * "a small discrete factor" without values; the numeric spacing (0.05 per tier, 1.00 down to 0.70) is a policy choice
 * introduced in M4.3 and matches the span of the geography ladder. `unverified` is never ranked.
 */
export function defaultClassTable(): Record<SourceClass, number | null> {
  const table = {} as Record<SourceClass, number | null>;
  SOURCE_CLASS_TIERS.forEach((c, i) => {
    table[c] = c === "unverified" ? null : Math.round((1 - 0.05 * i) * 100) / 100;
  });
  return table;
}

export function makeRankingConfig(opts: { classTable?: Record<SourceClass, number | null>; relevanceFloor?: number; topK?: number } = {}): RankingConfig {
  return {
    version: RANKING_VERSION,
    notice: RANK_NOTICE,
    relevance: {
      method: "max_normalisation_within_facet_candidate_set",
      formula: "bm25 / max(bm25 over the facet's M4.2 candidates)",
      emptySet: "no candidates, nothing to normalise",
      zeroMaximum: "if the maximum is 0 every relevance is 0 (never NaN)",
      floor: opts.relevanceFloor ?? 0.1,
      floorMeaning: "a candidate whose normalised relevance is below the floor is not presented (policy constant, not tuned)",
    },
    classFactor: {
      meaning: "ordinal presentation priority of the issuing source's class; not trustworthiness, accuracy or probability",
      basis: "tier order of SOURCE_CLASS_TIERS; numeric spacing is a policy choice",
      table: opts.classTable ?? defaultClassTable(),
    },
    geoFactor: {
      meaning: "how closely the evidence's stated geographic scope fits the signal's place",
      table: { district: 1.0, state: 1.0, national: 0.85, regional: 0.7, global: 0.7 },
      hardExclusion: "state or district evidence outside the signal's own region chain is excluded, never down-weighted",
    },
    temporalFactor: {
      meaning: "whether the evidence is in force and, for time-sensitive kinds only, how recent it is; newest is not best",
      hardExclusions: ["withdrawn", "superseded", "historical", "not_current", "look_ahead", "not_yet_valid", "expired"],
      expiryKinds: ["operational_guidance", "case_definition"],
      noDecayKinds: ["operational_guidance", "case_definition", "clinical_epidemiology_reference"],
      ageDecayKinds: ["situation_report", "surveillance_data"],
      neutralKinds: ["research"],
      ageBasis: "days from publication_date (else valid_from) to the signal's as-of date",
      ageBuckets: [
        { maxDays: 90, factor: 1.0 },
        { maxDays: 365, factor: 0.6 },
        { maxDays: null, factor: 0.3 },
      ],
      unknownAge: "oldest bucket (0.3), recorded with reason age_unknown_oldest_bucket",
    },
    dedup: {
      order: ["same_canonical_id", "same_content_hash", "same_chunk_hash", "near_duplicate"],
      shingleSize: 3,
      jaccardThreshold: { numerator: 17, denominator: 20 },
      retention: ["higher_source_tier", "more_specific_geography", "higher_rank_score", "higher_bm25", "canonical_id", "chunk_ordinal", "chunk_id"],
    },
    diversity: { maxChunksPerDocument: 2, maxChunksPerPublisher: 3 },
    selection: { topKPerFacet: opts.topK ?? 5, historicalTopKPerFacet: 2, historicalMaxChunksPerDocument: 1 },
    tieBreak: {
      version: "rank-tiebreak/1.0.0",
      order: ["rank_score_desc", "source_tier_asc", "geo_specificity_desc", "bm25_desc", "canonical_id_asc", "chunk_ordinal_asc", "chunk_id_asc"],
    },
    precision: 12,
  };
}

export const RANKING_CONFIG_V1: RankingConfig = makeRankingConfig();
export const rankingConfigHash = (cfg: RankingConfig): string => hashJson(cfg);

export const roundRank = (x: number, digits = 12): number => (x === 0 ? 0 : Number(x.toPrecision(digits)));
