// The retrieval configuration: everything that can change what the retrieval engine returns, in one explicit,
// versioned object with a canonical SHA-256. Identical configuration => identical hash. Any change to a value
// (or a deliberate version bump) changes the hash, so stored results can always say exactly how they were made.
import { hashJson } from "../hash";
import { QUERY_VOCAB_VERSION } from "../vocab";
import { BM25_B, BM25_K1, SCORE_PRECISION } from "./bm25";
import { QUERY_CONFIG_VERSION, QUERY_STOP_WORDS } from "./queryConfig";
import { TOKENIZER_VERSION } from "./tokenize";

export const RETRIEVAL_VERSION = "retrieval/1.0.0";
export const ELIGIBILITY_VERSION = "eligibility/1.0.0";
export const TIE_BREAK_VERSION = "tiebreak/1.0.0";

export interface EligibilityPolicy {
  version: string;
  /** Only documents in one of these statuses may compete (M4.2: `current` only). */
  statuses: readonly string[];
  /** Minimum categorical trust level (`reviewed` or `trusted`). */
  minTrust: "reviewed" | "trusted";
  excludedSourceClasses: readonly string[];
  /** Languages for which the query vocabulary has terms. Cross-lingual retrieval is not provided. */
  languages: readonly string[];
  /** Development/test environments opt in to synthetic documents; production leaves this false. */
  allowSynthetic: boolean;
  /** Source versions whose last link check failed never compete. */
  excludedFetchStatuses: readonly string[];
  /**
   * Binary temporal eligibility (NOT scoring): no look-ahead past the signal's as-of date, not-yet-valid
   * documents excluded, and documents of these kinds are excluded once `valid_until` has passed.
   */
  temporal: { noLookAhead: boolean; expiryKinds: readonly string[] };
}

export interface RetrievalConfig {
  version: string;
  bm25: {
    k1: number;
    b: number;
    idf: string;
    statisticsScope: string;
    duplicateQueryTerms: string;
    minimumScore: string;
  };
  tokenization: { version: string; normalization: string; caseFolding: string; tokenPattern: string; stemming: string; stopwords: string };
  queryVocabulary: { version: string; configVersion: string; queryStopWords: readonly string[] };
  eligibility: EligibilityPolicy;
  tieBreak: { version: string; order: readonly string[]; scorePrecision: number; numericEquality: string };
}

export function makeRetrievalConfig(opts: { allowSynthetic: boolean }): RetrievalConfig {
  return {
    version: RETRIEVAL_VERSION,
    bm25: {
      k1: BM25_K1,
      b: BM25_B,
      idf: "ln(1 + (N - n + 0.5) / (n + 0.5))",
      statisticsScope: "chunks of eligible documents, per facet",
      duplicateQueryTerms: "counted once",
      minimumScore: "> 0 (at least one query term matched)",
    },
    tokenization: {
      version: TOKENIZER_VERSION,
      normalization: "NFKC",
      caseFolding: "String.prototype.toLowerCase",
      tokenPattern: "[\\p{L}\\p{M}\\p{N}]+",
      stemming: "none",
      stopwords: "none",
    },
    queryVocabulary: { version: QUERY_VOCAB_VERSION, configVersion: QUERY_CONFIG_VERSION, queryStopWords: QUERY_STOP_WORDS },
    eligibility: {
      version: ELIGIBILITY_VERSION,
      statuses: ["current"],
      minTrust: "reviewed",
      excludedSourceClasses: ["unverified"],
      languages: ["en"],
      allowSynthetic: opts.allowSynthetic,
      excludedFetchStatuses: ["changed", "unreachable"],
      temporal: { noLookAhead: true, expiryKinds: ["operational_guidance", "case_definition"] },
    },
    tieBreak: {
      version: TIE_BREAK_VERSION,
      order: ["bm25_score_desc", "canonical_id_asc", "chunk_ordinal_asc", "chunk_id_asc"],
      scorePrecision: SCORE_PRECISION,
      numericEquality: "scores are rounded to scorePrecision significant digits before comparison",
    },
  };
}

/** Production default: synthetic documents are NOT eligible. */
export const RETRIEVAL_CONFIG_V1: RetrievalConfig = makeRetrievalConfig({ allowSynthetic: false });
/** Development / test: the explicitly synthetic development corpus may compete. */
export const RETRIEVAL_CONFIG_DEV: RetrievalConfig = makeRetrievalConfig({ allowSynthetic: true });

export const retrievalConfigHash = (cfg: RetrievalConfig): string => hashJson(cfg);
