// Build the canonical evidence bundle from a signal, its M4.2 retrieval result and its M4.3 ranking. Pure and
// deterministic: no I/O, no model, no network, no clock except the `retrieved_at` stamp, which is excluded from the
// hash. Nothing is invented here: items, exclusions, conflicts and gaps are carried over from M4.3 exactly; the only
// new things are the stable citation ids, the deterministic "why relevant" reasons and the statistics.
import type { RankedEvidence, RankedCandidate } from "../ranking/types";
import { signalGeography } from "../ranking/factors";
import { RANK_NOTICE } from "../ranking/policy";
import type { RetrievalResult } from "../retrieval/retrieve";
import type { SignalFacts } from "../retrieval/signal";
import { compareCodePoints } from "../retrieval/tokenize";
import { QUERY_FACETS, SOURCE_CLASS_TIERS, type QueryFacet } from "../vocab";
import { bundleHashOf, snakeKeys } from "./canonical";
import { whyRelevant } from "./reasons";
import {
  BUNDLE_SCHEMA_VERSION, type BundleCitation, type BundleConflict, type BundleExclusion, type BundleFacet, type BundleGap, type BundleHistoricalItem, type BundleItem,
  type BundleStats, type EvidenceBundle,
} from "./types";

export interface SignalIdentity {
  /** The detector's episode key (a SHA-256 of the episode), if the signal came from the detector. */
  episodeKey: string | null;
  /** The detector version recorded with the signal. */
  detectorVersion: string | null;
}

export interface BuildInput {
  facts: SignalFacts;
  identity: SignalIdentity;
  retrieval: RetrievalResult;
  ranking: RankedEvidence;
  /** Stamp for `retrieved_at` (excluded from the hash). Defaults to now. */
  retrievedAt?: string;
}

const asRecord = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

function toItem(c: RankedCandidate, citationId: string, facet: QueryFacet, topics: readonly string[], syndrome: string): BundleItem {
  const s = c.scoreComponents;
  return {
    citation_id: citationId,
    rank: c.rank,
    evidence_item_id: c.evidenceItemId,
    evidence_version_id: c.evidenceVersionId,
    chunk_id: c.chunkId,
    chunk_ordinal: c.chunkOrdinal,
    chunk_hash: c.chunkHash,
    version_content_hash: c.versionContentHash,
    canonical_id: c.canonicalId,
    evidence_kind: c.metadata.evidenceKind,
    is_synthetic: c.metadata.isSynthetic,
    tier: { source_class: s.classFactor.sourceClass, label: c.tierLabel, position: s.classFactor.tier },
    geo_level: s.geoFactor.evidenceScope,
    temporal_status: { rule: s.temporalFactor.rule, reason: s.temporalFactor.reason, age_days: s.temporalFactor.ageDays, factor: s.temporalFactor.value },
    score_components: asRecord(snakeKeys(s)),
    why_relevant: whyRelevant(c, facet, { syndrome, facetTopics: topics }),
    excerpt: c.text,
  };
}

