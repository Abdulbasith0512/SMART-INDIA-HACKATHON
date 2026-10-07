// Link checker for REAL evidence sources (synthetic documents are skipped).
//   npm run evidence:linkcheck             report only
//   npm run evidence:linkcheck -- --apply  record fetch status and quarantine changed / definitively missing sources
import { applyLinkOutcomes, checkLinks, loadLinkTargets } from "../src/evidence/net/linkcheck";
import { loadAllowlist } from "../src/evidence/ingest/loader";
import { supabaseEvidenceDb } from "./lib/evidence-db";
import { DEFAULT_ALLOWLIST, arg, flag, serviceClient } from "./lib/evidence-cli";

const { allowlist, errors } = loadAllowlist(arg("allowlist") ?? DEFAULT_ALLOWLIST);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
const db = supabaseEvidenceDb(serviceClient());
const targets = await loadLinkTargets(db);
const outcomes = await checkLinks(targets, allowlist);
const quarantined = flag("apply")
  ? await applyLinkOutcomes(db, outcomes, new Date().toISOString(), new Map(targets.map((t) => [t.itemId, t.status])))
  : [];
console.log(JSON.stringify({
  checked: outcomes.length, applied: flag("apply"),
  results: outcomes.map((o) => ({ id: o.canonicalId, result: o.result, action: o.action, detail: o.detail })), quarantined,
}, null, 2));
if (outcomes.some((o) => o.action === "quarantine")) process.exit(1);
