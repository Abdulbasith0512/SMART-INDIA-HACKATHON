// @vitest-environment node
import { describe, expect, it } from "vitest";
import { RETRIEVAL_CONFIG_DEV, retrievalConfigHash } from "../retrieval/config";
import type { CorpusItem, CorpusView } from "../retrieval/corpus";
import { retrieveFromCorpus, type RetrievalResult } from "../retrieval/retrieve";
import { ganjamFacts, historicalViewFromPrepared, makeFacts, otherStateFacts, SYNDROMES, uid, viewFromPrepared, withTags } from "../retrieval/testkit";
import { QUERY_FACETS } from "../vocab";
import { CONTRADICTS_SIGNAL } from "./conflicts";
import { retrieveAndRank } from "./pipeline";
import { RANKING_CONFIG_V1, RANK_NOTICE, makeRankingConfig, rankingConfigHash, roundRank } from "./policy";
import { comparePresentation, rankEvidence, type PresentationKey } from "./rank";
import { FAMILY_OF, type RankedEvidence, type RankedFacet } from "./types";

const view = viewFromPrepared();
const hview = historicalViewFromPrepared();
const DEV = RETRIEVAL_CONFIG_DEV;

/** Pinned: the M4.2 reference signal / retrieval outputs must be unchanged by M4.3, and the ranking is itself pinned. */
const M42_REFERENCE_RESULT_HASH = "fa55022a2264168cc0ac30878313a1e6438e818156aa30d517f3c08dbadedd5a";
const M42_REFERENCE_QUERY_HASH = "e2cc3e663c47c5b585f85685408e6641477d1e8c53d1d97a4707b4aba9bd9f76";
const M42_DEV_CONFIG_HASH = "029b517ac9986c47588303c98a594a2fc9819371f3f3f201f3e199894bccda7f";
const M42_CORPUS_DIGEST = "cbd9f2ab2beb450d2a4813d7fa70e782ffc899f9f392d6c1f4c54da6d840014a";
const GOLDEN_RANKING_HASH = "01f7ac49042828fa487a2cfdbc02a942416df7ac30c22fca6115b4682fcdbf5f";

const run = (facts = makeFacts(), over: { view?: CorpusView; historicalView?: CorpusView | null; config?: ReturnType<typeof makeRankingConfig>; asOfDate?: string } = {}): RankedEvidence =>
  retrieveAndRank({
    facts, view: over.view ?? view, historicalView: over.historicalView === undefined ? hview : over.historicalView, retrievalConfig: DEV,
    rankingConfig: over.config, options: { asOfDate: over.asOfDate },
  });
const facet = (r: RankedEvidence, n: string): RankedFacet => r.facets.find((f) => f.facet === n)!;
const selectedIds = (r: RankedEvidence, n: string) => facet(r, n).selected.map((c) => `${c.canonicalId}#${c.chunkOrdinal}`);
const reasons = (r: RankedEvidence, n: string) => facet(r, n).excluded.map((e) => e.reason);

/** Clone a retrieval result and mutate the candidates that match, as a hostile or buggy upstream might. */
function patched(result: RetrievalResult, facetName: string, pick: (c: RetrievalResult["facets"][number]["candidates"][number]) => boolean, mutate: (c: RetrievalResult["facets"][number]["candidates"][number]) => void): RetrievalResult {
  const copy = structuredClone(result);
  for (const c of copy.facets.find((f) => f.facet === facetName)!.candidates) if (pick(c)) mutate(c);
  return copy;
}
const rankOf = (retrieval: RetrievalResult, facts = makeFacts(), v = view, config?: ReturnType<typeof makeRankingConfig>) => rankEvidence({ facts, retrieval, view: v, config });

describe("the reference ranking", () => {
  const r = run();

  it("leaves the M4.2 reference query, configuration, corpus digest and result exactly as they were", () => {
    const m42 = retrieveFromCorpus(view, makeFacts(), DEV);
    expect(m42.resultHash).toBe(M42_REFERENCE_RESULT_HASH);
    expect(m42.query.hash).toBe(M42_REFERENCE_QUERY_HASH);
    expect(m42.corpus.digest).toBe(M42_CORPUS_DIGEST);
    expect(retrievalConfigHash(DEV)).toBe(M42_DEV_CONFIG_HASH);
    expect(r.retrieval).toMatchObject({ resultHash: M42_REFERENCE_RESULT_HASH, queryHash: M42_REFERENCE_QUERY_HASH, corpusDigest: M42_CORPUS_DIGEST, configHash: M42_DEV_CONFIG_HASH });
  });

  it("is pinned by a content-addressed ranking hash and records both configurations", () => {
    expect(r.rankingHash).toBe(GOLDEN_RANKING_HASH);
    expect(r.ranking).toEqual({ version: "ranking/1.0.0", configHash: rankingConfigHash(RANKING_CONFIG_V1) });
    expect(r.schema).toBe("evidence-ranking/1");
    expect(r.asOfDate).toBe("2025-09-07");
  });

  it("states what the score is, and is not", () => {
    expect(r.notice).toBe(RANK_NOTICE);
    expect(r.notice).toMatch(/presentation priority for a verifier, not the probability that an evidence item is correct/);
  });

  it("uses no probability-like vocabulary anywhere in its structure", () => {
    const keys = JSON.stringify(r).match(/"[a-zA-Z0-9_]+":/g)!.map((k) => k.slice(1, -2).toLowerCase());
    for (const banned of ["probability", "confidence", "likelihood", "truth", "accuracy", "trust_score", "credibility"]) expect(keys).not.toContain(banned);
  });

  it("covers the four facets in order", () => {
    expect(r.facets.map((f) => f.facet)).toEqual([...QUERY_FACETS]);
  });

  it("the best verification-guidance evidence is the syndrome's own national verification procedure", () => {
    expect(selectedIds(r, "verification_guidance")[0]).toBe("syn-ads-verification-guidance#0");
    expect(selectedIds(r, "case_definition")[0]).toBe("syn-ads-case-definition#0");
    expect(selectedIds(r, "regional_context")[0]).toBe("syn-ads-odisha-context#0");
  });
});

