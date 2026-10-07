// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReportingService } from "./service";
import { sanitizeFreeText } from "./sanitize";
import type { HealthReportInsertRow, RegionInfo, ReportingGateway } from "./contracts";

const USER = "11111111-1111-4111-8111-111111111111";
const BLOCK = "22222222-2222-4222-8222-222222222222";
const LOCALITY = "33333333-3333-4333-8333-333333333333";
const DISTRICT = "44444444-4444-4444-8444-444444444444";
const STATE = "55555555-5555-4555-8555-555555555555";
const INACTIVE = "66666666-6666-4666-8666-666666666666";
const MISSING = "77777777-7777-4777-8777-777777777777";
const NOW = new Date("2026-09-01T10:00:00Z");

const regions: Record<string, RegionInfo> = {
  [BLOCK]: { id: BLOCK, region_type: "block", active: true },
  [LOCALITY]: { id: LOCALITY, region_type: "locality", active: true },
  [DISTRICT]: { id: DISTRICT, region_type: "district", active: true },
  [STATE]: { id: STATE, region_type: "state", active: true },
  [INACTIVE]: { id: INACTIVE, region_type: "block", active: false },
};

interface FakeOpts {
  userId?: string | null;
  insert?: (row: HealthReportInsertRow) => ReturnType<ReportingGateway["insertReport"]>;
  existing?: string | null;
}

function makeGateway(opts: FakeOpts = {}) {
  const inserted: HealthReportInsertRow[] = [];
  const gateway: ReportingGateway = {
    getCurrentUserId: vi.fn(async () => (opts.userId === undefined ? USER : opts.userId)),
    getRegion: vi.fn(async (id: string) => regions[id] ?? null),
    insertReport: vi.fn(async (row: HealthReportInsertRow) => {
      inserted.push(row);
      return opts.insert ? opts.insert(row) : { id: "report-1" };
    }),
    findReportId: vi.fn(async () => (opts.existing === undefined ? "report-0" : opts.existing)),
  };
  return { gateway, inserted };
}

const svc = (g: ReportingGateway) => createReportingService(g, { now: () => NOW, newId: () => "99999999-9999-4999-8999-999999999999" });

const valid = () => ({
  observedAt: "2026-08-31T08:30:00+05:30",
  sourceType: "citizen" as const,
  regionId: BLOCK,
  syndrome: "acute_diarrhoeal_illness" as const,
  symptomCodes: ["vomiting", "diarrhoea", "vomiting"] as ("vomiting" | "diarrhoea")[],
  severity: "moderate" as const,
  ageBand: "age_18_44" as const,
  language: "or" as const,
});

let g: ReturnType<typeof makeGateway>;
beforeEach(() => { g = makeGateway(); });