export function buildBundle(input: BuildInput): EvidenceBundle {
  const { facts, identity, retrieval, ranking } = input;
  const syndrome = facts.syndrome;
  const queryOf = (facet: QueryFacet) => retrieval.facets.find((f) => f.facet === facet)!.query;

  // ---- stable citation ids: E1, E2, ... in (facet order, rank order); ONE id per distinct chunk ----
  const citationOf = new Map<string, string>();
  const citations = new Map<string, BundleCitation>();
  const cite = (c: RankedCandidate, facet: QueryFacet, section: BundleCitation["section"]): string => {
    let id = citationOf.get(c.chunkId);
    if (!id) {
      id = `E${citationOf.size + 1}`;
      citationOf.set(c.chunkId, id);
      citations.set(id, {
        citation_id: id, section, evidence_item_id: c.evidenceItemId, evidence_version_id: c.evidenceVersionId, chunk_id: c.chunkId, canonical_id: c.canonicalId,
        chunk_ordinal: c.chunkOrdinal, chunk_hash: c.chunkHash, version_content_hash: c.versionContentHash, appears_in: [],
      });
    }
    citations.get(id)!.appears_in.push({ facet, rank: c.rank });
    return id;
  };

  const facetGaps = (facet: QueryFacet): BundleGap[] => ranking.gaps.filter((g) => g.facet === facet).map((g) => asRecord(snakeKeys(g)) as unknown as BundleGap);
  const facets: BundleFacet[] = QUERY_FACETS.map((name) => {
    const rf = ranking.facets.find((f) => f.facet === name)!;
    const q = queryOf(name);
    return {
      name,
      query_terms: [...q.terms],
      query_topics: [...q.topics],
      items: rf.selected.map((c) => toItem(c, cite(c, name, "main"), name, q.topics, syndrome)),
      gaps: facetGaps(name),
    };
  });

  const historical: BundleHistoricalItem[] = ranking.historicalContext.map((h, i) => {
    const q = queryOf(h.facet);
    const rank = i + 1; // one flat, ordered section across facets
    return {
      ...toItem({ ...h, rank }, cite({ ...h, rank }, h.facet, "historical_context"), h.facet, q.topics, syndrome),
      facet: h.facet,
      relation: { status: h.relation.status, superseded_by: [...h.relation.supersededBy] },
    };
  });

  const orderedCitations = [...citations.values()].sort((a, b) => Number(a.citation_id.slice(1)) - Number(b.citation_id.slice(1)));
  for (const c of orderedCitations) c.appears_in.sort((a, b) => compareCodePoints(a.facet, b.facet) || a.rank - b.rank);

  const gaps = ranking.gaps.map((g) => asRecord(snakeKeys(g)) as unknown as BundleGap);
  const conflicts: BundleConflict[] = ranking.conflicts.map((c) => {
    const body = asRecord(snakeKeys(c));
    return {
      kind: "curator_tagged_conflict",
      question_key: body.question_key as string,
      positions: (body.positions as Array<{ position: string; documents: Array<Record<string, unknown>> }>).map((p) => ({
        position: p.position,
        documents: p.documents.map((d) => ({ ...d, citation_ids: ((d.chunk_ids as string[]) ?? []).map((id) => citationOf.get(id)).filter((x): x is string => !!x).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))) })),
      })),
      basis: "curator_tags",
      note: body.note as string,
    };
  });

  const excluded: BundleExclusion[] = ranking.exclusions.ranking.map((e) => ({
    id: e.candidate.chunkId,
    reason: e.reason,
    family: e.family,
    facet: e.facet,
    section: e.section,
    candidate: asRecord(snakeKeys(e.candidate)),
    bm25_score: e.bm25Score,
    score_components: asRecord(snakeKeys(e.scoreComponents)),
    detail: asRecord(snakeKeys(e.detail)),
  }));

  // ---- statistics (deterministic; no timestamps) ----
  const mainChunks = orderedCitations.filter((c) => c.section === "main");
  const slots = facets.reduce((n, f) => n + f.items.length, 0);
  const firstItem = new Map<string, BundleItem>();
  for (const f of facets) for (const it of f.items) if (!firstItem.has(it.citation_id)) firstItem.set(it.citation_id, it);
  const tierDist: Record<string, number> = {};
  for (const cls of SOURCE_CLASS_TIERS) {
    const n = [...firstItem.values()].filter((i) => i.tier.source_class === cls).length;
    if (n) tierDist[cls] = n;
  }
  const stats: BundleStats = {
    eligible_candidates: ranking.facets.reduce((n, f) => n + f.stats.retrieved, 0),
    selected_chunks: mainChunks.length,
    selected_slots: slots,
    selected_documents: new Set(mainChunks.map((c) => c.evidence_item_id)).size,
    excluded_candidates: excluded.length,
    exclusions_by_reason: { ...ranking.exclusions.counts },
    facets_covered: facets.filter((f) => f.items.length > 0).length,
    facets_total: facets.length,
    gaps: gaps.length,
    conflicts: conflicts.length,
    historical_context_items: historical.length,
    selected_synthetic: [...firstItem.values()].filter((i) => i.is_synthetic).length,
    selected_non_synthetic: [...firstItem.values()].filter((i) => !i.is_synthetic).length,
    tier_distribution: tierDist,
  };

  const geo = signalGeography(facts);
  const snap = retrieval.corpus.activeSnapshot;
  const body = {
    schema_version: BUNDLE_SCHEMA_VERSION,
    notice: RANK_NOTICE,
    signal: {
      candidate_id: facts.signal_id,
      episode_key: identity.episodeKey,
      region: { id: facts.region.id, name: facts.region.name, level: facts.region.level, district: geo.district, state: geo.state },
      syndrome,
      window: { start: facts.window.start, end: facts.window.end },
      detector_version: identity.detectorVersion,
    },
    corpus: { snapshot_id: snap?.id ?? null, corpus_hash: snap?.corpusHash ?? null, corpus_digest: retrieval.corpus.digest },
    config: {
      retrieval_version: retrieval.config.version,
      retrieval_config_hash: retrieval.config.hash,
      query_vocab_version: retrieval.query.vocabVersion,
      query_config_version: retrieval.query.configVersion,
      ranking_version: ranking.ranking.version,
      ranking_config_hash: ranking.ranking.configHash,
      as_of_date: ranking.asOfDate,
    },
    provenance: {
      query_hash: retrieval.query.hash,
      retrieval_result_hash: retrieval.resultHash,
      historical_retrieval_result_hash: ranking.retrieval.historicalResultHash,
      ranking_hash: ranking.rankingHash,
    },
    facets,
    citations: orderedCitations,
    historical_context: historical,
    conflicts,
    gaps,
    excluded,
    retrieval_exclusions: asRecord(snakeKeys(ranking.exclusions.retrieval)) as unknown as EvidenceBundle["retrieval_exclusions"],
    stats,
  };
  return { ...body, bundle_hash: bundleHashOf(body), retrieved_at: input.retrievedAt ?? new Date().toISOString() } as EvidenceBundle;
}
