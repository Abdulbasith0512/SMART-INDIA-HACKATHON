// Test helpers for the bundle (not a test file): reference bundle builders over the committed SYNTHETIC development
// corpus, and a metadata resolver that mirrors what the database would return for the same ids.
import { RETRIEVAL_CONFIG_DEV } from "../retrieval/config";
import type { CorpusSnapshotRef, CorpusView } from "../retrieval/corpus";
import { retrieveFromCorpus } from "../retrieval/retrieve";
import type { SignalFacts } from "../retrieval/signal";
import { devPrepared, historicalViewFromPrepared, makeFacts, uid, viewFromPrepared } from "../retrieval/testkit";
import { historicalRetrievalConfig } from "../ranking/pipeline";
import type { RankingConfig } from "../ranking/policy";
import { rankEvidence } from "../ranking/rank";
import { buildBundle, type SignalIdentity } from "./build";
import type { CitationMetadata, MetadataResolver } from "./fallback";
import type { EvidenceBundle } from "./types";

export const RETRIEVED_AT = "2026-01-01T00:00:00.000Z";
export const IDENTITY: SignalIdentity = { episodeKey: "e".repeat(64), detectorVersion: "test-detector/1.0.0" };
export const CORPUS_HASH = "a66e0364a6b0c216381cfa9a6f0db846aa672f4b918587592cbcfe2ddfd497d2";
export const SNAPSHOT: CorpusSnapshotRef = { id: uid("snapshot:dev"), corpusHash: CORPUS_HASH, corpusVersion: `jansanket-dev-corpus+${CORPUS_HASH.slice(0, 12)}` };

/** Source metadata for every dev-corpus version, exactly what the database holds for the same ids. */
export function devMetadata(): Map<string, CitationMetadata> {
  const out = new Map<string, CitationMetadata>();
  for (const p of devPrepared()) {
    const id = uid(`version:${p.doc.canonical_id}`);
    out.set(id, {
      evidence_version_id: id, title: p.fields.title, publisher: p.fields.publisher, source_type: p.doc.source_type, reference_url: p.doc.reference_url,
      citation: p.fields.citation, publication_date: p.doc.publication_date, licence: p.fields.licence, is_synthetic: p.doc.is_synthetic,
    });
  }
  return out;
}
export const devResolver = (): MetadataResolver => {
  const m = devMetadata();
  return (id) => m.get(id);
};

export interface RefOptions {
  facts?: SignalFacts;
  view?: CorpusView;
  historicalView?: CorpusView | null;
  snapshot?: CorpusSnapshotRef | null;
  ranking?: RankingConfig;
  asOfDate?: string;
  identity?: SignalIdentity;
}

/** Retrieve -> rank -> bundle over in-memory views. The default is the reference bundle (with a pinned corpus snapshot). */
export function referenceBundle(o: RefOptions = {}): EvidenceBundle {
  const facts = o.facts ?? makeFacts();
  const snapshot = o.snapshot === undefined ? SNAPSHOT : o.snapshot;
  const base = o.view ?? viewFromPrepared();
  const view: CorpusView = { ...base, activeSnapshot: snapshot };
  const retrieval = retrieveFromCorpus(view, facts, RETRIEVAL_CONFIG_DEV, { asOfDate: o.asOfDate });
  const hv = o.historicalView === undefined ? historicalViewFromPrepared() : o.historicalView;
  const historical = hv ? retrieveFromCorpus({ ...hv, activeSnapshot: snapshot }, facts, historicalRetrievalConfig(RETRIEVAL_CONFIG_DEV), { asOfDate: o.asOfDate }) : null;
  const ranking = rankEvidence({ facts, retrieval, historical, view, config: o.ranking });
  return buildBundle({ facts, identity: o.identity ?? IDENTITY, retrieval, ranking, retrievedAt: RETRIEVED_AT });
}
