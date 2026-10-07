// Loads the deterministic SYNTHETIC Odisha dataset into YOUR dev Supabase project (service role).
// Idempotent: regions are upserted by deterministic id; synthetic reports are replaced wholesale.
// Never run against a production project: it deletes rows tagged synthetic_batch = 'm2-odisha-v1'.
//
// Usage: npm run seed:synthetic
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import { SYNTHETIC_BATCH, generateSyntheticDataset } from "../src/synthetic/generate";
import { STATE_CODE } from "../src/synthetic/geography";

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnvFile(".env.local");

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.");
  process.exit(2);
}
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

function must<T>(label: string, res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(`${label}: ${res.error.message}`);
  return res.data as T;
}

async function main() {
  const ds = generateSyntheticDataset();
  console.log(`Synthetic dataset: ${ds.geography.regions.length} regions, ${ds.reports.length} reports, ${ds.groundTruth.length} planted events`);

  // 1. Geography, level by level (parents first).
  for (const level of ["country", "state", "district", "block", "locality"] as const) {
    const rows = ds.geography.regions.filter((r) => r.region_type === level);
    must(`upsert ${level}`, await db.from("regions").upsert(rows, { onConflict: "id" }));
  }
  console.log("  regions upserted");

  // 2. Replace previous synthetic data (reports first; derived rows are tagged is_synthetic).
  must("delete synthetic reports", await db.from("health_reports").delete().eq("synthetic_batch", SYNTHETIC_BATCH));
  must("delete synthetic deidentified rows", await db.from("deidentified_observations").delete().eq("is_synthetic", true));

  // 3. Reports in batches (service role; synthetic_batch set so the live-submission age rule does not apply).
  const BATCH = 500;
  for (let i = 0; i < ds.reports.length; i += BATCH) {
    must(`insert reports ${i}`, await db.from("health_reports").insert(ds.reports.slice(i, i + BATCH)));
  }
  console.log("  reports inserted");

  // 4. RAW -> DEIDENTIFIED -> AGGREGATED (deterministic SQL functions, service role only).
  let processed = 0;
  for (;;) {
    const n = must<number>("deidentify", await db.rpc("deidentify_pending_reports", { _limit: 5000 }));
    if (!n) break;
    processed += n;
  }
  const cells = must<number>("aggregate", await db.rpc("refresh_report_aggregates", { _from: ds.startDate, _to: ds.endDate }));
  console.log(`  deidentified ${processed} reports; refreshed ${cells} aggregate cells`);

  // 5. Demo scopes for the dev accounts created by `npm run seed:dev` (skipped if they do not exist).
  const state = ds.geography.byCode.get(STATE_CODE)!;
  const khordha = ds.geography.byCode.get(`${STATE_CODE}-KHO`)!;
  const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  const byEmail = new Map((list?.users ?? []).map((u) => [u.email, u.id]));
  for (const [email, role, region] of [
    ["officer@jansanket.test", "officer", state],
    ["clinician@jansanket.test", "clinician", khordha],
  ] as const) {
    const uid = byEmail.get(email);
    if (!uid) {
      console.log(`  (no ${email}; run npm run seed:dev first to create demo accounts)`);
      continue;
    }
    must(`scope ${email}`, await db.from("user_roles").update({ region_id: region.id }).eq("user_id", uid).eq("role", role));
    console.log(`  scoped ${role} ${email} -> ${region.name}`);
  }

  // 6. Summary
  const count = async (table: string) => {
    const { count: c } = await db.from(table).select("*", { count: "exact", head: true });
    return c ?? 0;
  };
  console.log("Totals:", {
    regions: await count("regions"),
    health_reports: await count("health_reports"),
    deidentified_observations: await count("deidentified_observations"),
    report_aggregates: await count("report_aggregates"),
  });
}

main().catch((e) => {
  console.error("seed:synthetic failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
