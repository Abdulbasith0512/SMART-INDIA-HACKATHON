// The M4.3 pipeline. Input: the M4.2 retrieval result (eligible candidates per facet), the corpus metadata view and
// the signal facts. Output: an auditable PRESENTATION ranking for a human verifier.
//
//   candidate -> hard re-checks (class / geography / time) -> relevance normalisation -> floor
//             -> rank score = relevance x class x geo x temporal -> dedup -> diversity + top-K
//             -> conflicts (curator tags) -> gaps -> historical context -> exclusion log
//
// The rank score represents presentation priority for a verifier, not the probability that an evidence item is
// correct. Nothing is discarded silently: every candidate that does not reach the selected list carries a
// machine-readable reason. Pure and deterministic; no I/O, no model, no network.
import { hashJson } from "../hash";
import type { CorpusItem, CorpusView } from "../retrieval/corpus";
import type { Candidate, RetrievalResult } from "../retrieval/retrieve";
import { signalFactsSchema, type SignalFacts } from "../retrieval/signal";
import { compareCodePoints, normalizeText } from "../retrieval/tokenize";
import { QUERY_FACETS, type QueryFacet } from "../vocab";
import { findDuplicate, shingleSet, type DedupItem } from "./dedup";
import { contradictingDocuments, detectConflicts, type ConflictTag } from "./conflicts";
import { assessClass, assessGeography, assessTemporal, geoSpecificity, normaliseRelevance, type ClassComponent, type GeoComponent, type TemporalComponent } from "./factors";
import { computeGaps } from "./gaps";
import { RANKING_CONFIG_V1, RANK_NOTICE, rankingConfigHash, roundRank, type RankingConfig } from "./policy";
import {
  FAMILY_OF, RANKING_SCHEMA, type CandidateRef, type ExclusionReason, type HistoricalEntry, type RankedCandidate, type RankedEvidence, type RankedFacet,
  type RankingExclusion, type RetrievalExclusionSummary, type ScoreComponents,
} from "./types";

export interface RankInput {
  facts: SignalFacts;
  /** M4.2 result for the main (current-evidence) pass. */
  retrieval: RetrievalResult;
  /** Optional M4.2 result for the historical pass (statuses superseded / historical); feeds historical_context only. */
  historical?: RetrievalResult | null;
  /** Corpus metadata: statuses, supersession links and curator tags. */
  view: CorpusView;
  config?: RankingConfig;
}

interface Work {
  cand: Candidate;
  relevance: number;
  components: ScoreComponents;
  tier: number;
  geoSpec: number;
  key: string;
  shingles: ReadonlySet<string>;
}

const refOf = (c: Candidate): CandidateRef => ({
  chunkId: c.chunkId, evidenceItemId: c.evidenceItemId, evidenceVersionId: c.evidenceVersionId, canonicalId: c.canonicalId, chunkOrdinal: c.chunkOrdinal,
  chunkHash: c.chunkHash, publisher: c.metadata.publisher, sourceClass: c.metadata.sourceClass,
});
const keyOf = (c: Candidate): string => c.canonicalId ?? c.evidenceItemId;
const publisherKey = (p: string): string => normalizeText(p).replace(/\s+/g, " ").trim();

/** Everything the presentation order depends on. Identifiers appear only as the FINAL tie-break. */
export interface PresentationKey {
  rankScore: number;
  /** 1 = highest source tier. */
  tier: number;
  geoScope: string | null;
  bm25: number;
  key: string;
  ordinal: number;
  chunkId: string;
}

/** Presentation order: rank score, then (only on a tie) tier, geography specificity, lexical score, and finally identifiers. */
export function comparePresentation(a: PresentationKey, b: PresentationKey): number {
  return (
    b.rankScore - a.rankScore || a.tier - b.tier || geoSpecificity(b.geoScope) - geoSpecificity(a.geoScope) || b.bm25 - a.bm25 ||
    compareCodePoints(a.key, b.key) || a.ordinal - b.ordinal || compareCodePoints(a.chunkId, b.chunkId)
  );
}
const keyOfWork = (w: Work): PresentationKey => ({
  rankScore: w.components.rankScore, tier: w.tier, geoScope: w.cand.metadata.geoScope, bm25: w.cand.bm25Score, key: w.key, ordinal: w.cand.chunkOrdinal, chunkId: w.cand.chunkId,
});
const byRank = (a: Work, b: Work): number => comparePresentation(keyOfWork(a), keyOfWork(b));

