// @vitest-environment node
import { describe, expect, it } from "vitest";
import { hashJson } from "../hash";
import { QUERY_FACETS, SYNDROME_QUERY } from "../vocab";
import { RETRIEVAL_CONFIG_DEV, RETRIEVAL_CONFIG_V1, makeRetrievalConfig, retrievalConfigHash } from "./config";
import { corpusDigest, type CorpusItem, type CorpusView } from "./corpus";
import { buildQuery } from "./query";
import { retrieveFromCorpus, type RetrievalResult } from "./retrieve";
import { tokenize } from "./tokenize";
import { ganjamFacts, makeFacts, otherStateFacts, REGION, SYNDROMES, uid, viewFromPrepared } from "./testkit";

const view = viewFromPrepared();
const DEV = RETRIEVAL_CONFIG_DEV;
const facet = (r: RetrievalResult, name: string) => r.facets.find((f) => f.facet === name)!;
const docsOf = (r: RetrievalResult, name: string): string[] => [...new Set(facet(r, name).candidates.map((c) => c.canonicalId!))];
const excludedIds = (r: RetrievalResult, name: string): Map<string, string[]> => new Map(facet(r, name).excluded.map((e) => [e.canonicalId!, e.reasons]));
const eligibleIds = (r: RetrievalResult, name: string, v: CorpusView = view): string[] => {
  const ex = excludedIds(r, name);
  return v.items.filter((i) => !ex.has(i.canonicalId!)).map((i) => i.canonicalId!).sort();
};
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
const withItems = (items: CorpusItem[], snapshot: CorpusView["activeSnapshot"] = null): CorpusView => ({ items, activeSnapshot: snapshot });
const mod = (id: string, over: Partial<CorpusItem>): CorpusView => withItems(view.items.map((i) => (i.canonicalId === id ? { ...i, ...over } : i)));

