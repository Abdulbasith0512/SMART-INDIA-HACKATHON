// Shared plumbing for the evidence CLIs: .env.local loading, the service-role client, argument helpers.
// Secrets come only from .env.local / the process environment; nothing here is browser-reachable.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import { buildCorpus } from "../../src/evidence/ingest/loader";

export const DEFAULT_CORPUS_DIR = "data/evidence/corpus";
export const DEFAULT_ALLOWLIST = "data/evidence/allowlist.json";
export const CORPUS_NAME = "jansanket-dev-corpus";

export function loadEnvFile(path = ".env.local"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export function serviceClient(): SupabaseClient {
  loadEnvFile();
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.");
    process.exit(2);
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export const arg = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
export const flag = (name: string): boolean => process.argv.includes(`--${name}`);

/** Load and validate the corpus directory; exits non-zero with every problem listed if anything is wrong. */
export function loadCorpusOrExit() {
  const dir = arg("dir") ?? DEFAULT_CORPUS_DIR;
  const built = buildCorpus(dir, arg("allowlist") ?? DEFAULT_ALLOWLIST, arg("name") ?? CORPUS_NAME);
  const problems = [...built.fileErrors, ...built.validation.errors];
  if (problems.length) {
    console.error(`Corpus has ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  for (const w of built.validation.warnings) console.warn(`warning: ${w}`);
  return { ...built, dir };
}