/** The presentation key of a candidate that carries its score components (selected or excluded). */
export function presentationKeyOf(ref: Pick<CandidateRef, "canonicalId" | "evidenceItemId" | "chunkOrdinal" | "chunkId">, bm25: number, components: ScoreComponents): PresentationKey {
  return {
    rankScore: components.rankScore, tier: components.classFactor.tier, geoScope: components.geoFactor.evidenceScope, bm25, key: ref.canonicalId ?? ref.evidenceItemId,
    ordinal: ref.chunkOrdinal, chunkId: ref.chunkId,
  };
}
/** Retention order for dedup: the stronger, more specific candidate is kept (higher tier, more specific geography, ...). */
function byRetention(a: Work, b: Work): number {
  return (
    a.tier - b.tier || b.geoSpec - a.geoSpec || b.components.rankScore - a.components.rankScore || b.cand.bm25Score - a.cand.bm25Score ||
    compareCodePoints(a.key, b.key) || a.cand.chunkOrdinal - b.cand.chunkOrdinal || compareCodePoints(a.cand.chunkId, b.cand.chunkId)
  );
}

/** A total order over exclusions (each candidate appears at most once), so the log never depends on arrival order. */
function sortExclusions(xs: RankingExclusion[]): RankingExclusion[] {
  return xs.sort(
    (a, b) =>
      compareCodePoints(a.facet, b.facet) ||
      compareCodePoints(a.candidate.canonicalId ?? a.candidate.evidenceItemId, b.candidate.canonicalId ?? b.candidate.evidenceItemId) ||
      a.candidate.chunkOrdinal - b.candidate.chunkOrdinal || compareCodePoints(a.candidate.chunkId, b.candidate.chunkId),
  );
}

function exclusion(
  facet: QueryFacet, section: RankingExclusion["section"], reason: ExclusionReason, c: Candidate, components: Partial<ScoreComponents>, detail: RankingExclusion["detail"],
): RankingExclusion {
  return { facet, section, reason, family: FAMILY_OF[reason], candidate: refOf(c), bm25Score: c.bm25Score, scoreComponents: components, detail };
}

interface PoolResult {
  /** Rank-ordered, passed every rule up to and including the relevance floor. */
  ranked: Work[];
  excluded: RankingExclusion[];
  rankable: number;
  normalisedBy: number;
}

/** Hard re-checks, relevance normalisation, factors, floor and ordering for ONE facet's candidates. */
function rankPool(cands: readonly Candidate[], facet: QueryFacet, section: RankingExclusion["section"], input: RankInput, cfg: RankingConfig, asOfDate: string): PoolResult {
  const excluded: RankingExclusion[] = [];
  const pre: Array<{ cand: Candidate; cls: ClassComponent; geo: GeoComponent; temporal: TemporalComponent }> = [];
  const historical = section === "historical_context";

  for (const cand of cands) {
    const cls = assessClass(cand.metadata.sourceClass, cfg);
    if (cls.ok === false) {
      excluded.push(exclusion(facet, section, cls.reason, cand, {}, { message: cls.detail }));
      continue;
    }
    const geo = assessGeography(cand.metadata, input.facts, cfg);
    if (geo.ok === false) {
      excluded.push(exclusion(facet, section, geo.reason, cand, { classFactor: cls.component }, { message: geo.detail }));
      continue;
    }
    const temporal = assessTemporal(cand.metadata, { asOfDate }, cfg, { allowHistoricalStatuses: historical });
    if (temporal.ok === false) {
      excluded.push(exclusion(facet, section, temporal.reason, cand, { classFactor: cls.component, geoFactor: geo.component }, { message: temporal.detail }));
      continue;
    }
    pre.push({ cand, cls: cls.component, geo: geo.component, temporal: temporal.component });
  }

  const norm = normaliseRelevance(pre.map((p) => p.cand.bm25Score));
  const works: Work[] = pre.map((p, i) => {
    const relevance = norm.values[i];
    const rankScore = roundRank(relevance * p.cls.value * p.geo.value * p.temporal.value, cfg.precision);
    return {
      cand: p.cand, relevance, tier: p.cls.tier, geoSpec: geoSpecificity(p.cand.metadata.geoScope), key: keyOf(p.cand), shingles: shingleSet(p.cand.text, cfg.dedup.shingleSize),
      components: {
        formula: "normalised_relevance x class_factor x geo_factor x temporal_factor",
        relevance: { bm25: p.cand.bm25Score, normalisedBy: norm.maximum, value: relevance, method: cfg.relevance.method },
        classFactor: p.cls, geoFactor: p.geo, temporalFactor: p.temporal, rankScore,
      },
    };
  });

  const ranked: Work[] = [];
  for (const w of works) {
    if (w.relevance < cfg.relevance.floor) {
      excluded.push(exclusion(facet, section, "below_relevance_floor", w.cand, w.components, {
        message: `normalised relevance ${w.relevance} is below the floor ${cfg.relevance.floor}`, limit: cfg.relevance.floor,
      }));
    } else ranked.push(w);
  }
  ranked.sort(byRank);
  return { ranked, excluded, rankable: works.length, normalisedBy: norm.maximum };
}

