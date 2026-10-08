// @vitest-environment node
import { describe, expect, it } from "vitest";
import { RETRIEVAL_CONFIG_DEV, RETRIEVAL_CONFIG_V1 } from "./config";
import type { CorpusItem } from "./corpus";
import { evaluateEligibility, type EligibilityContext } from "./eligibility";
import { REGION } from "./testkit";

const policy = RETRIEVAL_CONFIG_DEV.eligibility;
const ctx: EligibilityContext = {
  syndrome: "acute_diarrhoeal_illness",
  regionChain: [
    { id: REGION.balianta, level: "block" },
    { id: REGION.khordha, level: "district" },
    { id: REGION.state, level: "state" },
    { id: REGION.country, level: "country" },
  ],
  asOfDate: "2025-09-07",
};
const TOPICS = ["outbreak_investigation", "surveillance_methods"];

const base: CorpusItem = {
  id: "item-1", canonicalId: "syn-x", title: "T", publisher: "Synthetic P", sourceClass: "national_government_health_agency", evidenceKind: "operational_guidance",
  trustLevel: "trusted", status: "current", topics: ["outbreak_investigation"], syndromes: [], geoScope: "national", geoRegionId: null, language: "en",
  publicationDate: "2025-03-01", validFrom: "2025-03-01", validUntil: null, isSynthetic: true, supersedesId: null,
  version: { id: "v1", contentHash: "a".repeat(64), fetchStatus: "not_fetched" },
  chunks: [{ id: "c1", ordinal: 0, kind: "abstract", text: "text", chunkHash: "b".repeat(64), language: "en" }],
};
const item = (o: Partial<CorpusItem> = {}): CorpusItem => ({ ...base, ...o });
const check = (o: Partial<CorpusItem>, p = policy, c = ctx, topics: readonly string[] = TOPICS) => evaluateEligibility(item(o), topics, c, p);
const reasons = (o: Partial<CorpusItem>, p = policy, c = ctx, topics: readonly string[] = TOPICS) => {
  const r = check(o, p, c, topics);
  return r.eligible === false ? r.reasons : [];
};

describe("eligibility: the baseline", () => {
  it("accepts a current, trusted, general, national, English document on a matching topic", () => {
    expect(check({})).toEqual({ eligible: true, geoMatch: "national" });
  });
});

describe("eligibility: status (only current may compete)", () => {
  it.each(["draft", "quarantined", "superseded", "withdrawn", "historical"])("excludes %s", (status) => {
    expect(reasons({ status })).toContain("status_not_eligible");
  });
});

describe("eligibility: trust and provenance", () => {
  it("excludes unreviewed documents and honours a stricter minimum trust", () => {
    expect(reasons({ trustLevel: "unreviewed" })).toContain("trust_below_minimum");
    expect(check({ trustLevel: "reviewed" }).eligible).toBe(true);
    expect(reasons({ trustLevel: "reviewed" }, { ...policy, minTrust: "trusted" })).toContain("trust_below_minimum");
    expect(reasons({ trustLevel: "not-a-level" })).toContain("trust_below_minimum"); // unknown fails closed
  });

  it("never lets an unverified source compete, even if somehow marked current and trusted", () => {
    expect(reasons({ sourceClass: "unverified", trustLevel: "trusted", status: "current" })).toEqual(["source_class_excluded"]);
  });

  it("admits every other issuer class", () => {
    for (const c of ["intergovernmental_health_authority", "national_government_health_agency", "state_government_health_agency", "peer_reviewed_literature", "recognized_institution", "professional_society_guideline", "other_verified"]) {
      expect(check({ sourceClass: c }).eligible, c).toBe(true);
    }
  });

  it("admits synthetic documents only where the configuration opts in", () => {
    expect(check({ isSynthetic: true }, RETRIEVAL_CONFIG_DEV.eligibility).eligible).toBe(true);
    expect(reasons({ isSynthetic: true }, RETRIEVAL_CONFIG_V1.eligibility)).toEqual(["synthetic_not_allowed"]);
    expect(check({ isSynthetic: false }, RETRIEVAL_CONFIG_V1.eligibility).eligible).toBe(true);
  });

  it("excludes a version whose last link check failed", () => {
    for (const fetchStatus of ["changed", "unreachable"]) expect(reasons({ version: { ...base.version!, fetchStatus } })).toContain("source_check_failed");
    for (const fetchStatus of ["ok", "not_fetched", "not_modified"]) expect(check({ version: { ...base.version!, fetchStatus } }).eligible, fetchStatus).toBe(true);
  });
});

