// Types come from the live schema: npx supabase gen types typescript --linked --schema public > src/lib/supabase/database.generated.ts
export type { Database, Json } from "./database.generated";
import type { Database } from "./database.generated";

type Enums = Database["public"]["Enums"];

export type AppRole = Enums["app_role"];
export type SourceType = Enums["source_type"];
export type ReportType = Enums["report_type"];
export type ReportSeverity = Enums["report_severity"];
export type AgeBand = Enums["age_band"];
export type SyndromeCategory = Enums["syndrome_category"];
export type ProcessingStatus = Enums["processing_status"];
export type PrivacyLevel = Enums["privacy_level"];
export type RegionType = Enums["region_type"];
export type SignalStatus = Enums["signal_status"];
export type VerificationStatus = Enums["verification_status"];