function dedupe(ranked: readonly Work[], facet: QueryFacet, section: RankingExclusion["section"], cfg: RankingConfig): { survivors: Work[]; excluded: RankingExclusion[] } {
  const kept: Work[] = [];
  const keptItems: DedupItem[] = [];
  const dropped = new Map<string, RankingExclusion>();
  const item = (w: Work): DedupItem => ({
    chunkId: w.cand.chunkId, itemId: w.cand.evidenceItemId, canonicalId: w.cand.canonicalId, versionContentHash: w.cand.versionContentHash, chunkHash: w.cand.chunkHash,
    chunkOrdinal: w.cand.chunkOrdinal, shingles: w.shingles,
  });
  for (const w of [...ranked].sort(byRetention)) {
    const d = item(w);
    const m = findDuplicate(d, keptItems, cfg.dedup.jaccardThreshold);
    if (!m) {
      kept.push(w);
      keptItems.push(d);
      continue;
    }
    const retained = kept.find((k) => k.cand.chunkId === m.retained.chunkId)!;
    dropped.set(w.cand.chunkId, exclusion(facet, section, m.rule === "near_duplicate" ? "near_duplicate" : "duplicate", w.cand, w.components, {
      message: `${m.rule === "near_duplicate" ? "near-duplicate" : "duplicate"} of a stronger or more specific candidate (${m.rule})`,
      rule: m.rule, basis: m.basis, jaccard: m.jaccard, retained: refOf(retained.cand),
    }));
  }
  return { survivors: kept.sort(byRank), excluded: [...dropped.values()] };
}

function select(
  survivors: readonly Work[], facet: QueryFacet, section: RankingExclusion["section"], limits: { topK: number; perDocument: number; perPublisher: number },
): { selected: Work[]; excluded: RankingExclusion[] } {
  const selected: Work[] = [];
  const excluded: RankingExclusion[] = [];
  const perDoc = new Map<string, number>();
  const perPub = new Map<string, number>();
  for (const w of survivors) {
    if (selected.length >= limits.topK) {
      excluded.push(exclusion(facet, section, "beyond_top_k", w.cand, w.components, { message: `outside the top ${limits.topK} after deduplication and diversity`, limit: limits.topK }));
      continue;
    }
    const doc = w.cand.evidenceItemId;
    const pub = publisherKey(w.cand.metadata.publisher);
    if ((perDoc.get(doc) ?? 0) >= limits.perDocument) {
      excluded.push(exclusion(facet, section, "document_diversity", w.cand, w.components, {
        message: `document diversity limit: at most ${limits.perDocument} chunk(s) per document`, limit: limits.perDocument, key: w.key,
      }));
      continue;
    }
    if ((perPub.get(pub) ?? 0) >= limits.perPublisher) {
      excluded.push(exclusion(facet, section, "publisher_diversity", w.cand, w.components, {
        message: `publisher diversity limit: at most ${limits.perPublisher} chunks per publisher`, limit: limits.perPublisher, key: pub,
      }));
      continue;
    }
    selected.push(w);
    perDoc.set(doc, (perDoc.get(doc) ?? 0) + 1);
    perPub.set(pub, (perPub.get(pub) ?? 0) + 1);
  }
  return { selected, excluded };
}

function toRanked(w: Work, position: number): RankedCandidate {
  const { rank: retrievalRank, ...rest } = w.cand;
  return { ...rest, rank: position, retrievalRank, tierLabel: w.components.classFactor.tierLabel, scoreComponents: w.components };
}

// Mapping of M4.2's document-level reasons to the vocabulary used by the M4.3 exclusion log.
const NOT_RELEVANT = new Set(["topic_mismatch", "syndrome_mismatch", "language_not_queryable"]);
function mapRetrievalReason(reason: string, status: string | undefined): string {
  switch (reason) {
    case "status_not_eligible":
      return ["superseded", "withdrawn", "historical", "quarantined", "draft"].includes(status ?? "") ? (status as string) : "not_current";
    case "validity_ended": return "expired";
    case "published_after_as_of": return "look_ahead";
    case "geo_scope_mismatch": return "geographic_ineligible";
    default: return reason;
  }
}

