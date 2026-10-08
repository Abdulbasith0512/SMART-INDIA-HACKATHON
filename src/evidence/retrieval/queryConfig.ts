// Versioned controlled vocabulary for query construction (M4.2). It COMPLEMENTS the M4.0 syndrome -> topic/term
// map in ../vocab.ts (QUERY_VOCAB_VERSION) rather than replacing it: vocab.ts says which syndromes exist and
// which topics/terms belong to them; this file adds the facet wording, the calendar-season mapping and the
// signal-characteristic variants. Everything here is a fixed, reviewable constant: no model, no free text, no
// user input. Changing ANY value requires bumping QUERY_CONFIG_VERSION (it is part of the retrieval config hash).
//
// Terms are English. Cross-lingual retrieval is not provided: see eligibility `languages`.
// Function words (e.g. the "with" in the M4.0 term "fever with rash") would make nearly every chunk a weak
// candidate, so QUERY_STOP_WORDS are dropped from QUERY tokens only. Documents are always indexed in full, and
// the tokenizer itself removes nothing; no stemming is claimed. The list is part of the retrieval config hash.
import type { QueryFacet } from "../vocab";

export const QUERY_CONFIG_VERSION = "query-config/1.0.0";

/** English function words removed from query tokens (sorted; versioned with QUERY_CONFIG_VERSION). */
export const QUERY_STOP_WORDS: readonly string[] = ["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "of", "on", "or", "that", "the", "this", "to", "with"];

/** Facet wording: what each facet is looking for, independent of the syndrome. */
export const FACET_BASE_TERMS: Record<QueryFacet, readonly string[]> = {
  verification_guidance: ["verifying reported cluster", "verification procedure", "investigation", "line list", "contact reporting facilities", "expected seasonal level"],
  case_definition: ["case definition", "suspected case", "working definition", "cluster definition"],
  epidemiological_context: ["condition families", "context verifier", "syndromic signal", "diagnosis"],
  regional_context: ["seasonal factors", "local teams", "water safety", "sanitation", "monsoon months"],
};

/** Calendar seasons (IMD convention). A calendar mapping only; it says nothing about actual weather. */
export type Season = "winter" | "pre_monsoon" | "monsoon" | "post_monsoon";
export const SEASON_BY_MONTH: Record<number, Season> = {
  1: "winter", 2: "winter", 3: "pre_monsoon", 4: "pre_monsoon", 5: "pre_monsoon", 6: "monsoon", 7: "monsoon", 8: "monsoon", 9: "monsoon",
  10: "post_monsoon", 11: "post_monsoon", 12: "post_monsoon",
};
export const SEASON_TERMS: Record<Season, readonly string[]> = {
  winter: ["winter"],
  pre_monsoon: ["pre-monsoon", "summer", "heat"],
  monsoon: ["monsoon", "rainy season", "rainfall"],
  post_monsoon: ["post-monsoon"],
};

/** Signal characteristics (from M3 score components only) select optional wording. */
export type Spread = "single_block" | "multi_block" | "district_wide" | "unknown";
export type Persistence = "emerging" | "sustained" | "unknown";

export const CHARACTERISTIC_THRESHOLDS = {
  /** persistence component = share of window days that were elevated; at or above this the signal is "sustained". */
  sustainedPersistence: 0.75,
  /** involved blocks / blocks in the district at or above this share is "district_wide". */
  districtWideShare: 0.5,
} as const;

export const SPREAD_TERMS: Record<Spread, Partial<Record<QueryFacet, readonly string[]>>> = {
  single_block: { verification_guidance: ["single block", "local cluster"], regional_context: ["block"] },
  multi_block: { verification_guidance: ["several blocks", "neighbouring blocks"], regional_context: ["blocks", "district"] },
  district_wide: { verification_guidance: ["district wide", "widespread"], regional_context: ["district"] },
  unknown: {},
};

export const PERSISTENCE_TERMS: Record<Persistence, Partial<Record<QueryFacet, readonly string[]>>> = {
  emerging: { verification_guidance: ["early", "initial review"] },
  sustained: { verification_guidance: ["ongoing", "persistent", "sustained"] },
  unknown: {},
};

export function seasonOf(isoDate: string): Season {
  const month = Number(isoDate.slice(5, 7));
  const season = SEASON_BY_MONTH[month];
  if (!season) throw new RangeError(`not an ISO date: ${isoDate}`);
  return season;
}
