// Database-backed convenience: signal id -> SignalFacts -> M4.2 retrieval (main + historical pass) -> M4.3 ranking.
// Reads only the evidence tables, regions and the stored candidate (named columns). Writes nothing.
import type { EvidenceDb } from "../ingest/ingest";
import { loadCorpusView, type CorpusView } from "../retrieval/corpus";
import type { RetrievalConfig } from "../retrieval/config";
import { retrieveFromCorpus, type RetrievalOptions } from "../retrieval/retrieve";
import { loadSignalFacts, type SignalFacts } from "../retrieval/signal";
import { rankEvidence } from "./rank";
import type { RankingConfig } from "./policy";
import type { RankedEvidence } from "./types";

/**
 * The M4.2 configuration for the historical pass: the same engine with only the status policy widened to
 * superseded / historical documents, and the expiry rule switched off (an old edition has, by definition, expired).
 * No retrieval semantics change; it is the existing configuration surface.
 */
export function historicalRetrievalConfig(cfg: RetrievalConfig): RetrievalConfig {
  return { ...cfg, eligibility: { ...cfg.eligibility, statuses: ["superseded", "historical"], temporal: { ...cfg.eligibility.temporal, expiryKinds: [] } } };
}

export interface PipelineInput {
  facts: SignalFacts;
  /** Main view: text of current documents. */
  view: CorpusView;
  /** Historical view: text of superseded / historical documents. Omit to skip historical context. */
  historicalView?: CorpusView | null;
  retrievalConfig: RetrievalConfig;
  rankingConfig?: RankingConfig;
  options?: RetrievalOptions;
}

/** Pure: two retrieval passes over in-memory views, then ranking. */
export function retrieveAndRank(input: PipelineInput): RankedEvidence {
  const retrieval = retrieveFromCorpus(input.view, input.facts, input.retrievalConfig, input.options);
  const historical = input.historicalView ? retrieveFromCorpus(input.historicalView, input.facts, historicalRetrievalConfig(input.retrievalConfig), input.options) : null;
  return rankEvidence({ facts: input.facts, retrieval, historical, view: input.view, config: input.rankingConfig });
}

export async function rankForSignal(
  db: EvidenceDb, signalId: string, retrievalConfig: RetrievalConfig, rankingConfig?: RankingConfig, options: RetrievalOptions = {},
): Promise<RankedEvidence | null> {
  const facts = await loadSignalFacts(db, signalId);
  if (!facts) return null;
  const view = await loadCorpusView(db, { textStatuses: retrievalConfig.eligibility.statuses });
  const historicalView = await loadCorpusView(db, { textStatuses: ["superseded", "historical"] });
  return retrieveAndRank({ facts, view, historicalView, retrievalConfig, rankingConfig, options });
}
