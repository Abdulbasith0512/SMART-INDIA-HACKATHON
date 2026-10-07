// Ingest the evidence corpus into Supabase (service role). Curator-run; never client-triggered.
//   npm run evidence:ingest -- --dry-run          show what would change, write nothing
//   npm run evidence:ingest                       apply (idempotent); records a corpus snapshot when the DB matches the manifest
//   npm run evidence:ingest -- --activate         also mark that snapshot active
//   npm run evidence:ingest -- --release          curator override: allow raising trust / releasing quarantined items
// Documents the scanner or trust rules flag are stored as `quarantined` / `draft` and reported; nothing is deleted.
import { ingestCorpus } from "../src/evidence/ingest/ingest";
import { supabaseEvidenceDb } from "./lib/evidence-db";
import { CORPUS_NAME, arg, flag, loadCorpusOrExit, serviceClient } from "./lib/evidence-cli";

const { prepared, manifest } = loadCorpusOrExit();
const report = await ingestCorpus(supabaseEvidenceDb(serviceClient()), prepared, {
  dryRun: flag("dry-run"), activate: flag("activate"), allowRelease: flag("release"), corpusName: arg("name") ?? CORPUS_NAME,
  notes: arg("notes") ?? "ingested via evidence:ingest",
});

const summary: Record<string, number> = {};
for (const d of report.documents) for (const a of d.actions) summary[a.split(":")[0]] = (summary[a.split(":")[0]] ?? 0) + 1;
console.log(JSON.stringify({
  ok: report.ok, dryRun: report.dryRun, corpus_hash: report.corpusHash, counts: manifest.counts, action_summary: summary,
  snapshot: report.snapshot, errors: report.errors,
  quarantined: report.documents.filter((d) => d.status === "quarantined").map((d) => d.canonical_id),
}, null, 2));
if (!report.ok) process.exit(1);