describe("every score component is recorded and the formula holds", () => {
  for (const syndrome of SYNDROMES) {
    for (const [gname, factsFn] of [["Khordha", makeFacts], ["Ganjam", ganjamFacts], ["another state", otherStateFacts]] as const) {
      it(`${syndrome} / ${gname}`, () => {
        const r = run(factsFn({ syndrome }));
        for (const f of r.facets) {
          expect(f.selected.length).toBeLessThanOrEqual(5);
          f.selected.forEach((c, i) => {
            const s = c.scoreComponents;
            expect(c.rank).toBe(i + 1);
            expect(s.formula).toBe("normalised_relevance x class_factor x geo_factor x temporal_factor");
            expect(s.relevance.bm25).toBe(c.bm25Score);
            expect(s.relevance.value).toBe(roundRank(c.bm25Score / s.relevance.normalisedBy));
            expect(s.relevance.value).toBeGreaterThanOrEqual(RANKING_CONFIG_V1.relevance.floor);
            expect(s.relevance.value).toBeLessThanOrEqual(1);
            expect(Object.values(RANKING_CONFIG_V1.classFactor.table)).toContain(s.classFactor.value);
            expect(s.classFactor.sourceClass).toBe(c.metadata.sourceClass);
            expect(s.classFactor.tierLabel).toBe(c.tierLabel);
            expect(Object.values(RANKING_CONFIG_V1.geoFactor.table)).toContain(s.geoFactor.value);
            expect(s.geoFactor.evidenceScope).toBe(c.metadata.geoScope);
            expect(s.geoFactor.reason.length).toBeGreaterThan(5);
            expect([1, 0.6, 0.3]).toContain(s.temporalFactor.value);
            expect(s.rankScore).toBe(roundRank(s.relevance.value * s.classFactor.value * s.geoFactor.value * s.temporalFactor.value));
            if (i > 0) expect(s.rankScore).toBeLessThanOrEqual(f.selected[i - 1].scoreComponents.rankScore);
          });
        }
      });
    }
  }
});

describe("nothing is silently discarded", () => {
  it.each(SYNDROMES)("%s: every retrieved candidate is either selected or has exactly one machine-readable reason", (syndrome) => {
    const facts = makeFacts({ syndrome });
    const retrieval = retrieveFromCorpus(view, facts, DEV);
    const r = rankOf(retrieval, facts);
    for (const f of r.facets) {
      const source = retrieval.facets.find((x) => x.facet === f.facet)!.candidates.map((c) => c.chunkId).sort();
      const selected = f.selected.map((c) => c.chunkId);
      const excluded = f.excluded.map((e) => e.candidate.chunkId);
      expect([...selected, ...excluded].sort()).toEqual(source);
      expect(new Set([...selected, ...excluded]).size).toBe(source.length); // no candidate in both lists
      for (const e of f.excluded) {
        expect(e.family).toBe(FAMILY_OF[e.reason]);
        expect(e.detail.message.length).toBeGreaterThan(5);
        expect(e.section).toBe("main");
      }
      expect(f.stats.retrieved).toBe(source.length);
    }
  });

  it("counts every exclusion by section and reason", () => {
    const r = run();
    expect(r.exclusions.counts).toEqual({
      "historical_context:superseded": 2, "main:below_relevance_floor": 7, "main:beyond_top_k": 21, "main:document_diversity": 2, "main:duplicate": 4, "main:publisher_diversity": 1,
    });
    expect(Object.values(r.exclusions.counts).reduce((a, b) => a + b, 0)).toBe(r.exclusions.ranking.length);
  });

  it("keeps the raw and normalised score on every excluded candidate that got that far", () => {
    for (const e of run().exclusions.ranking.filter((x) => ["duplicate", "document_diversity", "beyond_top_k", "below_relevance_floor"].includes(x.reason))) {
      expect(e.scoreComponents.relevance?.bm25).toBe(e.bm25Score);
      expect(e.scoreComponents.rankScore).toBeTypeOf("number");
    }
  });
});

