// Runs the frozen statistical detector against the live (dev) Supabase project and persists candidates.
//   npm run detect                    full replay over all deidentified data (idempotent)
//   npm run detect -- --dry-run       compute only, write nothing
//   npm run detect -- --from=YYYY-MM-DD --to=YYYY-MM-DD
// Output is "emerging signal requiring verification" candidates for human review; nothing is auto-verified.
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import { runLiveDetector } from "./lib/detector-runner";

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnvFile(".env.local");
const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.");
  process.exit(2);
}
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];

runLiveDetector(createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }), {
  from: arg("from"), to: arg("to"), dryRun: process.argv.includes("--dry-run"),
})
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch((e) => {
    console.error("detector run failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
