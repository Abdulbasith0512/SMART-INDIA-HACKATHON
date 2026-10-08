// Public surface of the M4.3 ranking stage.
export { detectConflicts, contradictingDocuments, CONTRADICTS_SIGNAL } from "./conflicts";
export type { ConflictTag } from "./conflicts";
export { findDuplicate, jaccard, meetsThreshold, shingleSet } from "./dedup";
export { assessClass, assessGeography, assessTemporal, daysBetween, normaliseRelevance } from "./factors";
export { computeGaps, regionLabel } from "./gaps";
export { historicalRetrievalConfig, rankForSignal, retrieveAndRank } from "./pipeline";
export { RANKING_CONFIG_V1, RANKING_VERSION, RANK_NOTICE, TIER_LABELS, defaultClassTable, makeRankingConfig, rankingConfigHash } from "./policy";
export type { RankingConfig } from "./policy";
export { comparePresentation, rankEvidence } from "./rank";
export type { RankInput } from "./rank";
export { analyseSensitivity, buildPerturbations, kendallTau } from "./sensitivity";
export type { SensitivityReport } from "./sensitivity";
export { FAMILY_OF, RANKING_SCHEMA } from "./types";
export type { ConflictEntry, ExclusionReason, Gap, GapCode, HistoricalEntry, RankedCandidate, RankedEvidence, RankedFacet, RankingExclusion, ScoreComponents } from "./types";
