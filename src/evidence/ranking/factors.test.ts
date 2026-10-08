// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SOURCE_CLASS_TIERS } from "../vocab";
import { assessClass, assessGeography, assessTemporal, daysBetween, normaliseRelevance } from "./factors";
import { RANKING_CONFIG_V1, RANK_NOTICE, TIER_LABELS, defaultClassTable, makeRankingConfig, rankingConfigHash } from "./policy";
import { REGION, makeFacts, otherStateFacts } from "../retrieval/testkit";

const cfg = RANKING_CONFIG_V1;
/** Pinned: any change to a ranking policy value changes this hash, and updating the pin is a deliberate, reviewed act. */
const GOLDEN_RANKING_CONFIG_HASH = "f288734e732142d6bbab1afeeb8acc6e5a47aee0fcd97a3ef07e6ccc44c19d5d";

describe("ranking policy", () => {
  it("is pinned by a canonical hash and sensitive to every value", () => {
    expect(rankingConfigHash(cfg)).toBe(GOLDEN_RANKING_CONFIG_HASH);
    expect(rankingConfigHash(makeRankingConfig())).toBe(GOLDEN_RANKING_CONFIG_HASH);
    expect(rankingConfigHash(makeRankingConfig({ relevanceFloor: 0.2 }))).not.toBe(GOLDEN_RANKING_CONFIG_HASH);
    expect(rankingConfigHash(makeRankingConfig({ classTable: { ...defaultClassTable(), other_verified: 0.71 } }))).not.toBe(GOLDEN_RANKING_CONFIG_HASH);
  });

  it("states, in the configuration itself, that the score is presentation priority and not a probability", () => {
    expect(RANK_NOTICE).toMatch(/presentation priority for a verifier, not the probability that an evidence item is correct/);
    expect(cfg.notice).toBe(RANK_NOTICE);
    expect(cfg.classFactor.meaning).toMatch(/not trustworthiness, accuracy or probability/);
  });

  it("publishes the approved discrete tables", () => {
    expect(cfg.geoFactor.table).toEqual({ district: 1, state: 1, national: 0.85, regional: 0.7, global: 0.7 });
    expect(cfg.temporalFactor.ageBuckets).toEqual([{ maxDays: 90, factor: 1 }, { maxDays: 365, factor: 0.6 }, { maxDays: null, factor: 0.3 }]);
    expect(cfg.diversity).toEqual({ maxChunksPerDocument: 2, maxChunksPerPublisher: 3 });
    expect(cfg.dedup.jaccardThreshold).toEqual({ numerator: 17, denominator: 20 });
  });

  it("orders the class ladder by the M4 tier order, strictly decreasing, with unverified never ranked", () => {
    const t = cfg.classFactor.table;
    const ranked = SOURCE_CLASS_TIERS.filter((c) => c !== "unverified");
    for (let i = 1; i < ranked.length; i += 1) expect(t[ranked[i]]!).toBeLessThan(t[ranked[i - 1]]!);
    expect(t.intergovernmental_health_authority).toBe(1);
    expect(t.other_verified).toBe(0.7);
    expect(t.unverified).toBeNull();
    expect(Object.keys(t).sort()).toEqual([...SOURCE_CLASS_TIERS].sort());
  });
});

