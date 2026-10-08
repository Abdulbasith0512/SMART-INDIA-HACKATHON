// @vitest-environment node
import { describe, expect, it } from "vitest";
import { RETRIEVAL_CONFIG_DEV, retrievalConfigHash } from "../retrieval/config";
import type { CorpusView } from "../retrieval/corpus";
import { retrieveFromCorpus } from "../retrieval/retrieve";
import { ganjamFacts, historicalViewFromPrepared, makeFacts, SYNDROMES, uid, viewFromPrepared, withTags } from "../retrieval/testkit";
import { RANKING_CONFIG_V1, makeRankingConfig, rankingConfigHash } from "../ranking/policy";
import { historicalRetrievalConfig } from "../ranking/pipeline";
import { rankEvidence } from "../ranking/rank";
import { buildBundle } from "./build";
import { snakeKeys, bundleHashOf, canonicalBundleJson } from "./canonical";
import { BUNDLE_SCHEMA_VERSION } from "./types";
import { CORPUS_HASH, IDENTITY, RETRIEVED_AT, SNAPSHOT, referenceBundle } from "./testkit";

/** Pinned: the reference bundle (reference signal, dev corpus snapshot, dev retrieval config, default ranking config, as-of 2025-09-07). */
const GOLDEN_BUNDLE_HASH = "347d388f9b4cd5aa07cf15720386a2dc3167281dd6f80a8c0e5137846f37f97b";
const FROZEN = {
  m42ResultHash: "fa55022a2264168cc0ac30878313a1e6438e818156aa30d517f3c08dbadedd5a",
  m42QueryHash: "e2cc3e663c47c5b585f85685408e6641477d1e8c53d1d97a4707b4aba9bd9f76",
  m42ConfigHash: "029b517ac9986c47588303c98a594a2fc9819371f3f3f201f3e199894bccda7f",
  m42CorpusDigest: "cbd9f2ab2beb450d2a4813d7fa70e782ffc899f9f392d6c1f4c54da6d840014a",
  m43RankingHash: "01f7ac49042828fa487a2cfdbc02a942416df7ac30c22fca6115b4682fcdbf5f",
  m43ConfigHash: "f288734e732142d6bbab1afeeb8acc6e5a47aee0fcd97a3ef07e6ccc44c19d5d",
};

const view = viewFromPrepared();
const bundle = referenceBundle();
const allItems = (b = bundle) => b.facets.flatMap((f) => f.items);
const chunkText = new Map(view.items.flatMap((i) => i.chunks.map((c) => [c.id, c.text] as const)));
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** Replace database ids by their order of first appearance, so two builds can be compared apart from the ids themselves. */
function withoutIds(b: unknown): string {
  const seen = new Map<string, string>();
  return JSON.stringify(b).replace(UUID, (m) => {
    if (!seen.has(m)) seen.set(m, `ID${seen.size + 1}`);
    return seen.get(m)!;
  });
}