function summariseRetrievalExclusions(retrieval: RetrievalResult, items: ReadonlyMap<string, CorpusItem>): RetrievalExclusionSummary {
  const counts: Record<string, Record<string, number>> = {};
  const notable: RetrievalExclusionSummary["notable"] = [];
  for (const f of retrieval.facets) {
    const c: Record<string, number> = {};
    for (const e of f.excluded) {
      const status = items.get(e.evidenceItemId)?.status;
      const mapped = e.reasons.map((r) => mapRetrievalReason(r, status));
      for (const m of mapped) c[m] = (c[m] ?? 0) + 1;
      // "Plausible" documents: right topic, right syndrome, queryable language - yet they did not compete.
      if (!e.reasons.some((r) => NOT_RELEVANT.has(r))) notable.push({ facet: f.facet, evidenceItemId: e.evidenceItemId, canonicalId: e.canonicalId, reasons: [...new Set(mapped)].sort(compareCodePoints) });
    }
    counts[f.facet] = Object.fromEntries(Object.entries(c).sort((a, b) => compareCodePoints(a[0], b[0])));
  }
  notable.sort((a, b) => compareCodePoints(a.facet, b.facet) || compareCodePoints(a.canonicalId ?? a.evidenceItemId, b.canonicalId ?? b.evidenceItemId));
  return { counts, notable };
}

