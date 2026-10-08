// @vitest-environment node
// The independent safety oracle: every rule fires on exactly the property it names, and only then.
import { describe, expect, it } from "vitest";
import { ineligibleReasons, isGeoReason, isOtherIneligibleReason, isStaleReason, type OracleContext, type OracleDoc } from "./oracle";

const doc = (o: Partial<OracleDoc> = {}): OracleDoc => ({
  status: "current", trustLevel: "reviewed", sourceClass: "national_government_health_agency", language: "en", isSynthetic: false, geoScope: "national", geoRegionId: null,
  publicationDate: "2025-01-01", validFrom: "2025-01-01", validUntil: null, evidenceKind: "operational_guidance", ...o,
} as OracleDoc);
const ctx = (o: Partial<OracleContext> = {}): OracleContext => ({
  asOf: "2025-09-07", chain: [{ id: "D1", level: "district" }, { id: "S1", level: "state" }, { id: "C1", level: "country" }], profile: "production", ...o,
});

describe("ineligibleReasons", () => {
  it("allows an ordinary current, verified, English, national document", () => {
    expect(ineligibleReasons(doc(), ctx())).toEqual([]);
  });

  it("status: only current documents may be presented", () => {
    for (const s of ["superseded", "withdrawn", "draft", "quarantined", "historical"]) expect(ineligibleReasons(doc({ status: s as never }), ctx())).toEqual([`status:${s}`]);
  });

  it("unverified: an unverified source class or an unreviewed trust level", () => {
    expect(ineligibleReasons(doc({ sourceClass: "unverified" as never }), ctx())).toEqual(["unverified_source"]);
    expect(ineligibleReasons(doc({ trustLevel: "unreviewed" as never }), ctx())).toEqual(["unverified_source"]);
    expect(ineligibleReasons(doc({ trustLevel: "trusted" as never }), ctx())).toEqual([]);
  });

  it("language: only English", () => {
    expect(ineligibleReasons(doc({ language: "hi" }), ctx())).toEqual(["language_not_english"]);
    expect(ineligibleReasons(doc({ language: "or" }), ctx())).toEqual(["language_not_english"]);
  });

  it("synthetic documents are ineligible in production but allowed in the development profile", () => {
    expect(ineligibleReasons(doc({ isSynthetic: true }), ctx({ profile: "production" }))).toEqual(["synthetic_in_production"]);
    expect(ineligibleReasons(doc({ isSynthetic: true }), ctx({ profile: "dev" }))).toEqual([]);
    expect(ineligibleReasons(doc({ isSynthetic: false }), ctx({ profile: "production" }))).toEqual([]);
  });

  it("geography: state and district evidence must be for the signal's own place at the same level", () => {
    expect(ineligibleReasons(doc({ geoScope: "state", geoRegionId: "S1" }), ctx())).toEqual([]);
    expect(ineligibleReasons(doc({ geoScope: "district", geoRegionId: "D1" }), ctx())).toEqual([]);
    expect(ineligibleReasons(doc({ geoScope: "state", geoRegionId: "S2" }), ctx())).toEqual(["wrong_geography"]);
    expect(ineligibleReasons(doc({ geoScope: "district", geoRegionId: "D2" }), ctx())).toEqual(["wrong_geography"]);
    expect(ineligibleReasons(doc({ geoScope: "district", geoRegionId: "S1" }), ctx())).toEqual(["wrong_geography"]); // right id, wrong level
    expect(ineligibleReasons(doc({ geoScope: "state", geoRegionId: null }), ctx())).toEqual(["wrong_geography"]);
    for (const scope of ["global", "regional", "national"]) expect(ineligibleReasons(doc({ geoScope: scope as never, geoRegionId: null }), ctx())).toEqual([]);
  });

  it("no look-ahead: nothing published after the as-of date, nothing not yet valid", () => {
    expect(ineligibleReasons(doc({ publicationDate: "2025-09-08" }), ctx())).toEqual(["published_after_as_of"]);
    expect(ineligibleReasons(doc({ publicationDate: "2025-09-07" }), ctx())).toEqual([]);
    expect(ineligibleReasons(doc({ validFrom: "2025-09-08" }), ctx())).toEqual(["not_yet_valid"]);
    expect(ineligibleReasons(doc({ validFrom: "2025-09-07" }), ctx())).toEqual([]);
    expect(ineligibleReasons(doc({ publicationDate: null, validFrom: null }), ctx())).toEqual([]);
  });

  it("expiry applies to guidance and case definitions only, and only after valid_until", () => {
    expect(ineligibleReasons(doc({ validUntil: "2025-09-06", evidenceKind: "operational_guidance" }), ctx())).toEqual(["expired"]);
    expect(ineligibleReasons(doc({ validUntil: "2025-09-06", evidenceKind: "case_definition" }), ctx())).toEqual(["expired"]);
    expect(ineligibleReasons(doc({ validUntil: "2025-09-07", evidenceKind: "operational_guidance" }), ctx())).toEqual([]);
    expect(ineligibleReasons(doc({ validUntil: "2025-09-06", evidenceKind: "situation_report" }), ctx())).toEqual([]);
    expect(ineligibleReasons(doc({ validUntil: "2025-09-06", evidenceKind: null }), ctx())).toEqual([]);
  });

  it("reports every broken rule, sorted", () => {
    const r = ineligibleReasons(doc({ status: "withdrawn", language: "hi", isSynthetic: true, sourceClass: "unverified" as never }), ctx());
    expect(r).toEqual(["language_not_english", "status:withdrawn", "synthetic_in_production", "unverified_source"]);
    expect([...r].sort()).toEqual(r);
  });
});

describe("reason classes", () => {
  it("separates stale, wrong-place and other ineligibility", () => {
    for (const r of ["status:superseded", "status:withdrawn", "published_after_as_of", "not_yet_valid", "expired"]) {
      expect(isStaleReason(r), r).toBe(true);
      expect(isGeoReason(r), r).toBe(false);
      expect(isOtherIneligibleReason(r), r).toBe(false);
    }
    expect(isGeoReason("wrong_geography")).toBe(true);
    expect(isStaleReason("wrong_geography")).toBe(false);
    for (const r of ["unverified_source", "language_not_english", "synthetic_in_production"]) {
      expect(isOtherIneligibleReason(r), r).toBe(true);
      expect(isStaleReason(r), r).toBe(false);
      expect(isGeoReason(r), r).toBe(false);
    }
  });
});