describe("eligibility: content and language", () => {
  it("needs a current version with text", () => {
    expect(reasons({ version: null, chunks: [] })).toContain("no_current_version");
    expect(reasons({ chunks: [] })).toContain("no_chunks");
  });

  it("admits only languages the query vocabulary covers (English now); no cross-lingual claim", () => {
    expect(check({ language: "en" }).eligible).toBe(true);
    for (const language of ["hi", "or", "fr", null]) expect(reasons({ language }), String(language)).toContain("language_not_queryable");
    expect(check({ language: "hi" }, { ...policy, languages: ["en", "hi"] }).eligible).toBe(true);
  });
});

describe("eligibility: topic and syndrome compatibility", () => {
  it("needs at least one topic in common with the facet", () => {
    expect(reasons({ topics: ["monsoon_seasonality"] })).toEqual(["topic_mismatch"]);
    expect(check({ topics: ["monsoon_seasonality", "surveillance_methods"] }).eligible).toBe(true);
    expect(reasons({ topics: [] })).toContain("topic_mismatch");
  });

  it("treats a document naming no syndromes as general and one naming syndromes as specific", () => {
    expect(check({ syndromes: [] }).eligible).toBe(true);
    expect(check({ syndromes: ["acute_diarrhoeal_illness"] }).eligible).toBe(true);
    expect(check({ syndromes: ["jaundice", "acute_diarrhoeal_illness"] }).eligible).toBe(true);
    expect(reasons({ syndromes: ["fever"] })).toEqual(["syndrome_mismatch"]);
    expect(reasons({ syndromes: ["jaundice", "respiratory_illness"] })).toEqual(["syndrome_mismatch"]);
  });
});

describe("eligibility: geography (no fabricated applicability)", () => {
  it.each(["global", "regional", "national"])("%s documents are eligible everywhere and keep their label", (geoScope) => {
    expect(check({ geoScope })).toEqual({ eligible: true, geoMatch: geoScope });
    expect(evaluateEligibility(item({ geoScope }), TOPICS, { ...ctx, regionChain: [{ id: REGION.otherDistrict, level: "district" }] }, policy)).toEqual({ eligible: true, geoMatch: geoScope });
  });

  it("admits a state document only for the signal's own state, and a district document only for its own district", () => {
    expect(check({ geoScope: "state", geoRegionId: REGION.state })).toEqual({ eligible: true, geoMatch: "state" });
    expect(check({ geoScope: "district", geoRegionId: REGION.khordha })).toEqual({ eligible: true, geoMatch: "district" });
  });

  it("excludes a different district of the same state", () => {
    expect(reasons({ geoScope: "district", geoRegionId: REGION.ganjam })).toEqual(["geo_scope_mismatch"]);
  });

  it("excludes a different state entirely", () => {
    expect(reasons({ geoScope: "state", geoRegionId: REGION.otherState })).toEqual(["geo_scope_mismatch"]);
    expect(reasons({ geoScope: "district", geoRegionId: REGION.otherDistrict })).toEqual(["geo_scope_mismatch"]);
  });

  it("does not let a scope/region-level mismatch pass (a 'state' document pointing at the signal's district, and vice versa)", () => {
    expect(reasons({ geoScope: "state", geoRegionId: REGION.khordha })).toEqual(["geo_scope_mismatch"]);
    expect(reasons({ geoScope: "district", geoRegionId: REGION.state })).toEqual(["geo_scope_mismatch"]);
  });

  it("does not treat an ancestor/child relationship by name or by missing ids as a match", () => {
    expect(reasons({ geoScope: "state", geoRegionId: null })).toEqual(["geo_scope_mismatch"]);
    expect(reasons({ geoScope: "district", geoRegionId: REGION.balianta })).toEqual(["geo_scope_mismatch"]); // a block id is not a district
  });

  it("excludes a document with no geography at all", () => {
    expect(reasons({ geoScope: null })).toEqual(["geo_scope_missing"]);
  });

  it("a state-wide signal is matched only by its own state document (no inference down or up)", () => {
    const stateLevel: EligibilityContext = { ...ctx, regionChain: [{ id: REGION.state, level: "state" }, { id: REGION.country, level: "country" }] };
    expect(evaluateEligibility(item({ geoScope: "state", geoRegionId: REGION.state }), TOPICS, stateLevel, policy).eligible).toBe(true);
    expect(evaluateEligibility(item({ geoScope: "district", geoRegionId: REGION.khordha }), TOPICS, stateLevel, policy).eligible).toBe(false);
  });
});

