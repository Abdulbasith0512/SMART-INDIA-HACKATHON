// Public surface of the M4.2 retrieval engine.
export { Bm25Index, BM25_B, BM25_K1, SCORE_PRECISION, roundScore } from "./bm25";
export type { Bm25Doc, Bm25Hit, IndexStats, TermMatch } from "./bm25";
export { RETRIEVAL_CONFIG_DEV, RETRIEVAL_CONFIG_V1, RETRIEVAL_VERSION, makeRetrievalConfig, retrievalConfigHash } from "./config";
export type { EligibilityPolicy, RetrievalConfig } from "./config";
export { corpusDigest, itemKey, loadCorpusView } from "./corpus";
export type { CorpusChunk, CorpusItem, CorpusSnapshotRef, CorpusView } from "./corpus";
export { evaluateEligibility } from "./eligibility";
export type { Eligibility, EligibilityContext, ExclusionReason, GeoMatch } from "./eligibility";
export { buildFacetQuery, buildQuery } from "./query";
export type { FacetQuery, RetrievalQuery } from "./query";
export { QUERY_CONFIG_VERSION } from "./queryConfig";
export { RESULT_SCHEMA, retrieveCandidates, retrieveForSignal, retrieveFromCorpus } from "./retrieve";
export type { Candidate, CandidateMetadata, ExclusionEntry, FacetResult, RetrievalOptions, RetrievalResult } from "./retrieve";
export { loadSignalFacts, signalFactsFromCandidate, signalFactsSchema } from "./signal";
export type { SignalFacts } from "./signal";
export { TOKENIZER_VERSION, tokenize } from "./tokenize";
