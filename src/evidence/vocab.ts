// M4 evidence vocabulary: controlled topics, source tiers, and the deterministic syndrome -> query-term map.
// Evidence is DATA. This file is configuration only: no I/O, no model calls.
// The DB seeds `evidence_topics` with the same codes (a DB test asserts parity).

export const QUERY_VOCAB_VERSION = "query-vocab/1.0.0";

export const EVIDENCE_TOPICS = [
  "diarrhoeal_disease", "enteric_infections", "jaundice_hepatitis", "rash_illness", "respiratory_illness",
  "fever_illness", "outbreak_investigation", "case_definition", "water_sanitation", "vector_borne_context",
  "monsoon_seasonality", "surveillance_methods", "outbreak_response",
] as const;
export type EvidenceTopic = (typeof EVIDENCE_TOPICS)[number];

/** Issuer classes in presentation-tier order (lower index = presented first). A tier, not a probability. */
export const SOURCE_CLASS_TIERS = [
  "intergovernmental_health_authority",
  "national_government_health_agency",
  "state_government_health_agency",
  "peer_reviewed_literature",
  "recognized_institution",
  "professional_society_guideline",
  "other_verified",
  "unverified",
] as const;
export type SourceClass = (typeof SOURCE_CLASS_TIERS)[number];

/** Classes that may ever be retrieved. `unverified` never is. */
export const RETRIEVABLE_SOURCE_CLASSES: readonly SourceClass[] = SOURCE_CLASS_TIERS.filter((c) => c !== "unverified");

export const EVIDENCE_STATUSES = ["draft", "quarantined", "current", "superseded", "withdrawn", "historical"] as const;
export const EVIDENCE_KINDS = [
  "operational_guidance", "case_definition", "clinical_epidemiology_reference", "situation_report", "surveillance_data", "research",
] as const;
export const GEO_SCOPES = ["global", "regional", "national", "state", "district"] as const;

export type QueryFacet = "verification_guidance" | "case_definition" | "epidemiological_context" | "regional_context";

export interface SyndromeQuerySpec {
  /** Topic codes the facet may match (metadata filter). */
  topics: Record<QueryFacet, readonly EvidenceTopic[]>;
  /** Controlled lexical terms (English) used by the ranker. Family-level only: never a diagnosis. */
  terms: readonly string[];
}

/**
 * Deterministic syndrome -> query vocabulary. `epidemiological_context` terms describe condition FAMILIES that
 * are associated with a syndrome in public-health references; they are context for a verifier, never a diagnosis.
 */
export const SYNDROME_QUERY: Record<string, SyndromeQuerySpec> = {
  acute_diarrhoeal_illness: {
    topics: {
      verification_guidance: ["outbreak_investigation", "surveillance_methods", "outbreak_response"],
      case_definition: ["case_definition", "diarrhoeal_disease"],
      epidemiological_context: ["diarrhoeal_disease", "enteric_infections"],
      regional_context: ["water_sanitation", "monsoon_seasonality"],
    },
    terms: ["acute diarrhoeal disease", "acute watery diarrhoea", "diarrhoea outbreak", "waterborne", "enteric", "oral rehydration", "water contamination"],
  },
  fever: {
    topics: {
      verification_guidance: ["outbreak_investigation", "surveillance_methods", "outbreak_response"],
      case_definition: ["case_definition", "fever_illness"],
      epidemiological_context: ["fever_illness", "vector_borne_context"],
      regional_context: ["monsoon_seasonality", "vector_borne_context"],
    },
    terms: ["acute undifferentiated fever", "fever cluster", "febrile illness", "vector-borne", "fever surveillance"],
  },
  fever_with_rash: {
    topics: {
      verification_guidance: ["outbreak_investigation", "surveillance_methods", "outbreak_response"],
      case_definition: ["case_definition", "rash_illness"],
      epidemiological_context: ["rash_illness", "fever_illness"],
      regional_context: ["monsoon_seasonality"],
    },
    terms: ["fever with rash", "febrile rash illness", "rash cluster", "rash surveillance", "exanthematous"],
  },
  jaundice: {
    topics: {
      verification_guidance: ["outbreak_investigation", "surveillance_methods", "outbreak_response"],
      case_definition: ["case_definition", "jaundice_hepatitis"],
      epidemiological_context: ["jaundice_hepatitis", "enteric_infections"],
      regional_context: ["water_sanitation", "monsoon_seasonality"],
    },
    terms: ["acute jaundice syndrome", "jaundice cluster", "viral hepatitis", "hepatitis outbreak", "waterborne hepatitis"],
  },
  respiratory_illness: {
    topics: {
      verification_guidance: ["outbreak_investigation", "surveillance_methods", "outbreak_response"],
      case_definition: ["case_definition", "respiratory_illness"],
      epidemiological_context: ["respiratory_illness"],
      regional_context: ["monsoon_seasonality"],
    },
    terms: ["acute respiratory infection", "influenza-like illness", "respiratory cluster", "severe acute respiratory infection", "respiratory surveillance"],
  },
};

export const QUERY_FACETS: readonly QueryFacet[] = ["verification_guidance", "case_definition", "epidemiological_context", "regional_context"];
