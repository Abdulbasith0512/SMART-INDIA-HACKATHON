// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { RankedCandidate } from "../ranking/types";
import { makeFacts, SYNDROMES } from "../retrieval/testkit";
import { FACET_LABEL, SYNDROME_LABEL, whyRelevant } from "./reasons";
import { referenceBundle } from "./testkit";

/** Every reason the engine can write is one of these fixed templates. */
const TEMPLATES: RegExp[] = [
  /^topic match: [a-z_, ]+ \((verification guidance|case definition|epidemiological context|regional context) facet\)$/,
  /^syndrome match: specific to [a-z ]+$/,
  /^syndrome match: general document that applies to every syndrome$/,
  /^query terms matched: [\p{L}\p{M}\p{N}, ]+( \(\+\d+ more\))?$/u,
  /^lexical match strength: \d{1,3}% of the best match in this facet$/,
  /^(current operational guidance|operational guidance|case definition document|epidemiological context: reference material, context for a verifier only|research literature)$/,
  /^(situation report|surveillance data) published (\d{4}-\d{2}-\d{2}|on an unknown date)$/,
  /^regional context: seasonal or local factors$/,
  /^geographic applicability: .+ scope: .+$/,
  /^source tier: [A-Za-z -]+ \(tier [1-7] of 7\)$/,
  /^temporal applicability: .+$/,
];

const candidate = ({ metadata, ...over }: Record<string, unknown> = {}): RankedCandidate =>
  ({
    metadata: { topics: ["outbreak_investigation"], syndromes: [], evidenceKind: "operational_guidance", publicationDate: "2025-03-01", ...((metadata as object) ?? {}) },
    matchedTerms: [{ term: "cluster", tf: 1, idf: 1 }, { term: "acute", tf: 1, idf: 1 }],
    tierLabel: "National government health agency",
    scoreComponents: {
      relevance: { value: 0.634 }, classFactor: { tier: 2 }, geoFactor: { reason: "national scope: applies across the country" },
      temporalFactor: { rule: "current_guidance_no_decay", reason: "operational_guidance is current: factor 1.0, no age decay" },
    },
    ...over,
  }) as unknown as RankedCandidate;