describe("relevance normalisation (max within the facet's candidate set)", () => {
  it("scales the best match to exactly 1 and keeps the ratios", () => {
    const n = normaliseRelevance([8, 4, 2, 1]);
    expect(n.maximum).toBe(8);
    expect(n.values).toEqual([1, 0.5, 0.25, 0.125]);
  });

  it("keeps ties tied", () => {
    expect(normaliseRelevance([3, 3, 1.5]).values).toEqual([1, 1, 0.5]);
  });

  it("handles an empty set: nothing to normalise", () => {
    expect(normaliseRelevance([])).toEqual({ values: [], maximum: 0 });
  });

  it("handles a single candidate: relevance 1", () => {
    expect(normaliseRelevance([0.0123])).toEqual({ values: [1], maximum: 0.0123 });
  });

  it("handles zero scores without NaN or division by zero", () => {
    expect(normaliseRelevance([0, 0, 0])).toEqual({ values: [0, 0, 0], maximum: 0 });
    expect(normaliseRelevance([5, 0, 2.5]).values).toEqual([1, 0, 0.5]);
  });

  it("treats negative and non-finite scores as 0, never NaN", () => {
    const n = normaliseRelevance([-3, Number.NaN, Number.POSITIVE_INFINITY, 4, Number.NEGATIVE_INFINITY]);
    expect(n.values).toEqual([0, 0, 0, 1, 0]);
    expect(n.values.every(Number.isFinite)).toBe(true);
    expect(normaliseRelevance([Number.NaN, -1]).values).toEqual([0, 0]);
  });

  it("is invariant to the scale of the scores (only ratios matter) and independent of input order", () => {
    const a = normaliseRelevance([6, 3, 1]).values;
    expect(normaliseRelevance([60, 30, 10]).values).toEqual(a);
    expect(normaliseRelevance([1, 6, 3]).values).toEqual([a[2], a[0], a[1]]);
  });

  it("rounds deterministically and never exceeds 1", () => {
    const n = normaliseRelevance([1 / 3, 2 / 3, 1]);
    expect(Math.max(...n.values)).toBe(1);
    expect(n.values.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(n.values).toEqual(normaliseRelevance([1 / 3, 2 / 3, 1]).values);
  });
});

describe("source-class factor", () => {
  it.each([
    ["intergovernmental_health_authority", 1, 1], ["national_government_health_agency", 0.95, 2], ["state_government_health_agency", 0.9, 3],
    ["peer_reviewed_literature", 0.85, 4], ["recognized_institution", 0.8, 5], ["professional_society_guideline", 0.75, 6], ["other_verified", 0.7, 7],
  ])("%s -> %d (tier %d)", (cls, value, tier) => {
    const a = assessClass(cls, cfg);
    expect(a.ok).toBe(true);
    if (a.ok === false) return;
    expect(a.component).toMatchObject({ value, tier, sourceClass: cls, tierLabel: TIER_LABELS[cls as keyof typeof TIER_LABELS] });
  });

  it("never ranks an unverified or unknown source", () => {
    expect(assessClass("unverified", cfg)).toMatchObject({ ok: false, reason: "source_class_not_rankable" });
    expect(assessClass("wikipedia", cfg)).toMatchObject({ ok: false, reason: "source_class_not_rankable" });
  });

  it("describes itself as ordinal presentation priority, never as probability, truth or confidence in correctness", () => {
    const a = assessClass("national_government_health_agency", cfg);
    if (a.ok === false) throw new Error("unreachable");
    expect(Object.keys(a.component).sort()).toEqual(["basis", "sourceClass", "tier", "tierLabel", "value"]);
    expect(a.component.basis).toMatch(/not a probability, not a truth score, not confidence in correctness/);
  });

  it("uses a custom table when one is supplied (as the sensitivity analysis does)", () => {
    const c = makeRankingConfig({ classTable: { ...defaultClassTable(), other_verified: 0.5 } });
    const a = assessClass("other_verified", c);
    expect(a.ok && a.component.value).toBe(0.5);
  });
});

describe("geography ladder (wrong place is excluded, never down-weighted)", () => {
  const facts = makeFacts(); // Balianta block, Khordha district, Odisha
  const geo = (geoScope: string | null, geoRegionId: string | null, f = facts) => assessGeography({ geoScope, geoRegionId }, f, cfg);

  it("national 0.85, regional 0.7, global 0.7", () => {
    expect(geo("national", null)).toMatchObject({ ok: true, component: { value: 0.85, evidenceScope: "national" } });
    expect(geo("regional", null)).toMatchObject({ ok: true, component: { value: 0.7, evidenceScope: "regional" } });
    expect(geo("global", null)).toMatchObject({ ok: true, component: { value: 0.7, evidenceScope: "global" } });
  });

  it("the signal's own state and own district score 1.0", () => {
    expect(geo("state", REGION.state)).toMatchObject({ ok: true, component: { value: 1, evidenceScope: "state" } });
    expect(geo("district", REGION.khordha)).toMatchObject({ ok: true, component: { value: 1, evidenceScope: "district" } });
  });

  it("records the evidence scope, the signal's geography and the reason", () => {
    const a = geo("district", REGION.khordha);
    if (a.ok === false) throw new Error("unreachable");
    expect(a.component.signalGeography).toEqual({ region: "Balianta", district: "Khordha", state: "Odisha" });
    expect(a.component.reason).toMatch(/own district/);
    const n = geo("national", null);
    if (n.ok === false) throw new Error("unreachable");
    expect(n.component.reason).toMatch(/national scope/);
  });

  it("excludes a different district of the same state", () => {
    const a = geo("district", REGION.ganjam);
    expect(a).toMatchObject({ ok: false, reason: "geographic_ineligible" });
    if (a.ok === true) throw new Error("unreachable");
    expect(a.detail).toMatch(/not for the signal's own district/);
  });

  it("excludes a different state, and a different district of another state", () => {
    expect(geo("state", REGION.otherState)).toMatchObject({ ok: false, reason: "geographic_ineligible" });
    expect(geo("district", REGION.otherDistrict)).toMatchObject({ ok: false, reason: "geographic_ineligible" });
    expect(geo("state", REGION.state, otherStateFacts())).toMatchObject({ ok: false, reason: "geographic_ineligible" });
  });

  it("excludes a scope/level mismatch, a missing region, and a missing scope", () => {
    expect(geo("state", REGION.khordha)).toMatchObject({ ok: false });
    expect(geo("district", REGION.state)).toMatchObject({ ok: false });
    expect(geo("district", null)).toMatchObject({ ok: false });
    expect(geo(null, null)).toMatchObject({ ok: false, reason: "geographic_ineligible" });
  });

  it("never returns a down-weighted factor for the wrong place", () => {
    for (const [scope, id] of [["state", REGION.otherState], ["district", REGION.ganjam]] as const) expect("component" in geo(scope, id)).toBe(false);
  });
});

describe("temporal factor: hard exclusions", () => {
  const ctx = { asOfDate: "2025-09-07" };
  const meta = (o: Record<string, unknown> = {}) => ({ status: "current", evidenceKind: "operational_guidance", publicationDate: "2025-03-01", validFrom: "2025-03-01", validUntil: null as string | null, ...o });
  const t = (o: Record<string, unknown> = {}, opts = {}) => assessTemporal(meta(o) as never, ctx, cfg, opts);
  const reason = (o: Record<string, unknown>) => {
    const r = t(o);
    return r.ok === false ? r.reason : "ok";
  };

  it("excludes withdrawn, superseded, historical and any other non-current status from the main list", () => {
    expect(reason({ status: "withdrawn" })).toBe("withdrawn");
    expect(reason({ status: "superseded" })).toBe("superseded");
    expect(reason({ status: "historical" })).toBe("historical");
    for (const status of ["draft", "quarantined"]) expect(reason({ status })).toBe("not_current");
  });

  it("excludes evidence published after the as-of date (no look-ahead), but not on it", () => {
    expect(reason({ publicationDate: "2025-09-08" })).toBe("look_ahead");
    expect(reason({ publicationDate: "2025-09-07" })).toBe("ok");
  });

  it("excludes evidence that is not yet valid", () => {
    expect(reason({ validFrom: "2025-09-08" })).toBe("not_yet_valid");
    expect(reason({ validFrom: "2025-09-07" })).toBe("ok");
  });

  it("excludes expired guidance and case definitions, but not on the last valid day", () => {
    expect(reason({ validUntil: "2025-09-06" })).toBe("expired");
    expect(reason({ evidenceKind: "case_definition", validUntil: "2025-01-01" })).toBe("expired");
    expect(reason({ validUntil: "2025-09-07" })).toBe("ok");
  });

  it("does not apply the expiry rule to other kinds", () => {
    for (const evidenceKind of ["situation_report", "surveillance_data", "research", "clinical_epidemiology_reference"]) expect(reason({ evidenceKind, validUntil: "2020-01-01" }), evidenceKind).toBe("ok");
  });

  it("fails closed on a missing or unknown evidence kind", () => {
    expect(reason({ evidenceKind: null })).toBe("unknown_evidence_kind");
    expect(reason({ evidenceKind: "blog_post" })).toBe("unknown_evidence_kind");
  });

  it("every exclusion explains itself", () => {
    const r = t({ status: "withdrawn" });
    expect(r.ok === false && r.detail).toMatch(/status is withdrawn/);
  });
});

describe("temporal factor: weights", () => {
  const ctx = { asOfDate: "2025-09-07" };
  const w = (o: Record<string, unknown>) => {
    const r = assessTemporal({ status: "current", evidenceKind: "operational_guidance", publicationDate: "2025-03-01", validFrom: "2025-03-01", validUntil: null, ...o } as never, ctx, cfg);
    if (r.ok === false) throw new Error(`unexpected exclusion ${r.reason}`);
    return r.component;
  };

  it("guidance and case definitions: 1.0 with no age decay, however old", () => {
    for (const evidenceKind of ["operational_guidance", "case_definition"]) {
      expect(w({ evidenceKind, publicationDate: "2010-01-01", validFrom: "2010-01-01" })).toMatchObject({ value: 1, rule: "current_guidance_no_decay", ageDays: null });
    }
  });

  it("clinical/epidemiology references: no age decay", () => {
    expect(w({ evidenceKind: "clinical_epidemiology_reference", publicationDate: "2001-01-01", validFrom: "2001-01-01" })).toMatchObject({ value: 1, rule: "reference_no_decay" });
  });

  it("research: neutral", () => {
    expect(w({ evidenceKind: "research", publicationDate: "1999-01-01", validFrom: "1999-01-01" })).toMatchObject({ value: 1, rule: "research_neutral" });
  });

  it.each(["situation_report", "surveillance_data"])("%s: age buckets 1.0 / 0.6 / 0.3 with inclusive boundaries", (evidenceKind) => {
    const at = (days: number) => {
      const d = new Date(Date.UTC(2025, 8, 7) - days * 86_400_000).toISOString().slice(0, 10);
      return w({ evidenceKind, publicationDate: d, validFrom: d }).value;
    };
    expect(at(0)).toBe(1);
    expect(at(89)).toBe(1);
    expect(at(90)).toBe(1); // <= 90 days is inclusive
    expect(at(91)).toBe(0.6);
    expect(at(365)).toBe(0.6); // <= 1 year is inclusive
    expect(at(366)).toBe(0.3);
    expect(at(2000)).toBe(0.3);
  });

  it("records the age and the rule", () => {
    expect(w({ evidenceKind: "situation_report", publicationDate: "2025-09-01", validFrom: "2025-09-01" })).toMatchObject({ value: 1, ageDays: 6, rule: "age_within_90_days" });
    expect(w({ evidenceKind: "situation_report", publicationDate: "2024-12-01", validFrom: "2024-12-01" })).toMatchObject({ value: 0.6, rule: "age_within_365_days" });
    expect(w({ evidenceKind: "surveillance_data", publicationDate: "2020-01-01", validFrom: "2020-01-01" })).toMatchObject({ value: 0.3, rule: "age_over_one_year" });
  });

  it("uses valid_from when there is no publication date, and the oldest bucket when there is no date at all", () => {
    expect(w({ evidenceKind: "situation_report", publicationDate: null, validFrom: "2025-08-01" })).toMatchObject({ value: 1, ageDays: 37 });
    expect(w({ evidenceKind: "situation_report", publicationDate: null, validFrom: null })).toMatchObject({ value: 0.3, rule: "age_unknown_oldest_bucket", ageDays: null });
  });

  it("is a pure function of its inputs and counts days exactly across month and leap-year boundaries", () => {
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
    expect(daysBetween("2025-02-28", "2025-03-01")).toBe(1);
    expect(daysBetween("2025-09-07", "2025-09-07")).toBe(0);
    expect(daysBetween("2024-09-07", "2025-09-07")).toBe(365);
    expect(daysBetween("2023-09-07", "2024-09-07")).toBe(366);
  });

  it("historical-context mode accepts superseded / historical statuses with a neutral factor and ignores expiry", () => {
    const r = assessTemporal({ status: "superseded", evidenceKind: "operational_guidance", publicationDate: "2022-04-01", validFrom: "2022-04-01", validUntil: "2024-12-31" } as never, ctx, cfg, { allowHistoricalStatuses: true });
    expect(r).toMatchObject({ ok: true, component: { value: 1, rule: "historical_context_neutral" } });
    expect(assessTemporal({ status: "withdrawn", evidenceKind: "operational_guidance", publicationDate: "2022-04-01", validFrom: null, validUntil: null } as never, ctx, cfg, { allowHistoricalStatuses: true })).toMatchObject({ ok: false, reason: "withdrawn" });
  });

  it("does not tune: the policy values are exactly the approved ones", () => {
    expect(cfg.temporalFactor.ageBuckets.map((b) => b.factor)).toEqual([1, 0.6, 0.3]);
  });
});
