// Retrieval: SignalFacts -> controlled query -> metadata eligibility -> BM25 -> deterministically ordered
// candidates, per facet. This is the end of M4.2. It deliberately does NOT rank by source class, geography or
// age, deduplicate, enforce diversity, detect conflicts, report gaps or assemble a bundle (M4.3 / M4.4), and it
// never calls a model or the network.
//
// Reproducibility: same SignalFacts + same corpus content + same configuration => same query, same candidates,
// same scores, same order. `resultHash` is content-addressed (no database UUIDs, no timestamps), so two
// databases holding the same corpus produce the same hash.
//
// A candidate's bm25Score is a lexical-match strength inside one facet's candidate pool. It is NOT a probability,
// NOT a measure of truth or of relevance to the real situation, and not comparable across facets.
import { hashJson } from "../hash";
import type { EvidenceDb } from "../ingest/ingest";
import { Bm25Index, type IndexStats, type TermMatch } from "./bm25";
import { makeRetrievalConfig, retrievalConfigHash, type RetrievalConfig } from "./config";
import { corpusDigest, itemKey, loadCorpusView, type CorpusItem, type CorpusSnapshotRef, type CorpusView } from "./corpus";
import { evaluateEligibility, type ExclusionReason, type GeoMatch } from "./eligibility";
import { buildQuery, type FacetQuery, type RetrievalQuery } from "./query";
import { loadSignalFacts, signalFactsSchema, type SignalFacts } from "./signal";
import { compareCodePoints, tokenize } from "./tokenize";
import type { QueryFacet } from "../vocab";

export const RESULT_SCHEMA = "retrieval-result/1";

/** Everything M4.3 needs about a candidate, with no ranking decision applied. */
export interface CandidateMetadata {
  title: string;
  publisher: string;
  sourceClass: string;
  evidenceKind: string | null;
  trustLevel: string;
  status: string;
  topics: string[];
  syndromes: string[];
  geoScope: string | null;
  geoRegionId: string | null;
  geoMatch: GeoMatch;
  language: string | null;
  publicationDate: string | null;
  validFrom: string | null;
  validUntil: string | null;
  isSynthetic: boolean;
  supersedesId: string | null;
}

export interface Candidate {
  facet: QueryFacet;
  /** 1-based position within the facet after the deterministic ordering. */
  rank: number;
  evidenceItemId: string;
  canonicalId: string | null;
  evidenceVersionId: string;
  versionContentHash: string;
  chunkId: string;
  chunkOrdinal: number;
  chunkKind: string;
  chunkHash: string;
  chunkLanguage: string;
  text: string;
  /** Lexical match strength (BM25) within this facet's eligible pool. Not a probability. */
  bm25Score: number;
  matchedTerms: TermMatch[];
  metadata: CandidateMetadata;
}

export interface ExclusionEntry {
  evidenceItemId: string;
  canonicalId: string | null;
  reasons: ExclusionReason[];
}

export interface FacetResult {
  facet: QueryFacet;
  query: FacetQuery;
  candidates: Candidate[];
  excluded: ExclusionEntry[];
  stats: { documentsConsidered: number; documentsEligible: number; chunksIndexed: number; chunksMatched: number; index: IndexStats };
}

export interface RetrievalResult {
  schema: typeof RESULT_SCHEMA;
  signalId: string;
  asOfDate: string;
  config: { version: string; hash: string };
  query: { hash: string; vocabVersion: string; configVersion: string };
  corpus: { digest: string; activeSnapshot: CorpusSnapshotRef | null; documents: number };
  facets: FacetResult[];
  /** Content-addressed fingerprint of the whole result (excludes database ids and timestamps). */
  resultHash: string;
}

export interface RetrievalOptions {
  /** Defaults to the signal window's last day. Pass explicitly for retrospective runs. */
  asOfDate?: string;
}

interface Scored extends Candidate {
  sortKey: string;
}

function order(a: Scored, b: Scored): number {
  // bm25_score desc, canonical_id (or item id) asc, chunk ordinal asc, chunk id asc: a total order built only from
  // stable identifiers, never from row order.
  return b.bm25Score - a.bm25Score || compareCodePoints(a.sortKey, b.sortKey) || a.chunkOrdinal - b.chunkOrdinal || compareCodePoints(a.chunkId, b.chunkId);
}

function metadataOf(i: CorpusItem, geoMatch: GeoMatch): CandidateMetadata {
  return {
    title: i.title, publisher: i.publisher, sourceClass: i.sourceClass, evidenceKind: i.evidenceKind, trustLevel: i.trustLevel, status: i.status,
    topics: [...i.topics].sort(compareCodePoints), syndromes: [...i.syndromes].sort(compareCodePoints), geoScope: i.geoScope, geoRegionId: i.geoRegionId,
    geoMatch, language: i.language, publicationDate: i.publicationDate, validFrom: i.validFrom, validUntil: i.validUntil, isSynthetic: i.isSynthetic,
    supersedesId: i.supersedesId,
  };
}

