// DEV ONLY. Creates one user per role in YOUR dev Supabase project.
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local / the environment.
// The service-role key must never be exposed to the browser (no VITE_ prefix) and this file
// is never imported by the client bundle.
//
// Usage: npm run seed:dev
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnvFile(".env.local");
loadEnvFile(".env");

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local (never commit them).");
  process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const accounts = [
  { email: "citizen@jansanket.test", name: "Demo Citizen", role: "citizen" },
  { email: "clinician@jansanket.test", name: "Demo Clinician", role: "clinician" },
  { email: "officer@jansanket.test", name: "Demo Officer", role: "officer" },
  { email: "admin@jansanket.test", name: "Demo Admin", role: "admin" },
] as const;

async function main() {
  for (const acct of accounts) {
    const password = randomBytes(12).toString("base64url");
    const { data, error } = await admin.auth.admin.createUser({
      email: acct.email,
      password,
      email_confirm: true,
      user_metadata: { display_name: acct.name },
    });
    if (error) {
      console.error(`${acct.email}: ${error.message}`);
      continue;
    }
    // A DB trigger already created the profile + citizen role. Grant the extra role here
    // (service role bypasses RLS; this is the bootstrap path for the first admin).
    if (acct.role !== "citizen") {
      const { error: roleError } = await admin.from("user_roles").insert({ user_id: data.user.id, role: acct.role });
      if (roleError) {
        console.error(`${acct.email}: role grant failed: ${roleError.message}`);
        continue;
      }
    }
    console.log(`${acct.role.padEnd(9)} ${acct.email}  password: ${password}`);
  }
  console.log("\nPasswords are shown once. Store them in a password manager; do not commit them.");
}

main();
