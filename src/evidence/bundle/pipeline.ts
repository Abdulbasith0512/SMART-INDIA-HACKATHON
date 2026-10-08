// Database-backed convenience: signal id -> facts -> M4.2 retrieval (main + historical pass) -> M4.3 ranking ->
// canonical bundle -> (optionally) persisted bundle + extractive fallback. Reads evidence tables, regions and the stored
// candidate (named columns); writes only through persistBundle. No model, no network.
import type { EvidenceDb } from "../ingest/ingest";
import { historicalRetrievalConfig } from "../ranking/pipeline";
import { rankEvidence } from "../ranking/rank";
import type { RankingConfig } from "../ranking/policy";
import type { RetrievalConfig } from "../retrieval/config";
import { loadCorpusView } from "../retrieval/corpus";
import { retrieveFromCorpus, type RetrievalOptions } from "../retrieval/retrieve";
import { loadSignalFacts } from "../retrieval/signal";
import { buildBundle } from "./build";
import { loadSignalIdentity, persistBundle, type PersistOptions, type PersistResult } from "./persist";
import type { EvidenceBundle } from "./types";

export interface BundleOptions extends RetrievalOptions {
  retrievedAt?: string;
}

export async function buildBundleForSignal(
  db: EvidenceDb, signalId: string, retrievalConfig: RetrievalConfig, rankingConfig?: RankingConfig, options: BundleOptions = {},
): Promise<EvidenceBundle | null> {
  const facts = await loadSignalFacts(db, signalId);
  if (!facts) return null;
  const identity = await loadSignalIdentity(db, signalId);
  const view = await loadCorpusView(db, { textStatuses: retrievalConfig.eligibility.statuses });
  const historicalView = await loadCorpusView(db, { textStatuses: ["superseded", "historical"] });
  const retrieval = retrieveFromCorpus(view, facts, retrievalConfig, { asOfDate: options.asOfDate });
  const historical = retrieveFromCorpus(historicalView, facts, historicalRetrievalConfig(retrievalConfig), { asOfDate: options.asOfDate });
  const ranking = rankEvidence({ facts, retrieval, historical, view, config: rankingConfig });
  return buildBundle({ facts, identity, retrieval, ranking, retrievedAt: options.retrievedAt });
}

export async function bundleSignal(
  db: EvidenceDb, signalId: string, retrievalConfig: RetrievalConfig, rankingConfig?: RankingConfig, options: BundleOptions = {}, persist: PersistOptions = {},
): Promise<{ bundle: EvidenceBundle; persisted: PersistResult } | null> {
  const bundle = await buildBundleForSignal(db, signalId, retrievalConfig, rankingConfig, options);
  if (!bundle) return null;
  return { bundle, persisted: await persistBundle(db, bundle, persist) };
}