describe("hard re-checks: wrong place and out-of-force evidence are excluded, never down-weighted", () => {
  const facts = makeFacts();
  const base = retrieveFromCorpus(view, facts, DEV);
  const topOf = (n: string) => base.facets.find((f) => f.facet === n)!.candidates[0];

  it("excludes wrong-district and wrong-state evidence fed in by an upstream bug, with a geographic reason", () => {
    for (const [scope, id] of [["district", uid("region:SYN-OD-GAN")], ["state", uid("region:OTHER-STATE")]] as const) {
      const top = topOf("case_definition");
      const bad = patched(base, "case_definition", (c) => c.chunkId === top.chunkId, (c) => {
        c.metadata.geoScope = scope;
        c.metadata.geoRegionId = id;
      });
      const r = rankOf(bad, facts);
      const e = facet(r, "case_definition").excluded.find((x) => x.candidate.chunkId === top.chunkId)!;
      expect(e).toMatchObject({ reason: "geographic_ineligible", family: "geographic_ineligible" });
      expect(selectedIds(r, "case_definition")).not.toContain(`${top.canonicalId}#${top.chunkOrdinal}`);
    }
  });

  it("an excluded candidate never sets the normalisation maximum", () => {
    const top = topOf("case_definition");
    const second = base.facets.find((f) => f.facet === "case_definition")!.candidates[1];
    const bad = patched(base, "case_definition", (c) => c.chunkId === top.chunkId, (c) => {
      c.metadata.geoScope = "district";
      c.metadata.geoRegionId = uid("region:SYN-OD-GAN");
    });
    const f = facet(rankOf(bad, facts), "case_definition");
    expect(f.stats.normalisedBy).toBe(second.bm25Score);
    expect(f.selected[0].scoreComponents.relevance.value).toBe(1);
    expect(f.stats.rankable).toBe(f.stats.retrieved - 1);
  });

  it.each([
    ["withdrawn", { status: "withdrawn" }, "withdrawn"],
    ["superseded", { status: "superseded" }, "superseded"],
    ["historical", { status: "historical" }, "historical"],
    ["quarantined", { status: "quarantined" }, "not_current"],
    ["published after the as-of date", { publicationDate: "2025-09-08" }, "look_ahead"],
    ["not yet valid", { validFrom: "2025-12-01" }, "not_yet_valid"],
    ["expired guidance", { validUntil: "2025-01-01", evidenceKind: "operational_guidance" }, "expired"],
  ])("excludes %s evidence from the main list with reason %s", (_n, patch, reason) => {
    const top = topOf("verification_guidance");
    const bad = patched(base, "verification_guidance", (c) => c.chunkId === top.chunkId, (c) => Object.assign(c.metadata, { evidenceKind: "operational_guidance" }, patch));
    const e = facet(rankOf(bad, facts), "verification_guidance").excluded.find((x) => x.candidate.chunkId === top.chunkId)!;
    expect(e.reason).toBe(reason);
    expect(e.family).toBe("temporal_ineligible");
  });

  it("excludes an unverified source if one is ever fed in", () => {
    const top = topOf("case_definition");
    const bad = patched(base, "case_definition", (c) => c.chunkId === top.chunkId, (c) => (c.metadata.sourceClass = "unverified"));
    expect(facet(rankOf(bad, facts), "case_definition").excluded.find((x) => x.candidate.chunkId === top.chunkId)).toMatchObject({ reason: "source_class_not_rankable", family: "source_ineligible" });
  });

  it("looks no further at what M4.2 already guarantees: a clean result produces no hard exclusions", () => {
    const r = rankOf(base, facts);
    const hard = ["geographic_ineligible", "withdrawn", "superseded", "historical", "not_current", "expired", "look_ahead", "not_yet_valid", "source_class_not_rankable"];
    expect(r.exclusions.ranking.filter((e) => hard.includes(e.reason) && e.section === "main")).toEqual([]);
  });
});

describe("the relevance floor", () => {
  it("removes candidates whose normalised relevance is below 0.10 and says so", () => {
    const f = facet(run(), "epidemiological_context");
    const below = f.excluded.filter((e) => e.reason === "below_relevance_floor");
    expect(below.length).toBeGreaterThan(0);
    for (const e of below) {
      expect(e.scoreComponents.relevance!.value).toBeLessThan(0.1);
      expect(e.detail.limit).toBe(0.1);
    }
    for (const c of f.selected) expect(c.scoreComponents.relevance.value).toBeGreaterThanOrEqual(0.1);
  });

  it("is a policy value: a floor of 0 keeps everything the floor would have removed", () => {
    const strict = run();
    const open = run(makeFacts(), { config: makeRankingConfig({ relevanceFloor: 0, topK: 100 }) });
    expect(reasons(open, "epidemiological_context")).not.toContain("below_relevance_floor");
    expect(facet(open, "epidemiological_context").selected.length).toBeGreaterThan(facet(strict, "epidemiological_context").selected.length);
  });

  it("a facet whose every candidate is weak reports a coverage gap instead of padding", () => {
    const retrieval = retrieveFromCorpus(view, makeFacts(), DEV);
    // One strong candidate and the rest negligible: only the strong one survives the floor.
    const squashed = structuredClone(retrieval);
    const f = squashed.facets.find((x) => x.facet === "case_definition")!;
    f.candidates.forEach((c, i) => (c.bm25Score = i === 0 ? 100 : 1));
    const out = facet(rankOf(squashed), "case_definition");
    expect(out.selected).toHaveLength(1);
    expect(out.excluded.every((e) => e.reason === "below_relevance_floor")).toBe(true);
  });
});

