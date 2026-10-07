// Offline M4.1 verification (no database, no network): the committed corpus is valid, reproducible from its
// generator, matches its manifest, and every adversarial fixture is quarantined.
//   npm run evidence:verify
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ADVERSARIAL_IDS, buildDevCorpus, renderDoc } from "../src/evidence/devcorpus/specs";
import { buildCorpus } from "../src/evidence/ingest/loader";
import { CORPUS_NAME, DEFAULT_ALLOWLIST, DEFAULT_CORPUS_DIR } from "./lib/evidence-cli";

let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` -- ${detail}`}`);
  if (!ok) failed += 1;
};
const lf = (s: string): string => s.replace(/\r\n/g, "\n");

const built = buildCorpus(DEFAULT_CORPUS_DIR, DEFAULT_ALLOWLIST, CORPUS_NAME);
check("every document file parses and validates", built.fileErrors.length === 0, built.fileErrors.join("; "));
check("corpus-level rules hold (unique ids/URLs, supersession chains)", built.validation.errors.length === 0, built.validation.errors.join("; "));
check("every document is flagged synthetic", built.prepared.every((p) => p.doc.is_synthetic));
check("no real URL or domain in the corpus", built.prepared.every((p) => !p.doc.reference_url || /\.invalid\//.test(p.doc.reference_url)));
const spec = buildDevCorpus();
check("committed documents equal the generator output", spec.every((d) => {
  try {
    return lf(readFileSync(join(DEFAULT_CORPUS_DIR, "docs", `${d.canonical_id}.json`), "utf8")) === renderDoc(d);
  } catch {
    return false;
  }
}) && built.prepared.length === spec.length);
const manifestFile = lf(readFileSync(join(DEFAULT_CORPUS_DIR, "manifest.json"), "utf8"));
check("committed manifest equals the regenerated manifest", manifestFile === JSON.stringify(built.manifest, null, 2) + "\n");
const byId = new Map(built.prepared.map((p) => [p.doc.canonical_id, p]));
check("all adversarial fixtures are quarantined despite being declared current", ADVERSARIAL_IDS.every((id) => byId.get(id)?.decision.status === "quarantined"));
check("no clean document is quarantined by mistake", built.prepared.filter((p) => !ADVERSARIAL_IDS.includes(p.doc.canonical_id as never)).every((p) => p.decision.status !== "quarantined" || p.scan.verdict !== "quarantine"));
check("unverified source is never current", byId.get("syn-unverified-forum-post")?.decision.status === "draft");
console.log(`\ncorpus_hash ${built.manifest.corpus_hash}\n${JSON.stringify(built.manifest.counts)}`);
if (failed) process.exit(1);