describe("valid submission", () => {
  it("is accepted, normalised and persisted without system-controlled columns", async () => {
    const r = await svc(g.gateway).submitHealthReport(valid());
    expect(r).toMatchObject({ status: "accepted", reportId: "report-1", processingStatus: "received", redactions: 0 });
    expect(g.inserted).toHaveLength(1);
    const row = g.inserted[0];
    expect(row).toMatchObject({
      submitted_by: USER, source_type: "citizen", region_id: BLOCK, report_type: "individual_observation",
      syndrome: "acute_diarrhoeal_illness", severity: "moderate", age_band: "age_18_44", case_count: 1, language: "or", free_text: null,
      client_submission_id: "99999999-9999-4999-8999-999999999999",
    });
    expect(row.symptom_codes).toEqual(["diarrhoea", "vomiting"]); // deduped + sorted
    expect(row.observed_at).toBe("2026-08-31T03:00:00.000Z"); // normalised to UTC
    for (const forbidden of ["processing_status", "privacy_level", "synthetic_batch", "id", "created_at"]) {
      expect(row).not.toHaveProperty(forbidden);
    }
  });

  it("accepts a locality and applies safe defaults", async () => {
    const r = await svc(g.gateway).submitHealthReport({ observedAt: "2026-09-01T09:00:00Z", sourceType: "citizen", regionId: LOCALITY, syndrome: "fever" });
    expect(r.status).toBe("accepted");
    expect(g.inserted[0]).toMatchObject({ severity: "unknown", age_band: "age_unknown", language: "en", case_count: 1, symptom_codes: [] });
  });

  it("accepts a clinician facility aggregate", async () => {
    const r = await svc(g.gateway).submitHealthReport({ ...valid(), sourceType: "health_facility", reportType: "aggregate_count", caseCount: 12 });
    expect(r.status).toBe("accepted");
    expect(g.inserted[0]).toMatchObject({ report_type: "aggregate_count", case_count: 12 });
  });

  it("keeps a caller-supplied idempotency key", async () => {
    await svc(g.gateway).submitHealthReport({ ...valid(), clientSubmissionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    expect(g.inserted[0].client_submission_id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });
});

describe("authentication", () => {
  it("rejects unauthenticated submissions before doing any other work", async () => {
    const { gateway, inserted } = makeGateway({ userId: null });
    const r = await svc(gateway).submitHealthReport(valid());
    expect(r).toMatchObject({ status: "rejected", error: { code: "UNAUTHENTICATED" } });
    expect(gateway.getRegion).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });
});

describe("region validation", () => {
  it("rejects an unknown region", async () => {
    const r = await svc(g.gateway).submitHealthReport({ ...valid(), regionId: MISSING });
    expect(r).toMatchObject({ status: "rejected", error: { code: "REGION_NOT_FOUND" } });
    expect(g.inserted).toHaveLength(0);
  });
  it("rejects an inactive region", async () => {
    expect(await svc(g.gateway).submitHealthReport({ ...valid(), regionId: INACTIVE })).toMatchObject({ error: { code: "REGION_INACTIVE" } });
  });
  it("rejects regions coarser than a block (district, state)", async () => {
    for (const id of [DISTRICT, STATE]) {
      expect(await svc(g.gateway).submitHealthReport({ ...valid(), regionId: id })).toMatchObject({ error: { code: "REGION_LEVEL_INVALID" } });
    }
    expect(g.inserted).toHaveLength(0);
  });
  it("rejects a malformed region id as a validation failure", async () => {
    const r = await svc(g.gateway).submitHealthReport({ ...valid(), regionId: "not-a-uuid" });
    expect(r).toMatchObject({ status: "rejected", error: { code: "VALIDATION_FAILED" } });
  });
});

describe("controlled vocabularies and lifecycle fields", () => {
  const issuesOf = (r: Awaited<ReturnType<ReturnType<typeof svc>["submitHealthReport"]>>) => (r.status === "rejected" ? r.error.issues ?? [] : []);

  it("rejects an invalid severity", async () => {
    const r = await svc(g.gateway).submitHealthReport({ ...valid(), severity: "extreme" });
    expect(r).toMatchObject({ status: "rejected", error: { code: "VALIDATION_FAILED" } });
    expect(issuesOf(r).map((i) => i.path)).toContain("severity");
  });
  it("rejects invalid syndrome, source, age band, language and symptom codes", async () => {
    for (const patch of [{ syndrome: "plague" }, { sourceType: "imported_dataset" }, { sourceType: "system_generated" }, { ageBand: "age_100" }, { language: "fr" }, { symptomCodes: ["made_up"] }]) {
      const r = await svc(g.gateway).submitHealthReport({ ...valid(), ...patch });
      expect(r.status, JSON.stringify(patch)).toBe("rejected");
    }
    expect(g.inserted).toHaveLength(0);
  });
  it("rejects a client-supplied processing status (and other system-controlled fields)", async () => {
    for (const patch of [
      { processingStatus: "deidentified" }, { processing_status: "validated" }, { privacyLevel: "aggregated" },
      { submittedBy: "someone-else" }, { syntheticBatch: "x" }, { status: "verified" },
    ]) {
      const r = await svc(g.gateway).submitHealthReport({ ...valid(), ...patch });
      expect(r, JSON.stringify(patch)).toMatchObject({ status: "rejected", error: { code: "PRIVACY_VIOLATION" } });
      expect(issuesOf(r)[0].code).toBe("forbidden_field");
    }
    expect(g.inserted).toHaveLength(0);
  });
  it("rejects exact location and direct identifiers", async () => {
    for (const patch of [{ latitude: 20.2 }, { lng: 85.8 }, { gps: "20.2,85.8" }, { address: "x" }, { phone: "9876543210" }, { email: "a@b.org" }, { aadhaar: "1234" }, { dob: "1990-01-01" }, { name: "A" }]) {
      const r = await svc(g.gateway).submitHealthReport({ ...valid(), ...patch });
      expect(r, JSON.stringify(patch)).toMatchObject({ status: "rejected", error: { code: "PRIVACY_VIOLATION" } });
    }
  });
  it("rejects unknown fields", async () => {
    const r = await svc(g.gateway).submitHealthReport({ ...valid(), foo: 1 });
    expect(r).toMatchObject({ status: "rejected", error: { code: "VALIDATION_FAILED" } });
    expect(issuesOf(r)[0].code).toBe("unknown_field");
  });
  it("rejects non-object input", async () => {
    for (const bad of [null, undefined, "x", 3, []]) {
      expect(await svc(g.gateway).submitHealthReport(bad)).toMatchObject({ status: "rejected", error: { code: "VALIDATION_FAILED" } });
    }
  });
  it("enforces case-count and report-type rules", async () => {
    expect(await svc(g.gateway).submitHealthReport({ ...valid(), caseCount: 3 })).toMatchObject({ status: "rejected" });
    expect(await svc(g.gateway).submitHealthReport({ ...valid(), reportType: "aggregate_count", caseCount: 3 })).toMatchObject({ status: "rejected" }); // citizen
    expect(await svc(g.gateway).submitHealthReport({ ...valid(), sourceType: "clinician", reportType: "aggregate_count", caseCount: 0 })).toMatchObject({ status: "rejected" });
    expect(await svc(g.gateway).submitHealthReport({ ...valid(), caseCount: 1.5 })).toMatchObject({ status: "rejected" });
  });
});

describe("timestamp validation", () => {
  const at = (observedAt: string) => svc(g.gateway).submitHealthReport({ ...valid(), observedAt });

  it("rejects future observations (beyond the small clock-skew allowance)", async () => {
    const r = await at("2026-09-01T10:30:00Z");
    expect(r).toMatchObject({ status: "rejected", error: { code: "VALIDATION_FAILED", issues: [{ code: "timestamp_in_future" }] } });
    expect((await at("2026-09-01T10:04:00Z")).status).toBe("accepted"); // within 5 min skew
  });
  it("rejects live observations older than 90 days", async () => {
    expect(await at("2026-05-01T00:00:00Z")).toMatchObject({ error: { issues: [{ code: "timestamp_too_old" }] } });
    expect((await at("2026-06-10T00:00:00Z")).status).toBe("accepted");
  });
  it("rejects ambiguous or malformed timestamps", async () => {
    for (const bad of ["2026-08-31", "2026-08-31T08:30:00", "yesterday", "", "2026-13-45T00:00:00Z", "2026-02-30T00:00:00Z"]) {
      expect((await at(bad)).status, bad).toBe("rejected");
    }
    expect(g.inserted.filter((r) => r.observed_at.startsWith("2026-02"))).toHaveLength(0);
  });
});

describe("privacy sanitisation of free text", () => {
  it("redacts phone-like numbers, e-mail addresses and links, and reports how many", async () => {
    const r = await svc(g.gateway).submitHealthReport({ ...valid(), freeText: "Call 98765 43210 or mail raju@example.org, see https://x.example/p?id=7 — loose stools" });
    expect(r).toMatchObject({ status: "accepted", redactions: 3 });
    const text = g.inserted[0].free_text!;
    expect(text).toBe("Call [number removed] or mail [email removed], see [link removed] — loose stools");
    expect(/\d{5}/.test(text)).toBe(false);
  });

  it("catches phone numbers written in Devanagari and Odia numerals", () => {
    const hi = sanitizeFreeText("फोन ९८७६५४३२१०");
    expect(hi.text).toBe("फोन [number removed]");
    const or = sanitizeFreeText("ଫୋନ ୯୮୭୬୫୪୩୨୧୦");
    expect(or.text).toBe("ଫୋନ [number removed]");
    expect(or.redactions).toBe(1);
  });

  it("strips control/zero-width characters, collapses whitespace and returns null for empty text", () => {
    expect(sanitizeFreeText("  a\u0000b​c \n\n d ").text).toBe("a b c d");
    expect(sanitizeFreeText("   ").text).toBeNull();
    expect(sanitizeFreeText(null).text).toBeNull();
    expect(sanitizeFreeText(undefined).redactions).toBe(0);
  });

  it("leaves ordinary clinical wording and short numbers alone", () => {
    expect(sanitizeFreeText("3 days of loose stools, 12 times").text).toBe("3 days of loose stools, 12 times");
  });

  it("rejects text that is still too long after sanitisation", async () => {
    const r = await svc(g.gateway).submitHealthReport({ ...valid(), freeText: "x".repeat(600) });
    expect(r).toMatchObject({ status: "rejected", error: { issues: [{ path: "freeText", code: "too_long" }] } });
    expect((await svc(g.gateway).submitHealthReport({ ...valid(), freeText: "y".repeat(1200) })).status).toBe("rejected");
  });
});

describe("persistence outcomes", () => {
  it("treats a repeated idempotency key as a duplicate and returns the original report id", async () => {
    const { gateway } = makeGateway({ insert: async () => ({ error: { code: "23505", message: "duplicate key" } }), existing: "report-orig" });
    const r = await svc(gateway).submitHealthReport({ ...valid(), clientSubmissionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    expect(r).toEqual({ status: "duplicate", reportId: "report-orig", clientSubmissionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  });

  it("does not claim a duplicate it cannot find", async () => {
    const { gateway } = makeGateway({ insert: async () => ({ error: { code: "23505", message: "dup" } }), existing: null });
    expect(await svc(gateway).submitHealthReport(valid())).toMatchObject({ status: "rejected", error: { code: "PERSISTENCE_FAILED" } });
  });

  it("maps database rule violations to explicit error codes", async () => {
    const cases: Array<[string, string, string]> = [
      ["42501", "FORBIDDEN", "new row violates row-level security policy"],
      ["JS001", "REGION_NOT_FOUND", "region_not_found"],
      ["JS002", "REGION_INACTIVE", "region_inactive"],
      ["JS003", "REGION_LEVEL_INVALID", "region_level_invalid"],
      ["JS004", "VALIDATION_FAILED", "symptom_code_invalid: x"],
      ["JS005", "VALIDATION_FAILED", "observed_at_in_future"],
      ["23514", "PRIVACY_VIOLATION", 'violates check constraint "health_reports_free_text_no_pii"'],
      ["23514", "VALIDATION_FAILED", 'violates check constraint "health_reports_case_count_chk"'],
      ["22P02", "VALIDATION_FAILED", "invalid input value for enum"],
      ["XX000", "PERSISTENCE_FAILED", "boom"],
    ];
    for (const [sqlstate, expected, message] of cases) {
      const { gateway } = makeGateway({ insert: async () => ({ error: { code: sqlstate, message } }) });
      expect(await svc(gateway).submitHealthReport(valid()), sqlstate + message).toMatchObject({ status: "rejected", error: { code: expected } });
    }
  });

  it("an unauthorised role combination (e.g. citizen posing as clinician) surfaces as FORBIDDEN", async () => {
    const { gateway } = makeGateway({ insert: async () => ({ error: { code: "42501", message: "rls" } }) });
    expect(await svc(gateway).submitHealthReport({ ...valid(), sourceType: "clinician" })).toMatchObject({ status: "rejected", error: { code: "FORBIDDEN" } });
  });

  it("never leaks raw database messages for unexpected failures", async () => {
    const { gateway } = makeGateway({ insert: async () => ({ error: { code: "XX000", message: "secret internal detail" } }) });
    const r = await svc(gateway).submitHealthReport(valid());
    expect(JSON.stringify(r)).not.toContain("secret internal detail");
  });
});
