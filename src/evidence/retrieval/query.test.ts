// @vitest-environment node
import { describe, expect, it } from "vitest";
import { QUERY_FACETS, QUERY_VOCAB_VERSION, SYNDROME_QUERY } from "../vocab";
import { buildFacetQuery, buildQuery, QUERY_SCHEMA } from "./query";
import { QUERY_CONFIG_VERSION, QUERY_STOP_WORDS, SEASON_BY_MONTH, seasonOf } from "./queryConfig";
import { classifyPersistence, classifySpread } from "./signal";
import { tokenize } from "./tokenize";
import { ganjamFacts, makeFacts, REGION, SYNDROMES, uid } from "./testkit";

/**
 * Golden values. A change here means the query a signal produces has changed: that must be a deliberate,
 * reviewed act accompanied by a QUERY_CONFIG_VERSION (or vocabulary version) bump.
 */
const GOLDEN_QUERY_HASH: Record<string, string> = {
  acute_diarrhoeal_illness: "e2cc3e663c47c5b585f85685408e6641477d1e8c53d1d97a4707b4aba9bd9f76",
  fever: "0e931e7c9272a4b96ea32d38c5ad912d7cb8b21a8edd00bc894c73d8d47a74d5",
  fever_with_rash: "8d83c968eab36e037971bf94a486dc1596da5a41d2269ea08b48d58e13f45e70",
  jaundice: "f7085f6ed5d0d4e8d7d70c409398f323865b5113030ed8c01a6f3926effc014a",
  respiratory_illness: "a9e87063db9a3876583ed1612bffc35c9747d24e66c44f4e12305c35f74fd62c",
};
const GOLDEN_GANJAM_HASH = "a2a115218a5be69b604be7cc7ed7cc625503c719efa9b12d1ec3fcc108e01032";

describe("query builder: golden construction", () => {
  it("is versioned", () => {
    const q = buildQuery(makeFacts());
    expect(q.schema).toBe(QUERY_SCHEMA);
    expect(q.vocabVersion).toBe(QUERY_VOCAB_VERSION);
    expect(q.configVersion).toBe(QUERY_CONFIG_VERSION);
    expect(QUERY_CONFIG_VERSION).toMatch(/^query-config\/\d+\.\d+\.\d+$/);
  });

  it.each(SYNDROMES)("produces the pinned query hash for %s", (s) => {
    expect(buildQuery(makeFacts({ syndrome: s })).queryHash).toBe(GOLDEN_QUERY_HASH[s]);
  });

  it("produces the pinned hash for a Ganjam-district signal", () => {
    expect(buildQuery(ganjamFacts()).queryHash).toBe(GOLDEN_GANJAM_HASH);
  });

  it("builds the exact regional_context query for the reference signal", () => {
    const f = buildQuery(makeFacts()).facets.find((x) => x.facet === "regional_context")!;
    expect(f.topics).toEqual(["monsoon_seasonality", "water_sanitation"]);
    expect(f.terms).toEqual([
      "seasonal factors", "local teams", "water safety", "sanitation", "monsoon months",
      "acute diarrhoeal disease", "acute watery diarrhoea", "diarrhoea outbreak", "waterborne", "enteric", "oral rehydration", "water contamination",
      "Balianta", "Khordha", "Odisha",
      "monsoon", "rainy season", "rainfall",
      "block",
    ]);
    expect(f.tokens).toEqual([
      "acute", "balianta", "block", "contamination", "diarrhoea", "diarrhoeal", "disease", "enteric", "factors", "khordha", "local", "monsoon", "months",
      "odisha", "oral", "outbreak", "rainfall", "rainy", "rehydration", "safety", "sanitation", "season", "seasonal", "teams", "water", "waterborne", "watery",
    ]);
  });

  it("builds the exact verification_guidance query for the reference signal", () => {
    const f = buildQuery(makeFacts()).facets.find((x) => x.facet === "verification_guidance")!;
    expect(f.topics).toEqual(["outbreak_investigation", "outbreak_response", "surveillance_methods"]);
    expect(f.sources.characteristics).toEqual(["single block", "local cluster", "ongoing", "persistent", "sustained"]);
    expect(f.sources.region).toEqual([]); // region names are used by the regional facet only
    expect(f.sources.season).toEqual([]);
  });
});

