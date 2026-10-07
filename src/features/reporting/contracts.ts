// Typed contracts for health-report ingestion.
// A health report is an OBSERVATION submitted by a person or trusted source. It is not a diagnosis
// and not a medical record: coarse region, age band and controlled vocabularies only.
import type {
  AgeBand, ReportSeverity, ReportType, SyndromeCategory,
} from "@/lib/supabase/database.types";

/** Source types that a signed-in client may submit as. Other source types are service-side only. */
export const CLIENT_SOURCE_TYPES = ["citizen", "clinician", "health_facility", "public_health_officer"] as const;
export type ClientSourceType = (typeof CLIENT_SOURCE_TYPES)[number];

export const REPORT_TYPES = ["individual_observation", "aggregate_count"] as const satisfies readonly ReportType[];
export const SEVERITIES = ["unknown", "mild", "moderate", "severe"] as const satisfies readonly ReportSeverity[];
export const AGE_BANDS = ["age_0_4", "age_5_17", "age_18_44", "age_45_59", "age_60_plus", "age_unknown"] as const satisfies readonly AgeBand[];
export const SYNDROMES = [
  "acute_diarrhoeal_illness", "fever", "fever_with_rash", "jaundice", "respiratory_illness", "other", "unknown",
] as const satisfies readonly SyndromeCategory[];
export const LANGUAGES = ["en", "hi", "or"] as const;
export type ReportLanguage = (typeof LANGUAGES)[number];

/** Mirrors the symptom_terms vocabulary (the database validates codes again). */
export const SYMPTOM_CODES = [
  "diarrhoea", "vomiting", "dehydration_signs", "abdominal_pain", "fever", "headache", "body_ache",
  "rash", "jaundice", "dark_urine", "cough", "breathlessness",
] as const;
export type SymptomCode = (typeof SYMPTOM_CODES)[number];

export const MAX_FREE_TEXT_LENGTH = 500;
export const MAX_RAW_FREE_TEXT_LENGTH = 1000;
export const MAX_AGE_DAYS = 90;
export const FUTURE_SKEW_MINUTES = 5;

/** What a caller supplies. Unknown keys are rejected (see validation.ts). */
export interface HealthReportInput {
  clientSubmissionId?: string;
  observedAt: string;
  sourceType: ClientSourceType;
  regionId: string;
  reportType?: ReportType;
  syndrome: SyndromeCategory;
  symptomCodes?: SymptomCode[];
  severity?: ReportSeverity;
  ageBand?: AgeBand;
  caseCount?: number;
  language?: ReportLanguage;
  freeText?: string | null;
}

/** Validated + normalised report, ready to persist. */
export interface NormalizedHealthReport {
  clientSubmissionId: string;
  observedAt: string; // ISO-8601 UTC
  sourceType: ClientSourceType;
  regionId: string;
  reportType: ReportType;
  syndrome: SyndromeCategory;
  symptomCodes: SymptomCode[];
  severity: ReportSeverity;
  ageBand: AgeBand;
  caseCount: number;
  language: ReportLanguage;
  freeText: string | null;
}

/** Row shape written to public.health_reports. System-controlled columns are deliberately absent. */
export interface HealthReportInsertRow {
  client_submission_id: string;
  submitted_by: string;
  observed_at: string;
  source_type: ClientSourceType;
  region_id: string;
  report_type: ReportType;
  syndrome: SyndromeCategory;
  symptom_codes: string[];
  severity: ReportSeverity;
  age_band: AgeBand;
  case_count: number;
  language: ReportLanguage;
  free_text: string | null;
}

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export type SubmitErrorCode =
  | "UNAUTHENTICATED"
  | "VALIDATION_FAILED"
  | "REGION_NOT_FOUND"
  | "REGION_INACTIVE"
  | "REGION_LEVEL_INVALID"
  | "PRIVACY_VIOLATION"
  | "FORBIDDEN"
  | "PERSISTENCE_FAILED";

export interface SubmitError {
  code: SubmitErrorCode;
  message: string;
  issues?: ValidationIssue[];
}

export type SubmitResult =
  | {
      status: "accepted";
      reportId: string;
      clientSubmissionId: string;
      processingStatus: "received";
      /** Number of free-text fragments removed (phone-like numbers, e-mails, links). */
      redactions: number;
    }
  | { status: "duplicate"; reportId: string; clientSubmissionId: string }
  | { status: "rejected"; error: SubmitError };

export interface RegionInfo {
  id: string;
  region_type: "country" | "state" | "district" | "block" | "locality";
  active: boolean;
}

/** Persistence port. Implemented over Supabase in supabaseGateway.ts; faked in tests. */
export interface ReportingGateway {
  getCurrentUserId(): Promise<string | null>;
  getRegion(regionId: string): Promise<RegionInfo | null>;
  insertReport(row: HealthReportInsertRow): Promise<{ id: string } | { error: { code?: string; message: string } }>;
  findReportId(userId: string, clientSubmissionId: string): Promise<string | null>;
}