describe("canonical bundle schema", () => {
  it("has exactly the planned top-level fields", () => {
    expect(Object.keys(bundle).sort()).toEqual([
      "bundle_hash", "citations", "config", "conflicts", "corpus", "excluded", "facets", "gaps", "historical_context", "notice", "provenance", "retrieval_exclusions",
      "retrieved_at", "schema_version", "signal", "stats",
    ]);
    expect(bundle.schema_version).toBe(BUNDLE_SCHEMA_VERSION);
    expect(BUNDLE_SCHEMA_VERSION).toBe("evidence-bundle/1");
  });

  it("records the signal, corpus and configuration it was built from", () => {
    expect(bundle.signal).toEqual({
      candidate_id: makeFacts().signal_id, episode_key: IDENTITY.episodeKey,
      region: { id: makeFacts().region.id, name: "Balianta", level: "block", district: "Khordha", state: "Odisha" },
      syndrome: "acute_diarrhoeal_illness", window: { start: "2025-09-01", end: "2025-09-07" }, detector_version: "test-detector/1.0.0",
    });
    expect(bundle.corpus).toEqual({ snapshot_id: SNAPSHOT.id, corpus_hash: CORPUS_HASH, corpus_digest: FROZEN.m42CorpusDigest });
    expect(bundle.config).toEqual({
      retrieval_version: "retrieval/1.0.0", retrieval_config_hash: retrievalConfigHash(RETRIEVAL_CONFIG_DEV), query_vocab_version: "query-vocab/1.0.0",
      query_config_version: "query-config/1.0.0", ranking_version: "ranking/1.0.0", ranking_config_hash: rankingConfigHash(RANKING_CONFIG_V1), as_of_date: "2025-09-07",
    });
  });

  it("carries the presentation-priority notice and never uses probability vocabulary", () => {
    expect(bundle.notice).toMatch(/presentation priority for a verifier, not the probability that an evidence item is correct/);
    const keys = canonicalBundleJson(bundle).match(/"[a-zA-Z0-9_]+":/g)!.map((k) => k.slice(1, -2).toLowerCase());
    for (const banned of ["probability", "confidence", "likelihood", "truth", "accuracy", "diagnosis", "outbreak_confirmed"]) expect(keys).not.toContain(banned);
  });

  it("contains no personal data, counts from the signal, or secrets", () => {
    const keys = canonicalBundleJson(bundle).match(/"[a-zA-Z0-9_]+":/g)!.map((k) => k.slice(1, -2).toLowerCase());
    for (const banned of ["observed", "p_value", "sample_count", "patient", "phone", "email", "latitude", "longitude", "address", "api_key", "password", "token", "explanation"]) expect(keys, banned).not.toContain(banned);
    expect(canonicalBundleJson(bundle)).not.toMatch(/Emerging signal requiring verification:/);
  });
});

