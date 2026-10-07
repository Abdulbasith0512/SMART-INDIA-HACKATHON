// Health-report ingestion service.
//   input -> auth -> validation -> normalisation -> region validation -> privacy validation
//         -> sanitisation -> persistence
// Deterministic infrastructure: no LLM, no network calls other than the injected gateway.
// Individual raw submissions are intentionally NOT written to the audit log (volume, and the log
// must not become a second copy of health data); privileged pipeline operations are audited in SQL.
import type {
  HealthReportInput, HealthReportInsertRow, ReportingGateway, SubmitError, SubmitErrorCode, SubmitResult,
} from "./contracts";
import { validateHealthReportInput } from "./validation";

export interface ReportingServiceDeps {
  now?: () => Date;
  newId?: () => string;
}

const rejected = (code: SubmitErrorCode, message: string, issues?: SubmitError["issues"]): SubmitResult => ({
  status: "rejected",
  error: { code, message, issues },
});

/** Map database/PostgREST errors (SQLSTATE) to explicit, typed outcomes. */
function mapPersistenceError(err: { code?: string; message: string }): { code: SubmitErrorCode; message: string } {
  switch (err.code) {
    case "42501":
      return { code: "FORBIDDEN", message: "You are not permitted to submit this kind of report for this region." };
    case "JS001":
      return { code: "REGION_NOT_FOUND", message: "Region not found." };
    case "JS002":
      return { code: "REGION_INACTIVE", message: "Region is not active." };
    case "JS003":
      return { code: "REGION_LEVEL_INVALID", message: "Reports must reference a block or locality." };
    case "JS004":
    case "JS005":
      return { code: "VALIDATION_FAILED", message: err.message };
    case "23514":
      return /free_text_no_pii/.test(err.message)
        ? { code: "PRIVACY_VIOLATION", message: "Free text appears to contain an identifier." }
        : { code: "VALIDATION_FAILED", message: "A data rule was violated." };
    case "22P02":
      return { code: "VALIDATION_FAILED", message: "A value is not in the allowed vocabulary." };
    default:
      return { code: "PERSISTENCE_FAILED", message: "The report could not be saved." };
  }
}

export function createReportingService(gateway: ReportingGateway, deps: ReportingServiceDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID());

  async function submitHealthReport(input: HealthReportInput | unknown): Promise<SubmitResult> {
    // 1. Authentication
    const userId = await gateway.getCurrentUserId();
    if (!userId) return rejected("UNAUTHENTICATED", "Sign in to submit a report.");

    // 2-3. Validation + normalisation + privacy sanitisation (pure)
    const result = validateHealthReportInput(input, { now: now(), newId });
    if ("issues" in result) {
      const privacy = result.issues.some((i) => i.code === "pii_detected" || i.code === "forbidden_field");
      return rejected(privacy ? "PRIVACY_VIOLATION" : "VALIDATION_FAILED", "The report did not pass validation.", result.issues);
    }
    const report = result.value;

    // 4. Region validation (existence, active, coarse enough)
    const region = await gateway.getRegion(report.regionId);
    if (!region) return rejected("REGION_NOT_FOUND", "Region not found.");
    if (!region.active) return rejected("REGION_INACTIVE", "Region is not active.");
    if (region.region_type !== "block" && region.region_type !== "locality") {
      return rejected("REGION_LEVEL_INVALID", "Reports must reference a block or locality, not a broader area.");
    }

    // 5. Persistence. System-controlled columns (processing_status, privacy_level, synthetic_batch) are never sent.
    const row: HealthReportInsertRow = {
      client_submission_id: report.clientSubmissionId,
      submitted_by: userId,
      observed_at: report.observedAt,
      source_type: report.sourceType,
      region_id: report.regionId,
      report_type: report.reportType,
      syndrome: report.syndrome,
      symptom_codes: report.symptomCodes,
      severity: report.severity,
      age_band: report.ageBand,
      case_count: report.caseCount,
      language: report.language,
      free_text: report.freeText,
    };

    const saved = await gateway.insertReport(row);
    if ("id" in saved) {
      return {
        status: "accepted",
        reportId: saved.id,
        clientSubmissionId: report.clientSubmissionId,
        processingStatus: "received",
        redactions: result.redactions,
      };
    }

    // Idempotent retry: the same (user, clientSubmissionId) is a duplicate, not an error.
    if (saved.error.code === "23505") {
      const existing = await gateway.findReportId(userId, report.clientSubmissionId);
      if (existing) return { status: "duplicate", reportId: existing, clientSubmissionId: report.clientSubmissionId };
    }
    const mapped = mapPersistenceError(saved.error);
    return rejected(mapped.code, mapped.message);
  }

  return { submitHealthReport };
}

export type ReportingService = ReturnType<typeof createReportingService>;