describe("why-relevant reasons", () => {
  it("are built only from fixed templates, across every syndrome and facet", () => {
    for (const syndrome of SYNDROMES) {
      const b = referenceBundle({ facts: makeFacts({ syndrome }) });
      for (const f of b.facets) {
        for (const i of f.items) for (const r of i.why_relevant) expect(TEMPLATES.some((t) => t.test(r)), `${syndrome}/${f.name}/${i.citation_id}: ${r}`).toBe(true);
      }
    }
  });

  it("follow a fixed order and always include relevance, geography, tier and time", () => {
    const b = referenceBundle();
    for (const f of b.facets) {
      for (const i of f.items) {
        const idx = (re: RegExp) => i.why_relevant.findIndex((r) => re.test(r));
        expect(idx(/^lexical match/)).toBeGreaterThan(-1);
        expect(idx(/^geographic applicability/)).toBeGreaterThan(idx(/^lexical match/));
        expect(idx(/^source tier/)).toBeGreaterThan(idx(/^geographic applicability/));
        expect(idx(/^temporal applicability/)).toBe(i.why_relevant.length - 1);
      }
    }
  });

  it("repeat the recorded facts and add nothing the ranking did not record", () => {
    const b = referenceBundle();
    for (const f of b.facets) {
      for (const i of f.items) {
        const sc = i.score_components as { relevance: { value: number }; geo_factor: { reason: string }; temporal_factor: { reason: string }; class_factor: { tier: number; tier_label: string } };
        expect(i.why_relevant).toContain(`lexical match strength: ${Math.round(sc.relevance.value * 100)}% of the best match in this facet`);
        expect(i.why_relevant).toContain(`geographic applicability: ${sc.geo_factor.reason}`);
        expect(i.why_relevant).toContain(`temporal applicability: ${sc.temporal_factor.reason}`);
        expect(i.why_relevant).toContain(`source tier: ${sc.class_factor.tier_label} (tier ${sc.class_factor.tier} of 7)`);
      }
    }
  });

  it("claim a syndrome match only when the document names the signal's syndrome, and call a document general only when it names none", () => {
    const base = { facetTopics: ["outbreak_investigation"] };
    expect(whyRelevant(candidate({ metadata: { syndromes: ["fever"] } }), "verification_guidance", { syndrome: "fever", ...base })).toContain("syndrome match: specific to fever");
    expect(whyRelevant(candidate({ metadata: { syndromes: [] } }), "verification_guidance", { syndrome: "fever", ...base })).toContain("syndrome match: general document that applies to every syndrome");
    const other = whyRelevant(candidate({ metadata: { syndromes: ["jaundice"] } }), "verification_guidance", { syndrome: "fever", ...base });
    expect(other.some((r) => r.startsWith("syndrome match"))).toBe(false);
  });

  it("claim a topic match only for topics the document and the facet share", () => {
    const r = whyRelevant(candidate({ metadata: { topics: ["outbreak_investigation", "water_sanitation"] } }), "regional_context", { syndrome: "fever", facetTopics: ["water_sanitation", "monsoon_seasonality"] });
    expect(r[0]).toBe("topic match: water_sanitation (regional context facet)");
    const none = whyRelevant(candidate({ metadata: { topics: ["case_definition"] } }), "regional_context", { syndrome: "fever", facetTopics: ["water_sanitation"] });
    expect(none.some((x) => x.startsWith("topic match"))).toBe(false);
  });

  it("describe the evidence kind only as what it is", () => {
    const r = (kind: string, rule = "x", pub: string | null = "2025-01-02") =>
      whyRelevant(candidate({ metadata: { evidenceKind: kind, publicationDate: pub }, scoreComponents: { ...candidate().scoreComponents, temporalFactor: { rule, reason: "r" } } }), "verification_guidance", { syndrome: "fever", facetTopics: [] });
    expect(r("operational_guidance", "current_guidance_no_decay")).toContain("current operational guidance");
    expect(r("operational_guidance", "other")).toContain("operational guidance");
    expect(r("case_definition")).toContain("case definition document");
    expect(r("clinical_epidemiology_reference")).toContain("epidemiological context: reference material, context for a verifier only");
    expect(r("situation_report")).toContain("situation report published 2025-01-02");
    expect(r("surveillance_data", "x", null)).toContain("surveillance data published on an unknown date");
    expect(r("research")).toContain("research literature");
    expect(r("something_new").some((x) => /guidance|definition|report|literature|reference/.test(x))).toBe(false);
  });

  it("list at most 8 matched terms, sorted, and say how many more there were", () => {
    const terms = Array.from({ length: 12 }, (_, i) => ({ term: `t${String(i).padStart(2, "0")}`, tf: 1, idf: 1 }));
    const r = whyRelevant(candidate({ matchedTerms: [...terms].reverse() }), "case_definition", { syndrome: "fever", facetTopics: [] });
    expect(r.find((x) => x.startsWith("query terms matched"))).toBe("query terms matched: t00, t01, t02, t03, t04, t05, t06, t07 (+4 more)");
  });

  it("add the regional line only for the regional facet", () => {
    const f = (facet: keyof typeof FACET_LABEL) => whyRelevant(candidate(), facet, { syndrome: "fever", facetTopics: [] });
    expect(f("regional_context")).toContain("regional context: seasonal or local factors");
    for (const facet of ["verification_guidance", "case_definition", "epidemiological_context"] as const) expect(f(facet)).not.toContain("regional context: seasonal or local factors");
  });

  it("never assert truth, cause, probability or a diagnosis", () => {
    const banned = /\bconfirm|\bprov(e|es|en)\b|indicat|\bcaus(e|es|ed)\b|diagnos|\blikely\b|probab|\btreat/i;
    for (const syndrome of SYNDROMES) for (const f of referenceBundle({ facts: makeFacts({ syndrome }) }).facets) for (const i of f.items) for (const r of i.why_relevant.filter((x) => !x.startsWith("query terms matched"))) expect(r, r).not.toMatch(banned); // the matched-terms line lists query tokens, it asserts nothing
  });

  it("have labels for every facet and syndrome", () => {
    expect(Object.keys(FACET_LABEL)).toHaveLength(4);
    for (const s of SYNDROMES) expect(SYNDROME_LABEL[s]).toBeTruthy();
  });
});