describe("retrieval: result structure and provenance", () => {
  const facts = makeFacts();
  const r = retrieveFromCorpus(view, facts, DEV);

  it("reports the configuration, query and corpus it was made with", () => {
    expect(r.schema).toBe("retrieval-result/1");
    expect(r.signalId).toBe(facts.signal_id);
    expect(r.asOfDate).toBe("2025-09-07");
    expect(r.config).toEqual({ version: DEV.version, hash: retrievalConfigHash(DEV) });
    expect(r.query.hash).toBe(buildQuery(facts).queryHash);
    expect(r.corpus.digest).toBe(corpusDigest(view));
    expect(r.corpus.documents).toBe(60);
    expect(r.resultHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records the active corpus snapshot when there is one", () => {
    const snap = { id: uid("snapshot"), corpusHash: "c".repeat(64), corpusVersion: "jansanket-dev-corpus+cccccccccccc" };
    expect(retrieveFromCorpus(withItems(view.items, snap), facts, DEV).corpus.activeSnapshot).toEqual(snap);
    expect(r.corpus.activeSnapshot).toBeNull();
  });

  it("returns the four planned facets in order, each carrying its own query", () => {
    expect(r.facets.map((f) => f.facet)).toEqual([...QUERY_FACETS]);
    for (const f of r.facets) expect(f.query).toEqual(buildQuery(facts).facets.find((q) => q.facet === f.facet));
  });

  it("gives every candidate the provenance later milestones need", () => {
    for (const f of r.facets) {
      expect(f.candidates.length, f.facet).toBeGreaterThan(0);
      for (const c of f.candidates) {
        expect(c.facet).toBe(f.facet);
        for (const id of [c.evidenceItemId, c.evidenceVersionId, c.chunkId]) expect(id).toMatch(/^[0-9a-f-]{36}$/);
        expect(c.canonicalId).toMatch(/^syn-/);
        expect(c.versionContentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(c.chunkHash).toMatch(/^[0-9a-f]{64}$/);
        expect(c.bm25Score).toBeGreaterThan(0);
        expect(c.matchedTerms.length).toBeGreaterThan(0);
        for (const m of c.matchedTerms) {
          expect(f.query.tokens).toContain(m.term);
          expect(m.tf).toBeGreaterThan(0);
          expect(tokenize(c.text)).toContain(m.term);
        }
        expect(c.text.length).toBeGreaterThan(0);
        expect(["abstract", "excerpt"]).toContain(c.chunkKind);
        expect(c.metadata).toMatchObject({ status: "current", language: "en", isSynthetic: true });
        expect(["global", "regional", "national", "state", "district"]).toContain(c.metadata.geoMatch);
      }
    }
  });

  it("orders candidates by score (non-increasing) with sequential 1-based ranks", () => {
    for (const f of r.facets) {
      f.candidates.forEach((c, i) => {
        expect(c.rank).toBe(i + 1);
        if (i > 0) expect(c.bm25Score).toBeLessThanOrEqual(f.candidates[i - 1].bm25Score);
      });
    }
  });

  it("keeps statistics consistent with the candidates", () => {
    for (const f of r.facets) {
      expect(f.stats.chunksMatched).toBe(f.candidates.length);
      expect(f.stats.chunksIndexed).toBeGreaterThanOrEqual(f.stats.chunksMatched);
      expect(f.stats.documentsConsidered).toBe(60);
      expect(f.stats.documentsEligible + f.excluded.length).toBe(60);
      expect(f.stats.index.docs).toBe(f.stats.chunksIndexed);
    }
  });

  it("does not present the score as a probability or a confidence", () => {
    const keys = JSON.stringify(r).match(/"[a-zA-Z0-9_]+":/g)!.map((k) => k.slice(1, -2).toLowerCase());
    for (const banned of ["probability", "confidence", "likelihood", "truth", "relevance"]) expect(keys).not.toContain(banned);
  });

  it("applies no M4.3 ranking factor: no class, geography, age or diversity field is computed", () => {
    const c = r.facets[0].candidates[0];
    const keys = Object.keys(c);
    for (const banned of ["classFactor", "geoFactor", "temporalFactor", "rankScore", "diversity", "score_components"]) expect(keys).not.toContain(banned);
    expect(Object.keys(c.metadata)).not.toContain("factor");
  });
});

describe("retrieval: each facet on the reference signal (acute diarrhoeal illness, Balianta, Khordha, Odisha)", () => {
  const r = retrieveFromCorpus(view, makeFacts(), DEV);

  it("verification_guidance: only compatible, in-scope, in-date, current documents compete", () => {
    expect(eligibleIds(r, "verification_guidance")).toEqual([
      "syn-ads-situation-report", "syn-ads-verification-exact-copy", "syn-ads-verification-guidance", "syn-ads-verification-guidance-2025",
      "syn-ads-verification-near-duplicate", "syn-community-health-worker-notes", "syn-conflict-reporting-deadline-a", "syn-conflict-reporting-deadline-b",
      "syn-global-outbreak-investigation-checklist", "syn-khordha-response-contacts", "syn-national-outbreak-response-reporting",
      "syn-national-surveillance-methods-primer", "syn-professional-cluster-reporting-statement", "syn-regional-south-asia-surveillance-note",
      "syn-stuffed-irrelevant-a", "syn-stuffed-irrelevant-b",
    ]);
  });

  it("verification_guidance: the best matches are the syndrome's own verification procedures", () => {
    const top = facet(r, "verification_guidance").candidates.slice(0, 3).map((c) => c.canonicalId);
    for (const id of top) expect(id).toMatch(/^syn-ads-verification/);
  });

  it("case_definition: surfaces the syndrome's case definition", () => {
    expect(docsOf(r, "case_definition")).toContain("syn-ads-case-definition");
    expect(facet(r, "case_definition").candidates[0].canonicalId).toBe("syn-ads-case-definition");
    expect(facet(r, "case_definition").candidates[0].metadata.geoMatch).toBe("global");
  });

  it("epidemiological_context: surfaces the clinical reference and nothing from other syndromes", () => {
    expect(docsOf(r, "epidemiological_context")).toContain("syn-ads-clinical-reference");
    for (const id of docsOf(r, "epidemiological_context")) expect(id).not.toMatch(/^syn-(fev|ras|jau|res)-/);
  });

  it("regional_context: includes Odisha and monsoon material, with state matches labelled as such", () => {
    const docs = docsOf(r, "regional_context");
    expect(docs).toEqual(expect.arrayContaining(["syn-ads-odisha-context", "syn-odisha-wash-guidance-monsoon", "syn-national-monsoon-seasonality-note"]));
    const state = facet(r, "regional_context").candidates.find((c) => c.canonicalId === "syn-ads-odisha-context")!;
    expect(state.metadata.geoMatch).toBe("state");
  });

  it("matched terms explain why a chunk was retrieved", () => {
    const c = facet(r, "case_definition").candidates[0];
    expect(c.matchedTerms.map((m) => m.term)).toEqual(expect.arrayContaining(["definition"]));
  });
});

describe("retrieval: every syndrome and facet", () => {
  it.each(SYNDROMES)("%s: candidates are compatible with the syndrome and the facet's topics", (syndrome) => {
    const r = retrieveFromCorpus(view, makeFacts({ syndrome }), DEV);
    for (const f of r.facets) {
      const topics = SYNDROME_QUERY[syndrome].topics[f.facet];
      for (const c of f.candidates) {
        expect(c.metadata.topics.some((t) => (topics as readonly string[]).includes(t)), `${syndrome}/${f.facet}/${c.canonicalId}`).toBe(true);
        expect(c.metadata.syndromes.length === 0 || c.metadata.syndromes.includes(syndrome), `${syndrome}/${f.facet}/${c.canonicalId}`).toBe(true);
        expect(c.metadata.status).toBe("current");
      }
    }
    expect(facet(r, "verification_guidance").candidates.length).toBeGreaterThan(0);
    expect(facet(r, "case_definition").candidates.length).toBeGreaterThan(0);
  });

  const SHORT: Record<string, string> = { acute_diarrhoeal_illness: "ads", fever: "fev", fever_with_rash: "ras", jaundice: "jau", respiratory_illness: "res" };
  it.each(SYNDROMES)("%s: its own case definition is the best case_definition match", (syndrome) => {
    const r = retrieveFromCorpus(view, makeFacts({ syndrome }), DEV);
    expect(facet(r, "case_definition").candidates[0].canonicalId).toBe(`syn-${SHORT[syndrome]}-case-definition`);
  });

  it.each(SYNDROMES)("%s: another syndrome's specific documents never appear", (syndrome) => {
    const r = retrieveFromCorpus(view, makeFacts({ syndrome }), DEV);
    const other = Object.entries(SHORT).filter(([k]) => k !== syndrome).map(([, v]) => v);
    for (const f of r.facets) for (const c of f.candidates) expect(other.some((o) => c.canonicalId!.startsWith(`syn-${o}-`)), c.canonicalId!).toBe(false);
  });
});

describe("retrieval: geography (no fabricated local evidence)", () => {
  it("a Khordha signal gets Khordha but not Ganjam district documents", () => {
    const r = retrieveFromCorpus(view, makeFacts(), DEV);
    expect(docsOf(r, "verification_guidance")).toContain("syn-khordha-response-contacts");
    expect(excludedIds(r, "regional_context").get("syn-ganjam-water-advisory")).toEqual(["geo_scope_mismatch"]);
    expect(JSON.stringify(r.facets.flatMap((f) => f.candidates.map((c) => c.canonicalId)))).not.toContain("ganjam");
  });

  it("a Ganjam signal gets Ganjam but not Khordha district documents", () => {
    const r = retrieveFromCorpus(view, ganjamFacts(), DEV);
    expect(docsOf(r, "regional_context")).toContain("syn-ganjam-water-advisory");
    expect(excludedIds(r, "verification_guidance").get("syn-khordha-response-contacts")).toEqual(["geo_scope_mismatch"]);
    const ganjam = facet(r, "regional_context").candidates.find((c) => c.canonicalId === "syn-ganjam-water-advisory")!;
    expect(ganjam.metadata.geoMatch).toBe("district");
  });

  it("a signal in another state receives only global, regional and national evidence", () => {
    const r = retrieveFromCorpus(view, otherStateFacts(), DEV);
    for (const f of r.facets) {
      for (const c of f.candidates) expect(["global", "regional", "national"], `${f.facet}/${c.canonicalId}`).toContain(c.metadata.geoMatch);
      const ex = f.excluded.filter((e) => e.reasons.includes("geo_scope_mismatch")).map((e) => e.canonicalId);
      expect(ex.length).toBeGreaterThan(0);
    }
    const reg = excludedIds(r, "regional_context");
    for (const id of ["syn-ads-odisha-context", "syn-odisha-wash-guidance-monsoon", "syn-ganjam-water-advisory"]) expect(reg.get(id), id).toContain("geo_scope_mismatch");
    expect(docsOf(r, "regional_context")).toContain("syn-national-monsoon-seasonality-note"); // national material still applies
  });

  it("a state document tagged with the wrong region level does not slip through", () => {
    const v = mod("syn-ads-odisha-context", { geoRegionId: REGION.khordha }); // 'state' scope pointing at a district id
    expect(excludedIds(retrieveFromCorpus(v, makeFacts(), DEV), "regional_context").get("syn-ads-odisha-context")).toEqual(["geo_scope_mismatch"]);
  });
});

describe("retrieval: lifecycle, trust and synthetic handling", () => {
  const r = retrieveFromCorpus(view, makeFacts(), DEV);
  const allReasons = (id: string) => QUERY_FACETS.flatMap((f) => excludedIds(r, f).get(id) ?? []);

  it("never lets quarantined, draft, withdrawn, superseded or historical documents compete", () => {
    expect(allReasons("syn-ads-verification-guidance-2022")).toContain("status_not_eligible"); // superseded
    expect(allReasons("syn-fev-guidance-withdrawn")).toContain("status_not_eligible");
    expect(allReasons("syn-jau-historical-report")).toContain("status_not_eligible");
    expect(allReasons("syn-res-draft-notes")).toContain("status_not_eligible");
    expect(allReasons("syn-unverified-forum-post")).toEqual(expect.arrayContaining(["status_not_eligible", "source_class_excluded", "trust_below_minimum"]));
    for (const id of ["syn-adv-instruction-override", "syn-adv-role-marker", "syn-adv-markdown-exfil", "syn-adv-hidden-invisible-chars", "syn-adv-html-hidden-content", "syn-adv-encoded-blob", "syn-adv-mixed-script", "syn-adv-forced-conclusion"]) {
      expect(allReasons(id), id).toContain("status_not_eligible");
    }
    const seen = new Set(r.facets.flatMap((f) => f.candidates.map((c) => c.canonicalId!)));
    for (const bad of ["syn-ads-verification-guidance-2022", "syn-fev-guidance-withdrawn", "syn-jau-historical-report", "syn-res-draft-notes", "syn-unverified-forum-post"]) expect(seen.has(bad), bad).toBe(false);
    expect([...seen].filter((id) => id.startsWith("syn-adv-"))).toEqual([]);
  });

  it("the superseding 2025 edition competes while the 2022 edition does not", () => {
    expect(docsOf(r, "verification_guidance")).toContain("syn-ads-verification-guidance-2025");
    expect(docsOf(r, "verification_guidance")).not.toContain("syn-ads-verification-guidance-2022");
  });

  it("excludes documents below the trust minimum and stops a status flip from slipping through", () => {
    const v = mod("syn-ads-case-definition", { trustLevel: "unreviewed" });
    expect(excludedIds(retrieveFromCorpus(v, makeFacts(), DEV), "case_definition").get("syn-ads-case-definition")).toContain("trust_below_minimum");
    const v2 = mod("syn-ads-case-definition", { status: "quarantined" });
    expect(docsOf(retrieveFromCorpus(v2, makeFacts(), DEV), "case_definition")).not.toContain("syn-ads-case-definition");
  });

  it("excludes a version whose last link check failed", () => {
    const item = view.items.find((i) => i.canonicalId === "syn-ads-case-definition")!;
    const v = mod("syn-ads-case-definition", { version: { ...item.version!, fetchStatus: "changed" } });
    expect(excludedIds(retrieveFromCorpus(v, makeFacts(), DEV), "case_definition").get("syn-ads-case-definition")).toContain("source_check_failed");
  });

  it("the production configuration admits no synthetic document: nothing is retrieved from the development corpus", () => {
    const prod = retrieveFromCorpus(view, makeFacts(), RETRIEVAL_CONFIG_V1);
    for (const f of prod.facets) {
      expect(f.candidates).toEqual([]);
      expect(f.stats.documentsEligible).toBe(0);
      expect(f.excluded.every((e) => e.reasons.includes("synthetic_not_allowed") || e.reasons.length > 0)).toBe(true);
    }
    expect(excludedIds(prod, "case_definition").get("syn-ads-case-definition")).toEqual(["synthetic_not_allowed"]);
  });

  it("the development configuration admits synthetic documents explicitly and labels them", () => {
    for (const f of r.facets) for (const c of f.candidates) expect(c.metadata.isSynthetic).toBe(true);
  });

  it("a real (non-synthetic) document competes under the production configuration", () => {
    const real = view.items.map((i) => (i.canonicalId === "syn-ads-case-definition" ? { ...i, isSynthetic: false } : i));
    const prod = retrieveFromCorpus(withItems(real), makeFacts(), RETRIEVAL_CONFIG_V1);
    expect(docsOf(prod, "case_definition")).toEqual(["syn-ads-case-definition"]);
  });
});

describe("retrieval: language", () => {
  it("excludes Hindi and Odia documents because the query vocabulary is English (no cross-lingual claim)", () => {
    const r = retrieveFromCorpus(view, makeFacts({ syndrome: "fever" }), DEV);
    expect(excludedIds(r, "epidemiological_context").get("syn-or-fever-note")).toContain("language_not_queryable");
    expect(excludedIds(r, "verification_guidance").get("syn-hi-ads-verification")).toContain("language_not_queryable");
    expect(r.facets.flatMap((f) => f.candidates).every((c) => c.chunkLanguage === "en")).toBe(true);
  });

  it("also checks the language of each chunk: a stray non-English chunk inside an English document is not indexed", () => {
    const item = view.items.find((i) => i.canonicalId === "syn-ads-case-definition")!;
    const stray = { id: uid("stray-chunk"), ordinal: 99, kind: "excerpt", text: "suspected case definition suspected case definition", chunkHash: "f".repeat(64), language: "hi" };
    const r = retrieveFromCorpus(withItems([{ ...item, chunks: [...item.chunks, stray] }]), makeFacts(), DEV);
    expect(facet(r, "case_definition").candidates.some((c) => c.chunkId === stray.id)).toBe(false);
    expect(facet(r, "case_definition").stats.chunksIndexed).toBe(item.chunks.length);
  });

  it("a configuration that adds Hindi admits the document but cannot match English terms against it", () => {
    const cfg = { ...DEV, eligibility: { ...DEV.eligibility, languages: ["en", "hi"] } };
    const r = retrieveFromCorpus(view, makeFacts(), cfg);
    expect(excludedIds(r, "verification_guidance").has("syn-hi-ads-verification")).toBe(false);
    expect(docsOf(r, "verification_guidance")).not.toContain("syn-hi-ads-verification"); // eligible, but zero lexical overlap
  });
});

describe("retrieval: binary temporal eligibility", () => {
  it("excludes the weekly summary published after the signal's as-of date, and admits it for a later as-of", () => {
    const early = retrieveFromCorpus(view, makeFacts(), DEV);
    expect(excludedIds(early, "verification_guidance").get("syn-national-surveillance-weekly-summary")).toContain("published_after_as_of");
    const later = retrieveFromCorpus(view, makeFacts(), DEV, { asOfDate: "2025-09-30" });
    expect(later.asOfDate).toBe("2025-09-30");
    // Eligible now (no longer excluded). Whether it is also a lexical candidate depends on term overlap, not on eligibility.
    expect(excludedIds(later, "verification_guidance").has("syn-national-surveillance-weekly-summary")).toBe(false);
    expect(eligibleIds(later, "verification_guidance")).toContain("syn-national-surveillance-weekly-summary");
  });

  it("excludes expired guidance for a rash signal", () => {
    const r = retrieveFromCorpus(view, makeFacts({ syndrome: "fever_with_rash" }), DEV);
    expect(excludedIds(r, "verification_guidance").get("syn-ras-guidance-expired")).toContain("validity_ended");
    expect(docsOf(r, "verification_guidance")).not.toContain("syn-ras-guidance-expired");
    const retro = retrieveFromCorpus(view, makeFacts({ syndrome: "fever_with_rash" }), DEV, { asOfDate: "2023-06-01" });
    expect(excludedIds(retro, "verification_guidance").get("syn-ras-guidance-expired") ?? []).not.toContain("validity_ended");
  });

  it("does not penalise age: an old situation report is still just a candidate", () => {
    const old = view.items.map((i) => (i.canonicalId === "syn-ads-situation-report" ? { ...i, publicationDate: "2010-01-01", validFrom: "2010-01-01" } : i));
    const a = facet(retrieveFromCorpus(view, makeFacts(), DEV), "verification_guidance").candidates.find((c) => c.canonicalId === "syn-ads-situation-report")!;
    const b = facet(retrieveFromCorpus(withItems(old), makeFacts(), DEV), "verification_guidance").candidates.find((c) => c.canonicalId === "syn-ads-situation-report")!;
    expect(b.bm25Score).toBe(a.bm25Score);
  });
});

describe("retrieval: keyword-stuffed documents", () => {
  const r = retrieveFromCorpus(view, makeFacts(), DEV);

  it("compete (and are labelled) only because they pass the eligibility rules; their presentation priority is M4.3's job", () => {
    const stuffed = facet(r, "verification_guidance").candidates.filter((c) => c.canonicalId!.startsWith("syn-stuffed-"));
    expect(stuffed.length).toBeGreaterThan(0);
    for (const c of stuffed) {
      expect(c.metadata.sourceClass).toBe("other_verified");
      expect(c.metadata.trustLevel).toBe("reviewed");
    }
  });

  it("do not compete when they fail eligibility, however many query words they contain", () => {
    for (const patch of [{ status: "quarantined" }, { status: "draft" }, { sourceClass: "unverified" }, { trustLevel: "unreviewed" }, { topics: ["monsoon_seasonality"] }, { language: "hi" }]) {
      const v = withItems(view.items.map((i) => (i.canonicalId === "syn-stuffed-irrelevant-a" ? { ...i, ...patch } : i)));
      expect(docsOf(retrieveFromCorpus(v, makeFacts(), DEV), "verification_guidance"), JSON.stringify(patch)).not.toContain("syn-stuffed-irrelevant-a");
    }
  });
});

describe("retrieval: empty and degenerate inputs", () => {
  it("returns empty facets, not errors, for an empty corpus", () => {
    const r = retrieveFromCorpus(withItems([]), makeFacts(), DEV);
    for (const f of r.facets) {
      expect(f.candidates).toEqual([]);
      expect(f.excluded).toEqual([]);
      expect(f.stats).toMatchObject({ documentsConsidered: 0, documentsEligible: 0, chunksIndexed: 0, chunksMatched: 0 });
    }
    expect(r.corpus.documents).toBe(0);
  });

  it("returns no candidate for an eligible document that shares no query term", () => {
    const item: CorpusItem = { ...view.items.find((i) => i.canonicalId === "syn-ads-case-definition")!, chunks: [{ id: uid("c"), ordinal: 0, kind: "abstract", text: "zzzz qqqq xxxx", chunkHash: "d".repeat(64), language: "en" }] };
    const r = retrieveFromCorpus(withItems([item]), makeFacts(), DEV);
    expect(facet(r, "case_definition").candidates).toEqual([]);
    expect(facet(r, "case_definition").stats.documentsEligible).toBe(1);
  });

  it("returns nothing when only ineligible documents exist", () => {
    const r = retrieveFromCorpus(withItems(view.items.filter((i) => i.status !== "current")), makeFacts(), DEV);
    for (const f of r.facets) expect(f.candidates).toEqual([]);
  });

  it("refuses facts that carry anything beyond the allowed signal facts", () => {
    expect(() => retrieveFromCorpus(view, { ...makeFacts(), observed: 17 } as never, DEV)).toThrow();
    expect(() => retrieveFromCorpus(view, { ...makeFacts(), patient_name: "x" } as never, DEV)).toThrow();
  });
});

describe("retrieval: end-to-end BM25 equivalence with an independent reference", () => {
  /** The textbook formula, recomputed from scratch over exactly the chunks the filter admitted. */
  function reference(result: RetrievalResult, name: string, v: CorpusView): Map<string, number> {
    const f = facet(result, name);
    const ex = new Set(f.excluded.map((e) => e.evidenceItemId));
    const docs = v.items.filter((i) => !ex.has(i.id)).flatMap((i) => i.chunks.map((c) => ({ key: c.id, tokens: tokenize(c.text) })));
    const N = docs.length;
    const avgdl = docs.reduce((s, d) => s + d.tokens.length, 0) / N;
    const out = new Map<string, number>();
    for (const d of docs) {
      let s = 0;
      for (const t of f.query.tokens) {
        const tf = d.tokens.filter((x) => x === t).length;
        if (!tf) continue;
        const n = docs.filter((o) => o.tokens.includes(t)).length;
        s += Math.log(1 + (N - n + 0.5) / (n + 0.5)) * ((tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * d.tokens.length) / avgdl)));
      }
      if (s > 0) out.set(d.key, s);
    }
    return out;
  }

  it.each(QUERY_FACETS)("%s: every candidate score equals the reference, and no matching chunk is missing", (name) => {
    for (const syndrome of SYNDROMES) {
      const r = retrieveFromCorpus(view, makeFacts({ syndrome }), DEV);
      const ref = reference(r, name, view);
      const got = new Map(facet(r, name).candidates.map((c) => [c.chunkId, c.bm25Score]));
      expect([...got.keys()].sort(), `${syndrome}/${name}`).toEqual([...ref.keys()].sort());
      for (const [k, v] of ref) expect(got.get(k)!, `${syndrome}/${name}`).toBeCloseTo(v, 9);
    }
  });
});