describe("query builder: structure", () => {
  it.each(SYNDROMES)("covers all four facets with usable topics and tokens for %s", (s) => {
    const q = buildQuery(makeFacts({ syndrome: s }));
    expect(q.facets.map((f) => f.facet)).toEqual([...QUERY_FACETS]);
    expect(q.facets).toHaveLength(4);
    for (const f of q.facets) {
      expect(f.topics, `${s}/${f.facet}`).toEqual([...SYNDROME_QUERY[s].topics[f.facet]].sort());
      expect(f.tokens.length, `${s}/${f.facet}`).toBeGreaterThan(3);
      expect(f.tokens).toEqual([...new Set(f.tokens)].sort()); // distinct and in code-point order
      expect(f.tokens).toEqual([...new Set(tokenize(f.terms.join(" ")).filter((t) => !QUERY_STOP_WORDS.includes(t)))].sort());
      for (const t of SYNDROME_QUERY[s].terms) expect(f.terms).toContain(t);
    }
  });

  it("drops function words from QUERY tokens only (the vocabulary and the term lists are untouched)", () => {
    expect([...QUERY_STOP_WORDS]).toEqual([...QUERY_STOP_WORDS].sort());
    for (const s of SYNDROMES) for (const f of buildQuery(makeFacts({ syndrome: s })).facets) expect(f.tokens.filter((t) => QUERY_STOP_WORDS.includes(t)), `${s}/${f.facet}`).toEqual([]);
    const rash = buildQuery(makeFacts({ syndrome: "fever_with_rash" })).facets[1];
    expect(rash.terms).toContain("fever with rash");
    expect(rash.tokens).toContain("fever");
    expect(rash.tokens).toContain("rash");
    expect(rash.tokens).not.toContain("with");
  });

  it("uses different syndrome terms for different syndromes", () => {
    const a = buildQuery(makeFacts({ syndrome: "jaundice" })).facets[0].tokens;
    const b = buildQuery(makeFacts({ syndrome: "respiratory_illness" })).facets[0].tokens;
    expect(a).toContain("jaundice");
    expect(a).not.toContain("respiratory");
    expect(b).toContain("respiratory");
  });

  it("defaults as-of to the window's last day and honours an explicit as-of", () => {
    expect(buildQuery(makeFacts()).asOfDate).toBe("2025-09-07");
    expect(buildQuery(makeFacts(), { asOfDate: "2025-12-31" }).asOfDate).toBe("2025-12-31");
    expect(() => buildQuery(makeFacts(), { asOfDate: "2025-9-7" })).toThrow(RangeError);
  });

  it("rejects an unsupported syndrome at the facet level", () => {
    expect(() => buildFacetQuery({ ...makeFacts(), syndrome: "unknown" as never }, "case_definition", "2025-09-07")).toThrow(/unsupported syndrome/);
  });
});

describe("query builder: region handling", () => {
  const regional = (f: ReturnType<typeof makeFacts>) => buildQuery(f).facets.find((x) => x.facet === "regional_context")!.sources.region;

  it("uses the signal's own region, its district and state (not the country), and the involved block names", () => {
    expect(regional(makeFacts())).toEqual(["Balianta", "Khordha", "Odisha"]);
    expect(regional(ganjamFacts())).toEqual(["Aska", "Ganjam", "Odisha"]);
  });

  it("adds every involved block of a multi-block, district-level signal (sorted by name)", () => {
    const f = makeFacts({
      region: { id: REGION.khordha, name: "Khordha", level: "district" },
      ancestors: [{ id: REGION.state, name: "Odisha", level: "state" }, { id: REGION.country, name: "India", level: "country" }],
      involved_blocks: [{ id: REGION.jatni, name: "Jatni" }, { id: REGION.balianta, name: "Balianta" }],
      spread: "multi_block",
    });
    expect(regional(f)).toEqual(["Balianta", "Jatni", "Khordha", "Odisha"]);
  });

  it("never puts region identifiers or counts into the query", () => {
    const text = JSON.stringify(buildQuery(makeFacts()));
    for (const id of [REGION.balianta, REGION.khordha, REGION.state, REGION.country]) expect(text).not.toContain(id);
    expect(text).not.toMatch(/\bobserved\b|\bp_value\b|\bscore\b|\bsample\b/i);
  });

  it("does not use region names in non-regional facets", () => {
    const q = buildQuery(makeFacts());
    for (const f of q.facets.filter((x) => x.facet !== "regional_context")) expect(f.tokens).not.toContain("balianta");
  });
});

