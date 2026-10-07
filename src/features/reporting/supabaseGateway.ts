import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { HealthReportInsertRow, RegionInfo, ReportingGateway } from "./contracts";

/** Supabase adapter for the ingestion service. Authorisation is enforced by RLS, not by this code. */
export function createSupabaseReportingGateway(client: SupabaseClient<Database>): ReportingGateway {
  return {
    async getCurrentUserId() {
      const { data } = await client.auth.getSession();
      return data.session?.user.id ?? null;
    },

    async getRegion(regionId) {
      const { data, error } = await client
        .from("regions")
        .select("id, region_type, active")
        .eq("id", regionId)
        .maybeSingle();
      if (error || !data) return null;
      return data as RegionInfo;
    },

    async insertReport(row: HealthReportInsertRow) {
      const { data, error } = await client.from("health_reports").insert(row).select("id").single();
      if (error) return { error: { code: error.code, message: error.message } };
      return { id: data.id };
    },

    async findReportId(userId, clientSubmissionId) {
      const { data } = await client
        .from("health_reports")
        .select("id")
        .eq("submitted_by", userId)
        .eq("client_submission_id", clientSubmissionId)
        .maybeSingle();
      return data?.id ?? null;
    },
  };
}