/** Pure retrieval over an in-memory corpus view. No I/O. */
export function retrieveFromCorpus(view: CorpusView, rawFacts: SignalFacts, cfg: RetrievalConfig, opts: RetrievalOptions = {}): RetrievalResult {
  const facts = signalFactsSchema.parse(rawFacts); // strict: refuses anything beyond the allowed signal facts
  const query: RetrievalQuery = buildQuery(facts, { asOfDate: opts.asOfDate });
  const regionChain = [{ id: facts.region.id, level: facts.region.level }, ...facts.ancestors.map((a) => ({ id: a.id, level: a.level }))];
  const ctx = { syndrome: facts.syndrome, regionChain, asOfDate: query.asOfDate };
  const items = [...view.items].sort((a, b) => compareCodePoints(itemKey(a), itemKey(b)) || compareCodePoints(a.id, b.id));

  const facets: FacetResult[] = query.facets.map((fq) => {
    const excluded: ExclusionEntry[] = [];
    const docs: Array<{ key: string; tokens: string[] }> = [];
    const byChunk = new Map<string, { item: CorpusItem; chunk: CorpusItem["chunks"][number]; geoMatch: GeoMatch }>();
    let eligibleDocs = 0;
    for (const item of items) {
      const e = evaluateEligibility(item, fq.topics, ctx, cfg.eligibility);
      if (e.eligible === false) {
        excluded.push({ evidenceItemId: item.id, canonicalId: item.canonicalId, reasons: e.reasons });
        continue;
      }
      eligibleDocs += 1;
      for (const chunk of item.chunks) {
        if (!cfg.eligibility.languages.includes(chunk.language)) continue;
        docs.push({ key: chunk.id, tokens: tokenize(chunk.text) });
        byChunk.set(chunk.id, { item, chunk, geoMatch: e.geoMatch });
      }
    }
    const index = new Bm25Index(docs, { k1: cfg.bm25.k1, b: cfg.bm25.b });
    const scored: Scored[] = index.search(fq.tokens).map((h) => {
      const { item, chunk, geoMatch } = byChunk.get(h.key)!;
      return {
        facet: fq.facet, rank: 0, evidenceItemId: item.id, canonicalId: item.canonicalId, evidenceVersionId: item.version!.id,
        versionContentHash: item.version!.contentHash, chunkId: chunk.id, chunkOrdinal: chunk.ordinal, chunkKind: chunk.kind, chunkHash: chunk.chunkHash,
        chunkLanguage: chunk.language, text: chunk.text, bm25Score: h.score, matchedTerms: h.matched, metadata: metadataOf(item, geoMatch), sortKey: itemKey(item),
      };
    });
    scored.sort(order);
    const candidates: Candidate[] = scored.map(({ sortKey: _sortKey, ...c }, i) => ({ ...c, rank: i + 1 }));
    return {
      facet: fq.facet,
      query: fq,
      candidates,
      excluded,
      stats: { documentsConsidered: items.length, documentsEligible: eligibleDocs, chunksIndexed: docs.length, chunksMatched: candidates.length, index: index.stats(fq.tokens) },
    };
  });

  const digest = corpusDigest(view);
  const configHash = retrievalConfigHash(cfg);
  const resultHash = hashJson({
    schema: RESULT_SCHEMA, config: configHash, query: query.queryHash, corpus: digest, snapshot: view.activeSnapshot?.corpusHash ?? null, asOfDate: query.asOfDate,
    facets: facets.map((f) => ({
      facet: f.facet,
      candidates: f.candidates.map((c) => [c.canonicalId ?? c.evidenceItemId, c.versionContentHash, c.chunkHash, c.chunkOrdinal, c.bm25Score, c.rank]),
    })),
  });
  return {
    schema: RESULT_SCHEMA,
    signalId: facts.signal_id,
    asOfDate: query.asOfDate,
    config: { version: cfg.version, hash: configHash },
    query: { hash: query.queryHash, vocabVersion: query.vocabVersion, configVersion: query.configVersion },
    corpus: { digest, activeSnapshot: view.activeSnapshot, documents: view.items.length },
    facets,
    resultHash,
  };
}

/** Load the corpus (evidence tables only) and retrieve. Reads no report, observation or aggregate data. */
export async function retrieveCandidates(db: EvidenceDb, facts: SignalFacts, cfg: RetrievalConfig = makeRetrievalConfig({ allowSynthetic: false }), opts: RetrievalOptions = {}): Promise<RetrievalResult> {
  const view = await loadCorpusView(db, { textStatuses: cfg.eligibility.statuses });
  return retrieveFromCorpus(view, facts, cfg, opts);
}

/** Convenience: signal id -> facts -> candidates. Returns null if the signal does not exist or is not visible. */
export async function retrieveForSignal(db: EvidenceDb, signalId: string, cfg: RetrievalConfig, opts: RetrievalOptions = {}): Promise<RetrievalResult | null> {
  const facts = await loadSignalFacts(db, signalId);
  return facts ? retrieveCandidates(db, facts, cfg, opts) : null;
}