describe("query builder: season from the signal window", () => {
  it.each([
    [1, "winter"], [2, "winter"], [3, "pre_monsoon"], [5, "pre_monsoon"], [6, "monsoon"], [9, "monsoon"], [10, "post_monsoon"], [12, "post_monsoon"],
  ])("month %i is %s", (m, s) => expect(SEASON_BY_MONTH[m]).toBe(s));

  it("maps every month and rejects non-dates", () => {
    for (let m = 1; m <= 12; m += 1) expect(seasonOf(`2025-${String(m).padStart(2, "0")}-15`)).toBe(SEASON_BY_MONTH[m]);
    expect(() => seasonOf("2025-13-01")).toThrow(RangeError);
  });

  it("changes the regional terms only", () => {
    const monsoon = buildQuery(makeFacts({ window: { start: "2025-08-25", end: "2025-09-01" } }));
    const winter = buildQuery(makeFacts({ window: { start: "2025-01-10", end: "2025-01-16" } }));
    const get = (q: typeof monsoon, f: string) => q.facets.find((x) => x.facet === f)!;
    expect(get(monsoon, "regional_context").terms).toContain("monsoon");
    expect(get(winter, "regional_context").terms).toContain("winter");
    expect(get(winter, "regional_context").terms).not.toContain("monsoon");
    expect(get(monsoon, "case_definition").terms).toEqual(get(winter, "case_definition").terms);
  });
});

describe("query builder: signal characteristics select optional wording", () => {
  const terms = (f: ReturnType<typeof makeFacts>, facet: string) => buildQuery(f).facets.find((x) => x.facet === facet)!.terms;

  it("adds spread wording to verification and regional facets only", () => {
    expect(terms(makeFacts({ spread: "district_wide" }), "verification_guidance")).toContain("district wide");
    expect(terms(makeFacts({ spread: "multi_block" }), "verification_guidance")).toContain("several blocks");
    expect(terms(makeFacts({ spread: "single_block" }), "regional_context")).toContain("block");
    for (const facet of ["case_definition", "epidemiological_context"]) {
      expect(terms(makeFacts({ spread: "district_wide" }), facet)).toEqual(terms(makeFacts({ spread: "unknown" }), facet));
    }
  });

  it("adds persistence wording to the verification facet only", () => {
    expect(terms(makeFacts({ persistence: "sustained" }), "verification_guidance")).toContain("ongoing");
    expect(terms(makeFacts({ persistence: "emerging" }), "verification_guidance")).toContain("early");
    expect(terms(makeFacts({ persistence: "unknown", spread: "unknown" }), "verification_guidance")).not.toContain("ongoing");
    expect(terms(makeFacts({ persistence: "sustained" }), "regional_context")).toEqual(terms(makeFacts({ persistence: "emerging" }), "regional_context"));
  });

  it("classifies spread and persistence from score components with documented thresholds", () => {
    expect(classifySpread("block", 1, 4)).toBe("single_block");
    expect(classifySpread("district", 1, 4)).toBe("single_block");
    expect(classifySpread("district", 2, 4)).toBe("district_wide");
    expect(classifySpread("district", 2, 5)).toBe("multi_block");
    expect(classifySpread("district", 3, null)).toBe("unknown");
    expect(classifyPersistence(0.75)).toBe("sustained");
    expect(classifyPersistence(0.74)).toBe("emerging");
    expect(classifyPersistence(null)).toBe("unknown");
  });
});

describe("query builder: determinism", () => {
  it("produces byte-identical queries for identical facts, however the facts object was assembled", () => {
    const a = buildQuery(makeFacts());
    const b = buildQuery(JSON.parse(JSON.stringify(makeFacts())));
    const reordered = makeFacts();
    const shuffled = Object.fromEntries(Object.entries(reordered).reverse()) as typeof reordered;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(buildQuery(shuffled).queryHash).toBe(a.queryHash);
    for (let i = 0; i < 20; i += 1) expect(buildQuery(makeFacts()).queryHash).toBe(a.queryHash);
  });

  it("changes when any input that should matter changes", () => {
    const base = buildQuery(makeFacts()).queryHash;
    expect(buildQuery(makeFacts({ syndrome: "fever" })).queryHash).not.toBe(base);
    expect(buildQuery(makeFacts({ spread: "district_wide" })).queryHash).not.toBe(base);
    expect(buildQuery(makeFacts({ persistence: "emerging" })).queryHash).not.toBe(base);
    expect(buildQuery(makeFacts({ window: { start: "2025-12-01", end: "2025-12-07" } })).queryHash).not.toBe(base);
    expect(buildQuery(makeFacts({ signal_id: uid("signal:other") })).queryHash).not.toBe(base);
    expect(buildQuery(makeFacts(), { asOfDate: "2025-09-08" }).queryHash).not.toBe(base);
  });
});
