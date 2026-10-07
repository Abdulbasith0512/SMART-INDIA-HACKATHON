import { z } from "zod";
import {
  AGE_BANDS, CLIENT_SOURCE_TYPES, FUTURE_SKEW_MINUTES, LANGUAGES, MAX_AGE_DAYS, MAX_RAW_FREE_TEXT_LENGTH,
  REPORT_TYPES, SEVERITIES, SYMPTOM_CODES, SYNDROMES,
  type HealthReportInput, type NormalizedHealthReport, type ValidationIssue,
} from "./contracts";
import { MAX_FREE_TEXT_LENGTH } from "./contracts";
import { RESIDUAL_PII, sanitizeFreeText } from "./sanitize";

/**
 * Keys a client must never send. System-controlled lifecycle fields, identity fields and exact
 * location / direct identifiers are rejected explicitly (not silently dropped) so callers learn
 * about the rule instead of assuming the data was stored.
 */
const FORBIDDEN_FIELDS = new Set([
  "processingStatus", "processing_status", "privacyLevel", "privacy_level", "submittedBy", "submitted_by",
  "syntheticBatch", "synthetic_batch", "status", "id", "createdAt", "created_at",
  "latitude", "longitude", "lat", "lng", "lon", "gps", "location", "coordinates", "address", "pincode",
  "phone", "mobile", "email", "name", "aadhaar", "aadhar", "dob", "dateOfBirth", "birthDate",
]);

// Strict ISO-8601 date-time that MUST carry an offset (Z or +hh:mm); date-only or zone-less values are ambiguous.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const schema = z
  .object({
    clientSubmissionId: z.string().uuid().optional(),
    observedAt: z.string().regex(ISO_WITH_ZONE, "must be an ISO-8601 date-time with a time-zone offset"),
    sourceType: z.enum(CLIENT_SOURCE_TYPES),
    regionId: z.string().uuid(),
    reportType: z.enum(REPORT_TYPES).default("individual_observation"),
    syndrome: z.enum(SYNDROMES),
    symptomCodes: z.array(z.enum(SYMPTOM_CODES)).max(10).default([]),
    severity: z.enum(SEVERITIES).default("unknown"),
    ageBand: z.enum(AGE_BANDS).default("age_unknown"),
    caseCount: z.number().int().min(1).max(10000).default(1),
    language: z.enum(LANGUAGES).default("en"),
    freeText: z.string().max(MAX_RAW_FREE_TEXT_LENGTH).nullish(),
  })
  .strict();

export type ValidationResult =
  | { ok: true; value: NormalizedHealthReport; redactions: number }
  | { ok: false; issues: ValidationIssue[] };

const issue = (path: string, code: string, message: string): ValidationIssue => ({ path, code, message });

/**
 * input -> validation -> normalisation -> privacy validation/sanitisation.
 * Pure function: `now` and `newId` are injected so it is deterministic under test.
 */
export function validateHealthReportInput(
  raw: unknown,
  opts: { now: Date; newId: () => string },
): ValidationResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, issues: [issue("", "invalid_type", "report must be an object")] };
  }

  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_FIELDS.has(key)) {
      issues.push(issue(key, "forbidden_field", `'${key}' is not accepted: it is system-controlled or would store exact/identifying data`));
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) =>
        issue(i.path.join("."), i.code === "unrecognized_keys" ? "unknown_field" : i.code, i.message)),
    };
  }
  const v = parsed.data;

  // Cross-field rules (mirrored by DB constraints).
  if (v.reportType === "individual_observation" && v.caseCount !== 1) {
    issues.push(issue("caseCount", "invalid_case_count", "an individual observation has exactly one case"));
  }
  if (v.reportType === "aggregate_count" && v.sourceType === "citizen") {
    issues.push(issue("reportType", "invalid_report_type", "citizens cannot submit aggregate counts"));
  }

  // Timestamps (mirrored by the database trigger).
  const observed = new Date(v.observedAt);
  if (Number.isNaN(observed.getTime())) {
    issues.push(issue("observedAt", "invalid_timestamp", "not a valid date-time"));
  } else {
    const latest = opts.now.getTime() + FUTURE_SKEW_MINUTES * 60_000;
    const earliest = opts.now.getTime() - MAX_AGE_DAYS * 86_400_000;
    if (observed.getTime() > latest) issues.push(issue("observedAt", "timestamp_in_future", "an observation cannot be in the future"));
    else if (observed.getTime() < earliest) issues.push(issue("observedAt", "timestamp_too_old", `live reports must be within ${MAX_AGE_DAYS} days`));
  }

  // Privacy: sanitise free text, then re-verify nothing identifying survives.
  const { text, redactions } = sanitizeFreeText(v.freeText);
  if (text !== null && text.length > MAX_FREE_TEXT_LENGTH) {
    issues.push(issue("freeText", "too_long", `free text must be at most ${MAX_FREE_TEXT_LENGTH} characters after sanitisation`));
  }
  if (text !== null && RESIDUAL_PII(text)) {
    issues.push(issue("freeText", "pii_detected", "free text still contains an identifier after sanitisation"));
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    redactions,
    value: {
      clientSubmissionId: v.clientSubmissionId ?? opts.newId(),
      observedAt: observed.toISOString(),
      sourceType: v.sourceType,
      regionId: v.regionId,
      reportType: v.reportType,
      syndrome: v.syndrome,
      symptomCodes: [...new Set(v.symptomCodes)].sort(),
      severity: v.severity,
      ageBand: v.ageBand,
      caseCount: v.caseCount,
      language: v.language,
      freeText: text,
    },
  };
}

export type { HealthReportInput };