export function rankEvidence(input: RankInput): RankedEvidence {
  const cfg = input.config ?? RANKING_CONFIG_V1;
  const { retrieval, view } = input;
  // Strict: ranking, like retrieval, refuses anything beyond the allowed signal facts (no counts, text or identifiers).
  const facts = signalFactsSchema.parse(input.facts);
  const asOfDate = retrieval.asOfDate;
  const items = new Map(view.items.map((i) => [i.id, i]));
  const tags = new Map<string, ConflictTag>(view.items.map((i) => [i.id, { questionKey: i.questionKey ?? null, position: i.position ?? null }]));

  // ---------------------------------------------------------------- main facets
  const facets: RankedFacet[] = QUERY_FACETS.map((facet) => {
    const fr = retrieval.facets.find((f) => f.facet === facet);
    const cands = fr?.candidates ?? [];
    const pool = rankPool(cands, facet, "main", input, cfg, asOfDate);
    const dd = dedupe(pool.ranked, facet, "main", cfg);
    const sel = select(dd.survivors, facet, "main", { topK: cfg.selection.topKPerFacet, perDocument: cfg.diversity.maxChunksPerDocument, perPublisher: cfg.diversity.maxChunksPerPublisher });
    return {
      facet,
      selected: sel.selected.map((w, i) => toRanked(w, i + 1)),
      excluded: sortExclusions([...pool.excluded, ...dd.excluded, ...sel.excluded]),
      stats: { retrieved: cands.length, rankable: pool.rankable, afterFloor: pool.ranked.length, afterDedup: dd.survivors.length, selected: sel.selected.length, normalisedBy: pool.normalisedBy },
    };
  });

  const allSelected = facets.flatMap((f) => f.selected);
  const selectedItemIds = new Set(allSelected.map((c) => c.evidenceItemId));

  // ---------------------------------------------------------------- historical context (superseded only with its successor present)
  const successors = new Map<string, string[]>();
  for (const i of view.items) if (i.supersedesId) successors.set(i.supersedesId, [...(successors.get(i.supersedesId) ?? []), i.id]);
  const presentSuccessors = (id: string): string[] => {
    const found = new Set<string>();
    const queue = [...(successors.get(id) ?? [])];
    for (let depth = 0; queue.length && depth < 50; depth += 1) {
      const next = queue.shift()!;
      if (selectedItemIds.has(next)) found.add(items.get(next)?.canonicalId ?? next);
      queue.push(...(successors.get(next) ?? []));
    }
    return [...found].sort(compareCodePoints);
  };

  const historicalContext: HistoricalEntry[] = [];
  const histExcluded: RankingExclusion[] = [];
  for (const facet of QUERY_FACETS) {
    const fr = input.historical?.facets.find((f) => f.facet === facet);
    if (!fr) continue;
    const qualifying: Candidate[] = [];
    const relation = new Map<string, string[]>();
    for (const cand of fr.candidates) {
      const status = cand.metadata.status;
      if (status === "superseded") {
        const present = presentSuccessors(cand.evidenceItemId);
        if (present.length === 0) {
          histExcluded.push(exclusion(facet, "historical_context", "superseded", cand, {}, { message: "superseded evidence is shown only when its successor is among the selected evidence; the successor is not", successorsPresent: [] }));
          continue;
        }
        relation.set(cand.chunkId, present);
      } else if (status === "historical") relation.set(cand.chunkId, []);
      else {
        histExcluded.push(exclusion(facet, "historical_context", status === "withdrawn" ? "withdrawn" : "not_current", cand, {}, { message: `status ${status} never appears in historical context` }));
        continue;
      }
      qualifying.push(cand);
    }
    const pool = rankPool(qualifying, facet, "historical_context", input, cfg, asOfDate);
    const sel = select(pool.ranked, facet, "historical_context", { topK: cfg.selection.historicalTopKPerFacet, perDocument: cfg.selection.historicalMaxChunksPerDocument, perPublisher: cfg.diversity.maxChunksPerPublisher });
    histExcluded.push(...pool.excluded, ...sel.excluded);
    sel.selected.forEach((w, i) => {
      historicalContext.push({ ...toRanked(w, i + 1), section: "historical_context", relation: { status: w.cand.metadata.status, supersededBy: relation.get(w.cand.chunkId) ?? [] } });
    });
  }

  // ---------------------------------------------------------------- conflicts, gaps
  const conflicts = detectConflicts(allSelected, tags);
  const contradicting = contradictingDocuments(allSelected, tags);
  const gaps = computeGaps({ facets, facts, cfg, contradicting });

  // ---------------------------------------------------------------- exclusion log
  sortExclusions(histExcluded);
  const rankingExclusions = [...facets.flatMap((f) => f.excluded), ...histExcluded];
  const counts: Record<string, number> = {};
  for (const e of rankingExclusions) counts[`${e.section}:${e.reason}`] = (counts[`${e.section}:${e.reason}`] ?? 0) + 1;
  const sortedCounts = Object.fromEntries(Object.entries(counts).sort((a, b) => compareCodePoints(a[0], b[0])));

  const rankingConfigHashValue = rankingConfigHash(cfg);
  const sig = (c: RankedCandidate) => [
    c.canonicalId ?? c.evidenceItemId, c.chunkOrdinal, c.chunkHash, c.bm25Score, c.rank, c.scoreComponents.relevance.value, c.scoreComponents.classFactor.value,
    c.scoreComponents.geoFactor.value, c.scoreComponents.temporalFactor.value, c.scoreComponents.rankScore,
  ];
  const excSig = (e: RankingExclusion) => [e.facet, e.section, e.reason, e.candidate.canonicalId ?? e.candidate.evidenceItemId, e.candidate.chunkOrdinal, e.candidate.chunkHash,
    e.detail.retained ? [e.detail.retained.canonicalId ?? e.detail.retained.evidenceItemId, e.detail.retained.chunkOrdinal] : null, e.detail.rule ?? null, e.detail.jaccard ?? null];
  const rankingHash = hashJson({
    schema: RANKING_SCHEMA, ranking: rankingConfigHashValue, asOfDate,
    retrieval: [retrieval.config.hash, retrieval.query.hash, retrieval.resultHash, retrieval.corpus.digest],
    historical: input.historical ? input.historical.resultHash : null,
    facets: facets.map((f) => ({ facet: f.facet, selected: f.selected.map(sig), excluded: f.excluded.map(excSig) })),
    historicalContext: historicalContext.map((h) => [...sig(h), h.relation.status, h.relation.supersededBy]),
    historicalExcluded: histExcluded.map(excSig),
    conflicts: conflicts.map((c) => [c.questionKey, c.positions.map((p) => [p.position, p.documents.map((d) => d.canonicalId ?? d.evidenceItemId)])]),
    gaps: gaps.map((g) => [g.code, g.facet, g.message]),
  });

  return {
    schema: RANKING_SCHEMA,
    notice: RANK_NOTICE,
    signalId: facts.signal_id,
    asOfDate,
    ranking: { version: cfg.version, configHash: rankingConfigHashValue },
    retrieval: { configHash: retrieval.config.hash, queryHash: retrieval.query.hash, resultHash: retrieval.resultHash, corpusDigest: retrieval.corpus.digest, historicalResultHash: input.historical?.resultHash ?? null },
    facets,
    historicalContext,
    conflicts,
    gaps,
    exclusions: { ranking: rankingExclusions, retrieval: summariseRetrievalExclusions(retrieval, items), counts: sortedCounts },
    rankingHash,
  };
}