describe("source-class factor in the pipeline", () => {
  it("with equal lexical relevance, a higher-tier source is presented first", () => {
    const facts = makeFacts();
    const base = retrieveFromCorpus(view, facts, DEV);
    const cands = base.facets.find((f) => f.facet === "case_definition")!.candidates;
    const a = cands.find((c) => c.canonicalId === "syn-ads-case-definition" && c.chunkOrdinal === 0)!;
    const b = cands.find((c) => c.canonicalId === "syn-ads-clinical-reference" && c.chunkOrdinal === 2)!;
    const tied = patched(base, "case_definition", (c) => c.chunkId === b.chunkId, (c) => (c.bm25Score = a.bm25Score));
    const sel = facet(rankOf(tied, facts), "case_definition").selected;
    const ia = sel.findIndex((c) => c.chunkId === a.chunkId);
    const ib = sel.findIndex((c) => c.chunkId === b.chunkId);
    expect(ia).toBeLessThan(ib);
    expect(sel[ia].scoreComponents.classFactor.value).toBeGreaterThan(sel[ib].scoreComponents.classFactor.value);
  });

  it("a different class table changes the scores but never the retrieved candidates", () => {
    const flat = makeRankingConfig({ classTable: Object.fromEntries(Object.entries(RANKING_CONFIG_V1.classFactor.table).map(([k, v]) => [k, v === null ? null : 1])) as never });
    const a = run();
    const b = run(makeFacts(), { config: flat });
    expect(b.retrieval).toEqual(a.retrieval);
    expect(b.ranking.configHash).not.toBe(a.ranking.configHash);
    expect(b.facets[0].selected[0].scoreComponents.classFactor.value).toBe(1);
  });
});

describe("presentation order (identifiers are only the final tie-break)", () => {
  const k = (o: Partial<PresentationKey> = {}): PresentationKey => ({ rankScore: 0.5, tier: 3, geoScope: "state", bm25: 5, key: "doc-m", ordinal: 1, chunkId: "c-m", ...o });
  const before = (a: Partial<PresentationKey>, b: Partial<PresentationKey>) => expect(comparePresentation(k(a), k(b))).toBeLessThan(0);

  it("orders by rank score first", () => before({ rankScore: 0.6, tier: 7, key: "zzz" }, { rankScore: 0.5, tier: 1, key: "aaa" }));
  it("then by source tier", () => before({ tier: 1, geoScope: "global", bm25: 1, key: "zzz" }, { tier: 2, geoScope: "district", bm25: 9, key: "aaa" }));
  it("then by geographic specificity", () => before({ geoScope: "district", bm25: 1, key: "zzz" }, { geoScope: "state", bm25: 9, key: "aaa" }));
  it("then by raw lexical score", () => before({ bm25: 9, key: "zzz" }, { bm25: 1, key: "aaa" }));
  it("only then by canonical id, chunk ordinal and chunk id", () => {
    before({ key: "doc-a" }, { key: "doc-b" });
    before({ ordinal: 0 }, { ordinal: 1 });
    before({ chunkId: "c-a" }, { chunkId: "c-b" });
    expect(comparePresentation(k(), k())).toBe(0);
  });
  it("is a consistent total order", () => {
    const items = [k({ rankScore: 0.9 }), k({ tier: 1 }), k({ geoScope: "district" }), k({ bm25: 9 }), k({ key: "doc-a" }), k({ ordinal: 0 }), k({ chunkId: "c-a" }), k()];
    const sorted = [...items].sort(comparePresentation);
    for (let i = 1; i < sorted.length; i += 1) expect(comparePresentation(sorted[i - 1], sorted[i])).toBeLessThanOrEqual(0);
    expect([...items].reverse().sort(comparePresentation)).toEqual(sorted);
  });
});