describe("retrieval: determinism", () => {
  const facts = makeFacts();
  const baseline = retrieveFromCorpus(view, facts, DEV);

  it("is identical across 25 repeated runs", () => {
    const text = JSON.stringify(baseline);
    for (let i = 0; i < 25; i += 1) expect(JSON.stringify(retrieveFromCorpus(view, facts, DEV))).toBe(text);
  });

  it("is independent of the order of items and chunks in the corpus view (20 shuffles)", () => {
    const text = JSON.stringify(baseline);
    for (let seed = 1; seed <= 20; seed += 1) {
      const shuffled = withItems(shuffle(view.items, seed).map((i) => ({ ...i, chunks: shuffle(i.chunks, seed + 100) })));
      expect(JSON.stringify(retrieveFromCorpus(shuffled, facts, DEV)), `seed ${seed}`).toBe(text);
    }
  });

  it("gives the same query, candidate order, scores and result hash when every database id is different", () => {
    const reId = withItems(
      view.items.map((i) => ({
        ...i,
        id: uid(`other-db:item:${i.id}`),
        version: i.version ? { ...i.version, id: uid(`other-db:version:${i.id}`) } : null,
        chunks: i.chunks.map((c) => ({ ...c, id: uid(`other-db:chunk:${c.id}`) })),
      })),
    );
    const other = retrieveFromCorpus(reId, facts, DEV);
    expect(other.resultHash).toBe(baseline.resultHash);
    expect(other.query).toEqual(baseline.query);
    const sig = (r: RetrievalResult) => r.facets.map((f) => f.candidates.map((c) => [c.canonicalId, c.chunkOrdinal, c.chunkHash, c.bm25Score, c.rank]));
    expect(sig(other)).toEqual(sig(baseline));
  });

  it("changes the result hash when the corpus text, the configuration or the signal changes", () => {
    const edited = withItems(view.items.map((i) => (i.canonicalId === "syn-ads-case-definition" ? { ...i, chunks: i.chunks.map((c, k) => (k === 0 ? { ...c, text: `${c.text} extra`, chunkHash: "e".repeat(64) } : c)) } : i)));
    expect(retrieveFromCorpus(edited, facts, DEV).resultHash).not.toBe(baseline.resultHash);
    expect(retrieveFromCorpus(view, facts, makeRetrievalConfig({ allowSynthetic: true })).resultHash).toBe(baseline.resultHash);
    expect(retrieveFromCorpus(view, facts, { ...DEV, bm25: { ...DEV.bm25, k1: 1.3 } }).resultHash).not.toBe(baseline.resultHash);
    expect(retrieveFromCorpus(view, makeFacts({ syndrome: "fever" }), DEV).resultHash).not.toBe(baseline.resultHash);
    expect(retrieveFromCorpus(view, facts, DEV, { asOfDate: "2025-09-30" }).resultHash).not.toBe(baseline.resultHash);
    expect(hashJson(baseline)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("retrieval: deterministic tie-breaking", () => {
  const facts = makeFacts();

  it("orders exactly tied candidates by canonical id (the exact copy sorts before the original)", () => {
    const r = retrieveFromCorpus(view, facts, DEV);
    const cands = facet(r, "verification_guidance").candidates;
    const copy = cands.filter((c) => c.canonicalId === "syn-ads-verification-exact-copy");
    const orig = cands.filter((c) => c.canonicalId === "syn-ads-verification-guidance");
    expect(copy.length).toBeGreaterThan(0);
    expect(copy.length).toBe(orig.length);
    copy.forEach((c, i) => {
      expect(c.bm25Score).toBe(orig[i].bm25Score); // identical text => identical score, exactly
      expect(c.chunkHash).toBe(orig[i].chunkHash);
      expect(c.rank).toBeLessThan(orig[i].rank);
    });
  });

  it("does not let database ids decide a tie that canonical ids can decide", () => {
    // Give the ORIGINAL a lexicographically smaller database id than the copy: the order must still follow canonical ids.
    const swapped = withItems(
      view.items.map((i) => {
        if (i.canonicalId === "syn-ads-verification-guidance") return { ...i, id: "00000000-0000-0000-0000-000000000001", chunks: i.chunks.map((c, k) => ({ ...c, id: `00000000-0000-0000-0000-0000000001${String(k).padStart(2, "0")}` })) };
        if (i.canonicalId === "syn-ads-verification-exact-copy") return { ...i, id: "ffffffff-ffff-ffff-ffff-ffffffffffff", chunks: i.chunks.map((c, k) => ({ ...c, id: `ffffffff-ffff-ffff-ffff-ffffffffff${String(k).padStart(2, "0")}` })) };
        return i;
      }),
    );
    const a = facet(retrieveFromCorpus(view, facts, DEV), "verification_guidance").candidates.map((c) => [c.canonicalId, c.chunkOrdinal]);
    const b = facet(retrieveFromCorpus(swapped, facts, DEV), "verification_guidance").candidates.map((c) => [c.canonicalId, c.chunkOrdinal]);
    expect(b).toEqual(a);
  });

  it("falls back to chunk ordinal and then chunk id for chunks of one document with identical text and score", () => {
    const base = view.items.find((i) => i.canonicalId === "syn-ads-case-definition")!;
    const twin = (id: string, ordinal: number) => ({ id, ordinal, kind: "excerpt", text: "suspected case definition cluster", chunkHash: id.replace(/[^0-9a-f]/g, "0").padEnd(64, "0").slice(0, 64), language: "en" });
    const v = withItems([{ ...base, chunks: [twin("00000000-0000-0000-0000-00000000000b", 1), twin("00000000-0000-0000-0000-00000000000a", 1), twin("00000000-0000-0000-0000-00000000000c", 0)] }]);
    const order = facet(retrieveFromCorpus(v, facts, DEV), "case_definition").candidates.map((c) => c.chunkId.slice(-1));
    expect(order).toEqual(["c", "a", "b"]); // ordinal 0 first; then ordinal 1 broken by chunk id
  });

  it("uses the row id when a legacy document has no canonical id", () => {
    const base = view.items.find((i) => i.canonicalId === "syn-ads-case-definition")!;
    const mk = (id: string) => ({ ...base, id, canonicalId: null, chunks: [{ id: `${id}-c`.slice(0, 36).padEnd(36, "0"), ordinal: 0, kind: "abstract", text: "suspected case definition", chunkHash: id.padEnd(64, "0").slice(0, 64), language: "en" }] });
    const r = facet(retrieveFromCorpus(withItems([mk("bbbbbbbb-0000-0000-0000-000000000000"), mk("aaaaaaaa-0000-0000-0000-000000000000")]), facts, DEV), "case_definition");
    expect(r.candidates.map((c) => c.evidenceItemId[0])).toEqual(["a", "b"]);
  });
});