describe("eligibility: binary temporal rules (not scoring)", () => {
  it("excludes evidence published after the as-of date (no look-ahead) but not on it", () => {
    expect(reasons({ publicationDate: "2025-09-08" })).toEqual(["published_after_as_of"]);
    expect(check({ publicationDate: "2025-09-07" }).eligible).toBe(true);
    expect(check({ publicationDate: null }).eligible).toBe(true);
  });

  it("excludes a document that is not yet valid", () => {
    expect(reasons({ validFrom: "2025-09-08" })).toEqual(["not_yet_valid"]);
    expect(check({ validFrom: "2025-09-07" }).eligible).toBe(true);
  });

  it("excludes expired guidance and case definitions, but not on the last valid day", () => {
    expect(reasons({ validUntil: "2025-09-06" })).toEqual(["validity_ended"]);
    expect(reasons({ evidenceKind: "case_definition", validUntil: "2025-01-01" })).toEqual(["validity_ended"]);
    expect(check({ validUntil: "2025-09-07" }).eligible).toBe(true);
  });

  it("does not apply the expiry rule to other kinds (their age is a presentation matter for M4.3)", () => {
    for (const evidenceKind of ["situation_report", "surveillance_data", "research", "clinical_epidemiology_reference"]) {
      expect(check({ evidenceKind, validUntil: "2020-01-01" }).eligible, evidenceKind).toBe(true);
    }
  });

  it("is a binary filter: an old but eligible situation report is NOT penalised here", () => {
    expect(check({ evidenceKind: "situation_report", publicationDate: "2015-01-01", validFrom: "2015-01-01" })).toEqual({ eligible: true, geoMatch: "national" });
  });

  it("honours a retrospective as-of date", () => {
    const retro: EligibilityContext = { ...ctx, asOfDate: "2025-02-01" };
    expect(reasons({ publicationDate: "2025-03-01" }, policy, retro)).toContain("published_after_as_of");
    expect(reasons({ validFrom: "2025-03-01" }, policy, retro)).toContain("not_yet_valid");
  });
});

describe("eligibility: reasons are complete and deterministic", () => {
  it("reports every failing reason, sorted", () => {
    const r = reasons({ status: "quarantined", trustLevel: "unreviewed", sourceClass: "unverified", language: "hi", topics: [], syndromes: ["fever"], geoScope: null });
    expect(r).toEqual([...r].sort());
    expect(r).toEqual(["geo_scope_missing", "language_not_queryable", "source_class_excluded", "status_not_eligible", "syndrome_mismatch", "topic_mismatch", "trust_below_minimum"]);
  });

  it("is a pure function of its inputs", () => {
    const a = check({ topics: ["x"] });
    for (let i = 0; i < 10; i += 1) expect(check({ topics: ["x"] })).toEqual(a);
  });
});