describe("deduplication in the pipeline", () => {
  const r = run();

  it("removes the exact copy in favour of the higher-tier original, recording what was kept and why", () => {
    const dup = facet(r, "verification_guidance").excluded.filter((e) => e.reason === "duplicate");
    expect(dup).toHaveLength(4);
    for (const e of dup) {
      expect(e.candidate.canonicalId).toBe("syn-ads-verification-exact-copy");
      expect(e.candidate.sourceClass).toBe("other_verified");
      expect(e.detail.rule).toBe("same_content_hash");
      expect(e.detail.retained).toMatchObject({ canonicalId: "syn-ads-verification-guidance", sourceClass: "national_government_health_agency", chunkOrdinal: e.candidate.chunkOrdinal });
      expect(e.detail.basis).toMatch(/content_hash/);
      expect(e.family).toBe("duplicate");
    }
  });

  it("never lets a duplicate and its retained twin both appear in the selected evidence", () => {
    const ids = selectedIds(r, "verification_guidance");
    expect(ids.some((x) => x.startsWith("syn-ads-verification-exact-copy"))).toBe(false);
    expect(ids).toContain("syn-ads-verification-guidance#0");
  });

  it("retains the higher-tier candidate even when the lower-tier twin has the higher lexical score", () => {
    const facts = makeFacts();
    const base = retrieveFromCorpus(view, facts, DEV);
    const orig = base.facets[0].candidates.find((c) => c.canonicalId === "syn-ads-verification-guidance" && c.chunkOrdinal === 0)!;
    const bumped = patched(base, "verification_guidance", (c) => c.canonicalId === "syn-ads-verification-exact-copy" && c.chunkOrdinal === 0, (c) => (c.bm25Score = orig.bm25Score * 1.5));
    const f = facet(rankOf(bumped, facts), "verification_guidance");
    expect(f.excluded.find((e) => e.candidate.canonicalId === "syn-ads-verification-exact-copy" && e.candidate.chunkOrdinal === 0)).toMatchObject({ reason: "duplicate" });
    expect(f.selected.some((c) => c.canonicalId === "syn-ads-verification-guidance" && c.chunkOrdinal === 0)).toBe(true);
  });

  it("detects a near-duplicate chunk by shingle Jaccard and records the similarity", () => {
    const original = view.items.find((i) => i.canonicalId === "syn-ads-verification-guidance")!;
    const nearItem = view.items.find((i) => i.canonicalId === "syn-ads-verification-near-duplicate")!;
    const text = `${original.chunks[0].text} Also noted locally.`;
    const v: CorpusView = {
      ...view,
      items: view.items.map((i) => (i.id === nearItem.id ? { ...i, chunks: i.chunks.map((c, n) => (n === 0 ? { ...c, text, chunkHash: "d".repeat(64) } : c)) } : i)),
    };
    const out = run(makeFacts(), { view: v, historicalView: null });
    const e = facet(out, "verification_guidance").excluded.find((x) => x.reason === "near_duplicate");
    expect(e).toBeDefined();
    expect(e!.candidate.canonicalId).toBe("syn-ads-verification-near-duplicate");
    expect(e!.detail).toMatchObject({ rule: "near_duplicate" });
    expect(e!.detail.jaccard!).toBeGreaterThanOrEqual(0.85);
    expect(e!.detail.retained!.canonicalId).toBe("syn-ads-verification-guidance");
  });

  it("is insensitive to whitespace and Unicode differences when detecting near-duplicates", () => {
    const original = view.items.find((i) => i.canonicalId === "syn-ads-verification-guidance")!;
    const nearItem = view.items.find((i) => i.canonicalId === "syn-ads-verification-near-duplicate")!;
    const messy = original.chunks[0].text.toUpperCase().replace(/ /g, "  \n ").replace(/CLUSTER/g, "ＣＬＵＳＴＥＲ");
    const v: CorpusView = { ...view, items: view.items.map((i) => (i.id === nearItem.id ? { ...i, chunks: i.chunks.map((c, n) => (n === 0 ? { ...c, text: messy, chunkHash: "e".repeat(64) } : c)) } : i)) };
    const e = facet(run(makeFacts(), { view: v, historicalView: null }), "verification_guidance").excluded.find((x) => x.candidate.canonicalId === "syn-ads-verification-near-duplicate" && x.candidate.chunkOrdinal === 0);
    expect(e).toMatchObject({ reason: "near_duplicate" });
    expect(e!.detail.jaccard).toBe(1);
  });
});

describe("diversity (at most 2 chunks per document, 3 per publisher)", () => {
  it("never exceeds either limit for any syndrome, geography or facet", () => {
    for (const syndrome of SYNDROMES) {
      for (const factsFn of [makeFacts, ganjamFacts, otherStateFacts]) {
        for (const f of run(factsFn({ syndrome })).facets) {
          const perDoc = new Map<string, number>();
          const perPub = new Map<string, number>();
          for (const c of f.selected) {
            perDoc.set(c.evidenceItemId, (perDoc.get(c.evidenceItemId) ?? 0) + 1);
            perPub.set(c.metadata.publisher, (perPub.get(c.metadata.publisher) ?? 0) + 1);
          }
          expect(Math.max(0, ...perDoc.values())).toBeLessThanOrEqual(2);
          expect(Math.max(0, ...perPub.values())).toBeLessThanOrEqual(3);
        }
      }
    }
  });

  it("records document-diversity removals with the limit, the document and the explicit reason", () => {
    const e = facet(run(), "case_definition").excluded.find((x) => x.reason === "document_diversity")!;
    expect(e.candidate.canonicalId).toBe("syn-ads-case-definition");
    expect(e.detail).toMatchObject({ limit: 2, key: "syn-ads-case-definition" });
    expect(e.detail.message).toMatch(/document diversity limit/);
    expect(e.family).toBe("diversity");
    expect(facet(run(), "case_definition").selected.filter((c) => c.canonicalId === "syn-ads-case-definition")).toHaveLength(2);
  });

  it("records publisher-diversity removals", () => {
    const e = facet(run(), "regional_context").excluded.find((x) => x.reason === "publisher_diversity")!;
    expect(e.detail).toMatchObject({ limit: 3, key: "synthetic odisha state health department" });
    expect(e.detail.message).toMatch(/publisher diversity limit/);
    expect(facet(run(), "regional_context").selected.filter((c) => c.metadata.publisher === "Synthetic Odisha State Health Department")).toHaveLength(3);
  });

  it("keeps the removed candidates (the underlying set is intact) and ranks them below those kept", () => {
    const f = facet(run(), "case_definition");
    const removed = f.excluded.find((x) => x.reason === "document_diversity")!;
    expect(removed.scoreComponents.rankScore).toBeTypeOf("number");
    expect(f.stats.afterDedup).toBe(f.selected.length + f.excluded.filter((e) => ["document_diversity", "publisher_diversity", "beyond_top_k"].includes(e.reason)).length);
  });

  it("applies the cap deterministically: the same candidates are removed whatever order they arrive in", () => {
    const retrieval = retrieveFromCorpus(view, makeFacts(), DEV);
    const shuffled = structuredClone(retrieval);
    for (const f of shuffled.facets) f.candidates.reverse();
    expect(JSON.stringify(rankOf(shuffled).facets)).toBe(JSON.stringify(rankOf(retrieval).facets));
  });

  it("the top-K cut leaves an explicit reason on everything below it", () => {
    const f = facet(run(), "verification_guidance");
    expect(f.selected).toHaveLength(5);
    const cut = f.excluded.filter((e) => e.reason === "beyond_top_k");
    expect(cut.length).toBeGreaterThan(0);
    for (const e of cut) expect(e.detail.limit).toBe(5);
  });
});

