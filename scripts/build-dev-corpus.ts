// Renders the synthetic development corpus (src/evidence/devcorpus/specs.ts) to data/evidence/corpus and writes
// the deterministic manifest.
//   npm run evidence:build            write docs/*.json and manifest.json
//   npm run evidence:build -- --check fail (exit 1) if the committed files differ from the generator
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDevCorpus, renderDoc } from "../src/evidence/devcorpus/specs";
import { buildCorpus } from "../src/evidence/ingest/loader";
import { CORPUS_NAME, DEFAULT_ALLOWLIST, DEFAULT_CORPUS_DIR, arg, flag } from "./lib/evidence-cli";

// Git on Windows may check files out with CRLF; compare line-ending-insensitively.
const lf = (s: string): string => s.replace(/\r\n/g, "\n");
const dir = arg("dir") ?? DEFAULT_CORPUS_DIR;
const docsDir = join(dir, "docs");
const check = flag("check");
const wanted = new Map(buildDevCorpus().map((d) => [`${d.canonical_id}.json`, renderDoc(d)]));
const drift: string[] = [];

if (!existsSync(docsDir)) {
  if (check) drift.push("docs directory missing");
  else mkdirSync(docsDir, { recursive: true });
}
const present = existsSync(docsDir) ? readdirSync(docsDir).filter((f) => f.endsWith(".json")) : [];
for (const f of present) {
  if (wanted.has(f)) continue;
  if (check) drift.push(`unexpected file ${f}`);
  else rmSync(join(docsDir, f));
}
for (const [f, text] of wanted) {
  const p = join(docsDir, f);
  const have = existsSync(p) ? lf(readFileSync(p, "utf8")) : null;
  if (have === text) continue;
  if (check) drift.push(`${f} differs from the generator`);
  else writeFileSync(p, text, "utf8");
}

const built = buildCorpus(dir, DEFAULT_ALLOWLIST, CORPUS_NAME);
const problems = [...built.fileErrors, ...built.validation.errors];
const manifestText = JSON.stringify(built.manifest, null, 2) + "\n";
const manifestPath = join(dir, "manifest.json");
if (check) {
  if (!existsSync(manifestPath) || lf(readFileSync(manifestPath, "utf8")) !== manifestText) drift.push("manifest.json differs from the regenerated manifest");
} else if (!problems.length) writeFileSync(manifestPath, manifestText, "utf8");

console.log(JSON.stringify({ corpus_hash: built.manifest.corpus_hash, counts: built.manifest.counts, problems, drift }, null, 2));
if (problems.length || drift.length) process.exit(1);