describe("bundle hash and golden reference", () => {
  it("hashes the canonical JSON without bundle_hash and retrieved_at", () => {
    expect(bundleHashOf(bundle)).toBe(bundle.bundle_hash);
    expect(bundle.bundle_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalBundleJson(bundle)).not.toContain(bundle.retrieved_at);
    expect(canonicalBundleJson(bundle)).not.toContain(bundle.bundle_hash);
  });

  it("matches the pinned golden hash for the reference bundle", () => {
    expect(bundle.bundle_hash).toBe(GOLDEN_BUNDLE_HASH);
  });

  it("is unaffected by the wall clock", () => {
    const later = { ...bundle, retrieved_at: "2031-05-05T05:05:05.005Z" };
    expect(bundleHashOf(later)).toBe(GOLDEN_BUNDLE_HASH);
  });

  it("embeds the frozen M4.2 and M4.3 hashes: with no snapshot they are exactly the pinned values", () => {
    const frozen = referenceBundle({ snapshot: null });
    expect(frozen.corpus).toEqual({ snapshot_id: null, corpus_hash: null, corpus_digest: FROZEN.m42CorpusDigest });
    expect(frozen.provenance).toMatchObject({ query_hash: FROZEN.m42QueryHash, retrieval_result_hash: FROZEN.m42ResultHash, ranking_hash: FROZEN.m43RankingHash });
    expect(frozen.config.retrieval_config_hash).toBe(FROZEN.m42ConfigHash);
    expect(frozen.config.ranking_config_hash).toBe(FROZEN.m43ConfigHash);
  });

  it("reports the retrieval and ranking results it was built from", () => {
    expect(bundle.provenance.query_hash).toBe(FROZEN.m42QueryHash);
    expect(bundle.provenance.historical_retrieval_result_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("determinism", () => {
  const text = canonicalBundleJson(bundle);

  it("is byte-identical across 25 runs", () => {
    for (let i = 0; i < 25; i += 1) {
      const again = referenceBundle();
      expect(canonicalBundleJson(again)).toBe(text);
      expect(again.bundle_hash).toBe(GOLDEN_BUNDLE_HASH);
    }
  });

  it("is byte-identical whatever the order of the corpus items and chunks", () => {
    const shuffle = <T>(xs: readonly T[], seed: number): T[] => {
      const a = [...xs];
      let s = seed;
      for (let i = a.length - 1; i > 0; i -= 1) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        const j = s % (i + 1);
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    for (let seed = 1; seed <= 15; seed += 1) {
      const v: CorpusView = { ...view, items: shuffle(view.items, seed).map((i) => ({ ...i, chunks: shuffle(i.chunks, seed + 50) })) };
      const hv = historicalViewFromPrepared();
      const b = referenceBundle({ view: v, historicalView: { ...hv, items: shuffle(hv.items, seed + 9) } });
      expect(canonicalBundleJson(b), `seed ${seed}`).toBe(text);
    }
  });

  it("is identical when only database ids differ, apart from those ids, and all content-addressed provenance matches", () => {
    const reId = (v: CorpusView, tag: string): CorpusView => ({
      ...v,
      items: v.items.map((i) => ({
        ...i, id: uid(`${tag}:${i.id}`), supersedesId: i.supersedesId ? uid(`${tag}:${i.supersedesId}`) : null,
        version: i.version ? { ...i.version, id: uid(`${tag}v:${i.id}`) } : null, chunks: i.chunks.map((c) => ({ ...c, id: uid(`${tag}c:${c.id}`) })),
      })),
    });
    const other = referenceBundle({ view: reId(view, "x"), historicalView: reId(historicalViewFromPrepared(), "x") });
    expect(other.bundle_hash).not.toBe(bundle.bundle_hash); // ids are part of the canonical bundle, so a different database gives different bytes ...
    expect(withoutIds(snakeKeys({ ...other, bundle_hash: "", retrieved_at: "" }))).toBe(withoutIds(snakeKeys({ ...bundle, bundle_hash: "", retrieved_at: "" }))); // ... that are otherwise identical
    expect(other.provenance.ranking_hash).toBe(bundle.provenance.ranking_hash);
    expect(other.corpus).toEqual(bundle.corpus);
  });

  it("changes with each input that should change it: as-of date, signal, snapshot, ranking policy", () => {
    const hashes = new Set([
      bundle.bundle_hash,
      referenceBundle({ asOfDate: "2025-09-30" }).bundle_hash,
      referenceBundle({ facts: makeFacts({ syndrome: "fever" }) }).bundle_hash,
      referenceBundle({ facts: ganjamFacts() }).bundle_hash,
      referenceBundle({ snapshot: { ...SNAPSHOT, corpusHash: "c".repeat(64) } }).bundle_hash,
      referenceBundle({ ranking: makeRankingConfig({ relevanceFloor: 0.2 }) }).bundle_hash,
      referenceBundle({ ranking: makeRankingConfig({ topK: 4 }) }).bundle_hash,
      referenceBundle({ identity: { ...IDENTITY, detectorVersion: "test-detector/2.0.0" } }).bundle_hash,
    ]);
    expect(hashes.size).toBe(8);
  });
});

describe("facets are preserved and never merged", () => {
  const retrieval = retrieveFromCorpus({ ...view, activeSnapshot: SNAPSHOT }, makeFacts(), RETRIEVAL_CONFIG_DEV);

  it("lists the four M4.2 facets in order with their exact query terms and topics", () => {
    expect(bundle.facets.map((f) => f.name)).toEqual(["verification_guidance", "case_definition", "epidemiological_context", "regional_context"]);
    for (const f of bundle.facets) {
      const q = retrieval.facets.find((x) => x.facet === f.name)!.query;
      expect(f.query_terms).toEqual(q.terms);
      expect(f.query_topics).toEqual(q.topics);
    }
  });

  it("gives each facet its own ranked items, ranks 1..n, with all score components", () => {
    for (const f of bundle.facets) {
      expect(f.items.map((i) => i.rank)).toEqual(f.items.map((_, k) => k + 1));
      expect(f.items.length).toBeGreaterThan(0);
      for (const i of f.items) {
        const s = i.score_components as Record<string, Record<string, unknown>>;
        expect(Object.keys(s).sort()).toEqual(["class_factor", "formula", "geo_factor", "rank_score", "relevance", "temporal_factor"]);
        expect(s.class_factor).toMatchObject({ source_class: i.tier.source_class, tier: i.tier.position, value: expect.any(Number) });
        expect(s.geo_factor).toMatchObject({ evidence_scope: i.geo_level });
        expect(s.temporal_factor).toMatchObject({ rule: i.temporal_status.rule, value: i.temporal_status.factor });
      }
    }
  });

  it("does not silently merge facets: a chunk selected in two facets appears in both, with each facet's own rank and score", () => {
    const e7 = bundle.facets.flatMap((f) => f.items.filter((i) => i.canonical_id === "syn-ads-clinical-reference" && i.chunk_ordinal === 2).map((i) => ({ facet: f.name, i })));
    expect(e7.map((x) => x.facet)).toEqual(["case_definition", "epidemiological_context"]);
    expect(e7[0].i.citation_id).toBe(e7[1].i.citation_id);
    expect(e7[0].i.rank).not.toBe(e7[1].i.rank);
    expect((e7[0].i.score_components as { rank_score: number }).rank_score).not.toBe((e7[1].i.score_components as { rank_score: number }).rank_score);
    expect(e7[0].i.excerpt).toBe(e7[1].i.excerpt);
  });

  it("always has four facets, even when empty, each with its query terms and its facet-scoped gap", () => {
    const empty = referenceBundle({ view: { items: [], activeSnapshot: null }, historicalView: null });
    expect(empty.facets.map((f) => f.name)).toHaveLength(4);
    for (const f of empty.facets) {
      expect(f.items).toEqual([]);
      expect(f.query_terms.length).toBeGreaterThan(3);
      expect(f.gaps.map((g) => g.code)).toEqual(["facet_not_covered"]);
      expect(f.gaps[0].facet).toBe(f.name);
    }
  });
});

describe("citation ids", () => {
  it("are E1, E2, ... assigned in (facet order, rank order) to each distinct chunk", () => {
    expect(bundle.citations.map((c) => c.citation_id)).toEqual(bundle.citations.map((_, i) => `E${i + 1}`));
    const firstSeen: string[] = [];
    for (const i of allItems()) if (!firstSeen.includes(i.citation_id)) firstSeen.push(i.citation_id);
    expect(firstSeen).toEqual(bundle.citations.filter((c) => c.section === "main").map((c) => c.citation_id));
  });

  it("map to exactly one (evidence_version_id, chunk_id), and one id per chunk", () => {
    const pairs = new Map<string, string>();
    for (const i of allItems()) {
      const pair = `${i.evidence_version_id}|${i.chunk_id}`;
      expect(pairs.get(i.citation_id) ?? pair).toBe(pair);
      pairs.set(i.citation_id, pair);
    }
    expect(new Set(pairs.values()).size).toBe(pairs.size); // no two ids for one chunk
    for (const c of bundle.citations) expect(pairs.get(c.citation_id)).toBe(`${c.evidence_version_id}|${c.chunk_id}`);
  });

  it("index every appearance and cite the item's own document, chunk and hashes", () => {
    for (const c of bundle.citations.filter((x) => x.section === "main")) {
      const appears = bundle.facets.flatMap((f) => f.items.filter((i) => i.citation_id === c.citation_id).map((i) => ({ facet: f.name, rank: i.rank })));
      expect(c.appears_in).toEqual(appears.sort((a, b) => (a.facet < b.facet ? -1 : a.facet > b.facet ? 1 : a.rank - b.rank)));
      const it = allItems().find((i) => i.citation_id === c.citation_id)!;
      expect(c).toMatchObject({ evidence_item_id: it.evidence_item_id, canonical_id: it.canonical_id, chunk_ordinal: it.chunk_ordinal, chunk_hash: it.chunk_hash, version_content_hash: it.version_content_hash });
    }
  });

  it("are identical across runs and assigned the same way after shuffling", () => {
    expect(referenceBundle().citations).toEqual(bundle.citations);
  });
});

describe("evidence excerpts and provenance", () => {
  it("every excerpt is the stored chunk text, verbatim and within the chunk size bound", () => {
    for (const i of allItems()) {
      expect(i.excerpt).toBe(chunkText.get(i.chunk_id));
      expect(i.excerpt.length).toBeLessThanOrEqual(1500);
      expect(i.excerpt.length).toBeGreaterThan(0);
    }
  });

  it("retains item, version and chunk provenance, matching the corpus", () => {
    for (const i of allItems()) {
      const doc = view.items.find((d) => d.id === i.evidence_item_id)!;
      const chunk = doc.chunks.find((c) => c.id === i.chunk_id)!;
      expect(doc.version!.id).toBe(i.evidence_version_id);
      expect(doc.version!.contentHash).toBe(i.version_content_hash);
      expect(chunk).toMatchObject({ ordinal: i.chunk_ordinal, chunkHash: i.chunk_hash });
      expect(doc.canonicalId).toBe(i.canonical_id);
      expect(doc.status).toBe("current");
    }
  });

  it("does not copy rendered metadata (title, publisher, URL, dates) into items: that always comes from the database by id", () => {
    for (const i of allItems()) {
      expect(Object.keys(i).sort()).toEqual([
        "canonical_id", "chunk_hash", "chunk_id", "chunk_ordinal", "citation_id", "evidence_item_id", "evidence_kind", "evidence_version_id", "excerpt", "geo_level", "is_synthetic",
        "rank", "score_components", "temporal_status", "tier", "version_content_hash", "why_relevant",
      ]);
    }
    const text = canonicalBundleJson({ ...bundle, conflicts: [] });
    for (const d of view.items) {
      expect(text, d.canonicalId!).not.toContain(d.title);
      expect(text, d.canonicalId!).not.toContain("corpus.synthetic-health.invalid");
    }
  });

  it("contains nothing but stored chunk text in the evidence fields", () => {
    const allowed = new Set([...chunkText.values()]);
    for (const i of [...allItems(), ...bundle.historical_context]) expect(allowed.has(i.excerpt) || historicalViewFromPrepared().items.some((d) => d.chunks.some((c) => c.text === i.excerpt))).toBe(true);
  });
});

describe("exclusions are persisted exactly as ranked", () => {
  const facts = makeFacts();
  const retrieval = retrieveFromCorpus({ ...view, activeSnapshot: SNAPSHOT }, facts, RETRIEVAL_CONFIG_DEV);
  const hv = historicalViewFromPrepared();
  const historical = retrieveFromCorpus({ ...hv, activeSnapshot: SNAPSHOT }, facts, historicalRetrievalConfig(RETRIEVAL_CONFIG_DEV));
  const ranking = rankEvidence({ facts, retrieval, historical, view: { ...view, activeSnapshot: SNAPSHOT } });

  it("lists every ranking exclusion, in the ranking's order, with id, reason and family", () => {
    expect(bundle.excluded.map((e) => [e.id, e.reason, e.family, e.facet])).toEqual(ranking.exclusions.ranking.map((e) => [e.candidate.chunkId, e.reason, e.family, e.facet]));
    expect(bundle.excluded.length).toBe(bundle.stats.excluded_candidates);
    expect(hv.items.length).toBeGreaterThan(0);
  });

  it("preserves duplicate removals with the retained candidate, rule and basis", () => {
    const dups = bundle.excluded.filter((e) => e.reason === "duplicate");
    expect(dups).toHaveLength(4);
    for (const e of dups) {
      const d = e.detail as { rule: string; basis: string; retained: { canonical_id: string; chunk_ordinal: number } };
      expect(d.rule).toBe("same_content_hash");
      expect(d.retained.canonical_id).toBe("syn-ads-verification-guidance");
      expect(d.basis).toMatch(/content_hash/);
    }
  });

  it("preserves diversity, top-K and relevance-floor removals with their limits", () => {
    const by = (r: string) => bundle.excluded.filter((e) => e.reason === r);
    expect(by("document_diversity").map((e) => (e.detail as { limit: number }).limit)).toEqual([2, 2]);
    expect(by("publisher_diversity").map((e) => (e.detail as { limit: number }).limit)).toEqual([3]);
    expect(by("beyond_top_k").length).toBe(21);
    expect(by("below_relevance_floor").length).toBe(7);
    expect(bundle.stats.exclusions_by_reason).toEqual(ranking.exclusions.counts);
  });

  it("keeps the raw and normalised score on each excluded candidate that reached scoring", () => {
    for (const e of bundle.excluded.filter((x) => ["duplicate", "document_diversity", "beyond_top_k", "below_relevance_floor"].includes(x.reason))) {
      expect((e.score_components as { relevance: { bm25: number } }).relevance.bm25).toBe(e.bm25_score);
    }
  });

  it("keeps the document-level retrieval exclusion summary", () => {
    expect(bundle.retrieval_exclusions.notable.length).toBeGreaterThan(0);
    expect(bundle.retrieval_exclusions.counts.verification_guidance).toBeDefined();
  });

  it("never lists a chunk as both selected and excluded WITHIN the same facet (it may be excluded in one facet and selected in another)", () => {
    for (const f of bundle.facets) {
      const selected = new Set(f.items.map((i) => i.chunk_id));
      for (const e of bundle.excluded.filter((x) => x.section === "main" && x.facet === f.name)) expect(selected.has(e.id), `${f.name}/${e.id}`).toBe(false);
    }
  });
});

describe("conflicts (curator-tagged only)", () => {
  const PAIR = ["syn-conflict-reporting-deadline-a", "syn-conflict-reporting-deadline-b"];
  const TAGS = {
    "syn-conflict-reporting-deadline-a": { questionKey: "reporting_deadline", position: "within_24_hours" },
    "syn-conflict-reporting-deadline-b": { questionKey: "reporting_deadline", position: "within_72_hours" },
  };
  const slim: CorpusView = { ...view, items: view.items.filter((i) => PAIR.includes(i.canonicalId!)) };
  const open = makeRankingConfig({ relevanceFloor: 0 });

  it("reports no conflict from untagged documents, however opposed their wording", () => {
    expect(referenceBundle({ view: slim, historicalView: null, ranking: open }).conflicts).toEqual([]);
    expect(bundle.conflicts).toEqual([]);
    expect(bundle.stats.conflicts).toBe(0);
  });

  it("persists a tagged conflict exactly as ranked, marked as curator-tagged, with citations", () => {
    const b = referenceBundle({ view: withTags(slim, TAGS), historicalView: null, ranking: open });
    expect(b.conflicts).toHaveLength(1);
    const c = b.conflicts[0];
    expect(c).toMatchObject({ kind: "curator_tagged_conflict", question_key: "reporting_deadline", basis: "curator_tags" });
    expect(c.note).toMatch(/No disagreement was inferred/);
    expect(c.positions.map((p) => p.position)).toEqual(["within_24_hours", "within_72_hours"]);
    const cited = new Map(b.citations.map((x) => [x.citation_id, x]));
    for (const p of c.positions) {
      for (const d of p.documents) {
        expect(d.citation_ids.length).toBeGreaterThan(0);
        for (const id of d.citation_ids) expect(cited.get(id)!.evidence_item_id).toBe(d.evidence_item_id);
        expect(d).toMatchObject({ publisher: expect.any(String), source_class: expect.any(String) });
      }
    }
    expect(b.stats.conflicts).toBe(1);
  });

  it("is the M4.3 conflict, key for key", () => {
    const tagged = withTags(slim, TAGS);
    const facts = makeFacts();
    const retrieval = retrieveFromCorpus({ ...tagged, activeSnapshot: SNAPSHOT }, facts, RETRIEVAL_CONFIG_DEV);
    const m43 = rankEvidence({ facts, retrieval, view: { ...tagged, activeSnapshot: SNAPSHOT }, config: open }).conflicts[0];
    const b = referenceBundle({ view: tagged, historicalView: null, ranking: open }).conflicts[0];
    const strip = (x: unknown) => JSON.parse(JSON.stringify(x, (k, v) => (k === "citation_ids" || k === "kind" ? undefined : v)));
    expect(strip(b)).toEqual(strip(snakeKeys(m43)));
  });
});

describe("gaps are persisted exactly, with no new categories", () => {
  const M43_CODES = ["no_eligible_evidence", "facet_not_covered", "missing_local_evidence", "no_current_guidance", "all_evidence_old", "only_synthetic_evidence", "contradicting_evidence"];

  it("equals the M4.3 gaps for the reference signal", () => {
    const facts = makeFacts();
    const retrieval = retrieveFromCorpus({ ...view, activeSnapshot: SNAPSHOT }, facts, RETRIEVAL_CONFIG_DEV);
    const m43 = rankEvidence({ facts, retrieval, view: { ...view, activeSnapshot: SNAPSHOT } }).gaps;
    expect(bundle.gaps).toEqual(snakeKeys(m43));
    expect(bundle.gaps.map((g) => g.code)).toEqual(["only_synthetic_evidence"]);
    expect(bundle.stats.gaps).toBe(1);
  });

  it("uses only the M4.3 gap codes, in every scenario", () => {
    for (const syndrome of SYNDROMES) {
      for (const v of [view, { items: [], activeSnapshot: null } as CorpusView]) {
        for (const g of referenceBundle({ facts: makeFacts({ syndrome }), view: v, historicalView: null }).gaps) expect(M43_CODES).toContain(g.code);
      }
    }
  });

  it("supports an empty result explicitly: no items, no citations, no exclusions, an explicit gap, and a valid hash", () => {
    const e = referenceBundle({ view: { items: [], activeSnapshot: null }, historicalView: null });
    expect(e.citations).toEqual([]);
    expect(e.historical_context).toEqual([]);
    expect(e.excluded).toEqual([]);
    expect(e.gaps[0]).toMatchObject({ code: "no_eligible_evidence", scope: "signal", message: "no eligible evidence was found for this signal" });
    expect(e.stats).toMatchObject({ eligible_candidates: 0, selected_chunks: 0, selected_slots: 0, selected_documents: 0, facets_covered: 0, facets_total: 4, conflicts: 0 });
    expect(bundleHashOf(e)).toBe(e.bundle_hash);
    expect(e.facets.every((f) => f.items.length === 0)).toBe(true);
  });

  it("states an absence as a gap rather than filling it", () => {
    const e = referenceBundle({ view: { items: [], activeSnapshot: null }, historicalView: null });
    expect(JSON.stringify(e.facets)).not.toMatch(/"excerpt":"[^"]/);
    expect(e.gaps.map((g) => g.code)).toEqual(["no_eligible_evidence", "facet_not_covered", "facet_not_covered", "facet_not_covered", "facet_not_covered", "missing_local_evidence", "no_current_guidance"]);
  });
});

describe("thin evidence", () => {
  it("is represented honestly: a single document gives a bundle with the gaps that follow", () => {
    const one: CorpusView = { ...view, items: view.items.filter((i) => i.canonicalId === "syn-ads-case-definition") };
    const b = referenceBundle({ view: one, historicalView: null });
    expect(b.stats.selected_documents).toBe(1);
    expect(b.stats.facets_covered).toBeLessThan(4);
    const codes = b.gaps.map((g) => g.code);
    expect(codes).toContain("facet_not_covered");
    expect(codes).toContain("no_current_guidance");
    expect(codes).toContain("only_synthetic_evidence");
  });
});

describe("historical context", () => {
  const wide = makeRankingConfig({ topK: 40 });
  const b = referenceBundle({ ranking: wide });

  it("appears only when the successor is selected, keeps the relationship, and gets its own citation ids", () => {
    const old = b.historical_context.filter((h) => h.canonical_id === "syn-ads-verification-guidance-2022");
    expect(old.length).toBeGreaterThan(0);
    for (const h of old) {
      expect(h.relation).toEqual({ status: "superseded", superseded_by: ["syn-ads-verification-guidance-2025"] });
      expect(b.citations.find((c) => c.citation_id === h.citation_id)!.section).toBe("historical_context");
    }
    expect(bundle.historical_context).toEqual([]); // default top-K: the successor is not selected, so nothing is shown
  });

  it("never places superseded or withdrawn evidence in the main facets", () => {
    const main = b.facets.flatMap((f) => f.items.map((i) => i.canonical_id));
    expect(main).not.toContain("syn-ads-verification-guidance-2022");
    expect(main).toContain("syn-ads-verification-guidance-2025");
    expect(JSON.stringify(b.historical_context)).not.toContain("syn-fev-guidance-withdrawn");
    const fever = referenceBundle({ facts: makeFacts({ syndrome: "fever" }), ranking: wide });
    expect([...fever.facets.flatMap((f) => f.items), ...fever.historical_context].some((i) => i.canonical_id === "syn-fev-guidance-withdrawn")).toBe(false);
  });

  it("numbers historical citations after the main ones and keeps ids unique", () => {
    const ids = b.citations.map((c) => c.citation_id);
    expect(new Set(ids).size).toBe(ids.length);
    const lastMain = Math.max(...b.citations.filter((c) => c.section === "main").map((c) => Number(c.citation_id.slice(1))));
    for (const c of b.citations.filter((x) => x.section === "historical_context")) expect(Number(c.citation_id.slice(1))).toBeGreaterThan(lastMain);
  });

  it("numbers several historical items in one flat section (1..n), cited after the main items, one id per chunk", () => {
    const facts = makeFacts();
    const snap = { ...view, activeSnapshot: SNAPSHOT };
    const retrieval = retrieveFromCorpus(snap, facts, RETRIEVAL_CONFIG_DEV);
    const historical = retrieveFromCorpus({ ...historicalViewFromPrepared(), activeSnapshot: SNAPSHOT }, facts, historicalRetrievalConfig(RETRIEVAL_CONFIG_DEV));
    const ranking = rankEvidence({ facts, retrieval, historical, view: snap, config: wide });
    const h = ranking.historicalContext[0];
    const three = { ...ranking, historicalContext: [h, { ...h, chunkId: `${h.chunkId}-b`, facet: "case_definition" as const }, { ...h, chunkId: `${h.chunkId}-c`, facet: "regional_context" as const }] };
    const out = buildBundle({ facts, identity: IDENTITY, retrieval, ranking: three, retrievedAt: RETRIEVED_AT });
    const lastMain = Math.max(...out.citations.filter((c) => c.section === "main").map((c) => Number(c.citation_id.slice(1))));
    expect(out.historical_context.map((x) => x.rank)).toEqual([1, 2, 3]);
    expect(out.historical_context.map((x) => x.citation_id)).toEqual([1, 2, 3].map((n) => `E${lastMain + n}`));
    expect(out.historical_context.map((x) => x.facet)).toEqual([h.facet, "case_definition", "regional_context"]);
    expect(out.citations.filter((c) => c.section === "historical_context")).toHaveLength(3);
    expect(out.stats.historical_context_items).toBe(3);
  });

  it("keeps historical chunks out of the selected-evidence statistics and counts them separately", () => {
    expect(b.historical_context.length).toBeGreaterThan(0);
    expect(b.stats.historical_context_items).toBe(b.historical_context.length);
    expect(b.stats.selected_chunks).toBe(b.citations.filter((c) => c.section === "main").length);
    expect(b.stats.selected_chunks).toBeLessThan(b.citations.length);
  });

  it("records the withholding in the exclusion log when the successor is not selected", () => {
    expect(bundle.excluded.some((e) => e.section === "historical_context" && e.reason === "superseded")).toBe(true);
  });
});

describe("statistics", () => {
  it("are exact, deterministic and free of timestamps", () => {
    expect(bundle.stats).toEqual({
      eligible_candidates: 52, selected_chunks: 16, selected_slots: 17, selected_documents: 10, excluded_candidates: 37,
      exclusions_by_reason: { "historical_context:superseded": 2, "main:below_relevance_floor": 7, "main:beyond_top_k": 21, "main:document_diversity": 2, "main:duplicate": 4, "main:publisher_diversity": 1 },
      facets_covered: 4, facets_total: 4, gaps: 1, conflicts: 0, historical_context_items: 0, selected_synthetic: 16, selected_non_synthetic: 0,
      tier_distribution: {
        intergovernmental_health_authority: 2, national_government_health_agency: 3, state_government_health_agency: 3, peer_reviewed_literature: 3, recognized_institution: 3, other_verified: 2,
      },
    });
    expect(JSON.stringify(bundle.stats)).not.toMatch(/20\d\d-\d\d-\d\dT/);
  });

  it("count distinct chunks once even when a chunk fills several facet slots", () => {
    expect(bundle.stats.selected_slots).toBe(allItems().length);
    expect(bundle.stats.selected_chunks).toBe(new Set(allItems().map((i) => i.citation_id)).size);
    expect(bundle.stats.selected_slots).toBeGreaterThan(bundle.stats.selected_chunks);
    expect(Object.values(bundle.stats.tier_distribution).reduce((a, b) => a + b, 0)).toBe(bundle.stats.selected_chunks);
  });
});

describe("the retrieved_at stamp", () => {
  it("is carried in the bundle and excluded from its hash", () => {
    expect(bundle.retrieved_at).toBe(RETRIEVED_AT);
    expect(referenceBundle().bundle_hash).toBe(bundle.bundle_hash);
  });
});