describe("historical context", () => {
  const wide = makeRankingConfig({ topK: 40 });

  it("shows a superseded edition only when its successor is among the selected evidence", () => {
    const withSuccessor = run(makeFacts(), { config: wide });
    expect(facet(withSuccessor, "verification_guidance").selected.some((c) => c.canonicalId === "syn-ads-verification-guidance-2025")).toBe(true);
    const old = withSuccessor.historicalContext.filter((h) => h.canonicalId === "syn-ads-verification-guidance-2022");
    expect(old.length).toBeGreaterThan(0);
    for (const h of old) {
      expect(h.section).toBe("historical_context");
      expect(h.relation).toEqual({ status: "superseded", supersededBy: ["syn-ads-verification-guidance-2025"] });
      expect(h.scoreComponents.temporalFactor.rule).toBe("historical_context_neutral");
    }
    // The superseded edition is never in the main list.
    for (const f of withSuccessor.facets) expect(f.selected.some((c) => c.canonicalId === "syn-ads-verification-guidance-2022")).toBe(false);
  });

  it("withholds it, with an explicit reason, when the successor did not make the selection", () => {
    const r = run(); // default top-K 5: the 2025 edition is not selected
    expect(r.historicalContext.filter((h) => h.canonicalId === "syn-ads-verification-guidance-2022")).toEqual([]);
    const e = r.exclusions.ranking.filter((x) => x.section === "historical_context" && x.reason === "superseded");
    expect(e.length).toBeGreaterThan(0);
    for (const x of e) expect(x.detail).toMatchObject({ successorsPresent: [] });
  });

  it("never shows withdrawn evidence in the historical section", () => {
    const r = run(makeFacts({ syndrome: "fever" }), { config: wide });
    expect(r.historicalContext.some((h) => h.canonicalId === "syn-fev-guidance-withdrawn")).toBe(false);
    expect(JSON.stringify(r.historicalContext)).not.toContain("withdrawn guidance");
  });

  it("a document with status 'historical' may appear in the separate section without a successor", () => {
    const r = run(makeFacts({ syndrome: "jaundice" }), { config: wide });
    const h = r.historicalContext.filter((x) => x.canonicalId === "syn-jau-historical-report");
    expect(h.length).toBeGreaterThan(0);
    expect(h[0].relation).toEqual({ status: "historical", supersededBy: [] });
    for (const f of r.facets) expect(f.selected.some((c) => c.canonicalId === "syn-jau-historical-report")).toBe(false);
  });

  it("limits historical context to one chunk per document and two per facet", () => {
    const r = run(makeFacts(), { config: wide });
    const per = new Map<string, number>();
    for (const h of r.historicalContext) per.set(`${h.facet}|${h.canonicalId}`, (per.get(`${h.facet}|${h.canonicalId}`) ?? 0) + 1);
    expect(Math.max(0, ...per.values())).toBeLessThanOrEqual(1);
    for (const f of QUERY_FACETS) expect(r.historicalContext.filter((h) => h.facet === f).length).toBeLessThanOrEqual(2);
  });

  it("is skipped entirely when no historical retrieval is supplied", () => {
    const r = run(makeFacts(), { config: wide, historicalView: null });
    expect(r.historicalContext).toEqual([]);
    expect(r.retrieval.historicalResultHash).toBeNull();
  });

  it("follows a supersession chain: a grand-successor selected makes the oldest edition eligible", () => {
    const old = view.items.find((i) => i.canonicalId === "syn-ads-verification-guidance-2022")!;
    const mid = view.items.find((i) => i.canonicalId === "syn-ads-verification-guidance-2025")!;
    const grand: CorpusItem = { ...mid, id: uid("grand"), canonicalId: "syn-ads-verification-guidance-2027", supersedesId: mid.id, status: "current", chunks: mid.chunks.map((c) => ({ ...c, id: uid(`g:${c.id}`) })) };
    const v: CorpusView = { ...view, items: [...view.items.map((i) => (i.id === mid.id ? { ...i, status: "superseded", chunks: [] } : i)), grand] };
    const hv: CorpusView = { ...hview, items: [...hview.items.map((i) => (i.id === mid.id ? { ...i, status: "superseded" } : i)), { ...grand, status: "current", chunks: [] }] };
    const r = run(makeFacts(), { view: v, historicalView: hv, config: wide });
    const h = r.historicalContext.filter((x) => x.canonicalId === old.canonicalId);
    expect(h.length).toBeGreaterThan(0);
    expect(h[0].relation.supersededBy).toEqual(["syn-ads-verification-guidance-2027"]);
  });
});

describe("conflicts (curator tags only)", () => {
  const PAIR = ["syn-conflict-reporting-deadline-a", "syn-conflict-reporting-deadline-b"];
  const TAGS = {
    "syn-conflict-reporting-deadline-a": { questionKey: "reporting_deadline", position: "within_24_hours" },
    "syn-conflict-reporting-deadline-b": { questionKey: "reporting_deadline", position: "within_72_hours" },
  };
  // A slim corpus holding just the pair, so the publisher-diversity cap of a full corpus cannot hide one of them.
  const slim: CorpusView = { ...view, items: view.items.filter((i) => PAIR.includes(i.canonicalId!)) };
  const open = makeRankingConfig({ relevanceFloor: 0, topK: 60 });

  it("the untagged development corpus reports no conflicts even though it contains a deliberately conflicting pair", () => {
    expect(run(makeFacts(), { config: open }).conflicts).toEqual([]);
    expect(run(makeFacts(), { view: slim, historicalView: null, config: open }).conflicts).toEqual([]);
    expect(run().conflicts).toEqual([]);
  });

  it("reports the conflict once a curator tags the pair and both are selected", () => {
    const r = run(makeFacts(), { view: withTags(slim, TAGS), historicalView: null, config: open });
    expect(r.facets.flatMap((f) => f.selected).map((c) => c.canonicalId)).toEqual(expect.arrayContaining(PAIR));
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].questionKey).toBe("reporting_deadline");
    expect(r.conflicts[0].positions.map((p) => [p.position, p.documents.map((d) => d.canonicalId)])).toEqual([
      ["within_24_hours", ["syn-conflict-reporting-deadline-a"]],
      ["within_72_hours", ["syn-conflict-reporting-deadline-b"]],
    ]);
    expect(r.conflicts[0].basis).toBe("curator_tags");
  });

  it("reports nothing if only one side of a tagged pair is tagged, or if the pair agrees", () => {
    const one = withTags(slim, { "syn-conflict-reporting-deadline-a": TAGS["syn-conflict-reporting-deadline-a"] });
    expect(run(makeFacts(), { view: one, historicalView: null, config: open }).conflicts).toEqual([]);
    const agree = withTags(slim, {
      "syn-conflict-reporting-deadline-a": TAGS["syn-conflict-reporting-deadline-a"],
      "syn-conflict-reporting-deadline-b": { questionKey: "reporting_deadline", position: "within_24_hours" },
    });
    expect(run(makeFacts(), { view: agree, historicalView: null, config: open }).conflicts).toEqual([]);
  });

  it("is a function of the tags alone: removing the tags removes the conflict, and the lexical retrieval is unchanged", () => {
    const a = run(makeFacts(), { view: withTags(slim, TAGS), historicalView: null, config: open });
    const b = run(makeFacts(), { view: slim, historicalView: null, config: open });
    expect(a.retrieval).toEqual(b.retrieval);
    expect(a.conflicts.length).toBe(1);
    expect(b.conflicts.length).toBe(0);
  });

  it("in the full corpus a conflict is reported exactly when BOTH tagged documents are among the selected evidence", () => {
    for (const config of [undefined, open, makeRankingConfig({ relevanceFloor: 0, topK: 12 })]) {
      const r = run(makeFacts(), { view: withTags(view, TAGS), historicalView: null, config });
      const selected = new Set(r.facets.flatMap((f) => f.selected).map((c) => c.canonicalId));
      const both = PAIR.every((id) => selected.has(id));
      expect(r.conflicts.length === 1, JSON.stringify(config?.selection)).toBe(both);
    }
  });

  it("tags on documents that are not selected change nothing", () => {
    const base = run();
    const t = run(makeFacts(), { view: withTags(view, { "syn-fev-case-definition": { questionKey: "q", position: "a" }, "syn-res-case-definition": { questionKey: "q", position: "b" } }) });
    expect(t.conflicts).toEqual([]);
    expect(t.rankingHash).toBe(base.rankingHash);
  });

  it("surfaces a curator-tagged contradiction as a gap and keeps the evidence in the list", () => {
    const t = withTags(view, { "syn-ads-case-definition": { questionKey: "alternative_explanation", position: CONTRADICTS_SIGNAL } });
    const r = run(makeFacts(), { view: t, historicalView: null });
    const gap = r.gaps.find((g) => g.code === "contradicting_evidence")!;
    expect(gap.message).toBe("curator-tagged evidence contradicts the apparent interpretation of the signal: syn-ads-case-definition");
    expect(selectedIds(r, "case_definition")).toContain("syn-ads-case-definition#0"); // never suppressed
  });
});

describe("gaps in the pipeline", () => {
  it("the synthetic development corpus always reports that its evidence is synthetic", () => {
    expect(run().gaps.map((g) => g.code)).toEqual(["only_synthetic_evidence"]);
  });

  it("an empty corpus reports the absence of everything, in order, and invents nothing", () => {
    const r = run(makeFacts(), { view: { items: [], activeSnapshot: null }, historicalView: null });
    expect(r.gaps.map((g) => g.code)).toEqual(["no_eligible_evidence", "facet_not_covered", "facet_not_covered", "facet_not_covered", "facet_not_covered", "missing_local_evidence", "no_current_guidance"]);
    for (const f of r.facets) expect(f.selected).toEqual([]);
    expect(r.historicalContext).toEqual([]);
  });

  it("a signal in another state gets the exact missing-local wording and only national/global evidence", () => {
    const r = run(otherStateFacts());
    expect(r.gaps.find((g) => g.code === "missing_local_evidence")!.message).toBe("no state-level / district-level evidence for Elsewhere District, Elsewhere State");
    for (const f of r.facets) for (const c of f.selected) expect(["national", "regional", "global"]).toContain(c.scoreComponents.geoFactor.evidenceScope);
  });

  it("a Khordha signal has local evidence, so no local gap", () => {
    expect(run().gaps.map((g) => g.code)).not.toContain("missing_local_evidence");
  });

  it("reports 'all evidence old' when the only time-sensitive evidence selected is over a year old", () => {
    const aged: CorpusView = { ...view, items: view.items.map((i) => (i.canonicalId === "syn-ads-situation-report" ? { ...i, publicationDate: "2019-01-01", validFrom: "2019-01-01" } : i)) };
    const r = run(makeFacts(), { view: aged, historicalView: null });
    const sr = r.facets.flatMap((f) => f.selected).filter((c) => c.canonicalId === "syn-ads-situation-report");
    expect(sr.length).toBeGreaterThan(0);
    for (const c of sr) expect(c.scoreComponents.temporalFactor).toMatchObject({ value: 0.3, rule: "age_over_one_year" });
    expect(r.gaps.map((g) => g.code)).toContain("all_evidence_old");
    expect(run().gaps.map((g) => g.code)).not.toContain("all_evidence_old");
  });

  it("does not report 'only synthetic' once any selected evidence is real", () => {
    const real: CorpusView = { ...view, items: view.items.map((i) => (i.canonicalId === "syn-ads-case-definition" ? { ...i, isSynthetic: false } : i)) };
    const r = retrieveAndRank({ facts: makeFacts(), view: real, historicalView: null, retrievalConfig: { ...DEV, eligibility: { ...DEV.eligibility, allowSynthetic: true } } });
    expect(r.gaps.map((g) => g.code)).not.toContain("only_synthetic_evidence");
  });
});

describe("the retrieval-level exclusion log", () => {
  const r = run();

  it("lists plausible documents that did not compete, with ranking-vocabulary reasons", () => {
    const n = r.exclusions.retrieval.notable;
    // The 2022 edition is both superseded and past its validity: both reasons are reported.
    expect(n.find((x) => x.canonicalId === "syn-ads-verification-guidance-2022" && x.facet === "verification_guidance")!.reasons).toEqual(["expired", "superseded"]);
    expect(n.find((x) => x.canonicalId === "syn-ganjam-water-advisory" && x.facet === "regional_context")!.reasons).toEqual(["geographic_ineligible"]);
    expect(n.find((x) => x.canonicalId === "syn-adv-instruction-override")!.reasons).toContain("quarantined");
  });

  it("counts them per facet and maps lifecycle, expiry and look-ahead reasons", () => {
    expect(r.exclusions.retrieval.counts.verification_guidance.superseded).toBeGreaterThan(0);
    expect(r.exclusions.retrieval.counts.verification_guidance.look_ahead).toBe(1); // the weekly summary published after the as-of date
    const rash = run(makeFacts({ syndrome: "fever_with_rash" }));
    expect(rash.exclusions.retrieval.notable.find((x) => x.canonicalId === "syn-ras-guidance-expired" && x.facet === "verification_guidance")!.reasons).toEqual(["expired"]);
  });

  it("does not list documents that were never relevant (wrong syndrome, topic or language)", () => {
    const ids = new Set(r.exclusions.retrieval.notable.map((x) => x.canonicalId));
    expect(ids.has("syn-fev-verification-guidance")).toBe(false);
    expect(ids.has("syn-hi-ads-verification")).toBe(false);
  });
});

describe("determinism and independence from row order", () => {
  const base = run();
  const text = JSON.stringify(base);

  it("is byte-identical across repeated runs", () => {
    for (let i = 0; i < 10; i += 1) expect(JSON.stringify(run())).toBe(text);
  });

  it("is independent of the order of the retrieved candidates and of the corpus items", () => {
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
    const retrieval = retrieveFromCorpus(view, makeFacts(), DEV);
    const hist = retrieveFromCorpus(hview, makeFacts(), { ...DEV, eligibility: { ...DEV.eligibility, statuses: ["superseded", "historical"], temporal: { ...DEV.eligibility.temporal, expiryKinds: [] } } });
    for (let seed = 1; seed <= 15; seed += 1) {
      const r = structuredClone(retrieval);
      for (const f of r.facets) {
        f.candidates = shuffle(f.candidates, seed);
        f.excluded = shuffle(f.excluded, seed + 7);
      }
      const out = rankEvidence({ facts: makeFacts(), retrieval: r, historical: hist, view: { ...view, items: shuffle(view.items, seed + 3) } });
      expect(JSON.stringify({ ...out, historicalContext: [] }), `seed ${seed}`).toBe(JSON.stringify({ ...base, historicalContext: [] }));
      expect(out.rankingHash).toBe(base.rankingHash);
    }
  });

  it("gives the same ranking hash when every database id is different", () => {
    const reId: CorpusView = {
      ...view,
      items: view.items.map((i) => ({ ...i, id: uid(`x:${i.id}`), supersedesId: i.supersedesId ? uid(`x:${i.supersedesId}`) : null, version: i.version ? { ...i.version, id: uid(`xv:${i.id}`) } : null, chunks: i.chunks.map((c) => ({ ...c, id: uid(`xc:${c.id}`) })) })),
    };
    const out = run(makeFacts(), { view: reId, historicalView: null });
    expect(out.rankingHash).toBe(run(makeFacts(), { historicalView: null }).rankingHash);
  });

  it("changes its hash when the policy, the corpus or the signal changes", () => {
    expect(run(makeFacts(), { config: makeRankingConfig({ relevanceFloor: 0.2 }) }).rankingHash).not.toBe(base.rankingHash);
    expect(run(makeFacts({ syndrome: "fever" })).rankingHash).not.toBe(base.rankingHash);
    expect(run(makeFacts(), { asOfDate: "2025-09-30" }).rankingHash).not.toBe(base.rankingHash);
  });
});
