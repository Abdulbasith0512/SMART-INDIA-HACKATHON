// Build the canonical evidence bundle for ONE stored signal (service role). Read-only unless --persist is given.
//   npm run evidence:bundle -- --signal=<signal_candidates.id> [--synthetic] [--as-of=YYYY-MM-DD] [--top-k=5] [--json] [--fallback] [--persist]
// The bundle is DATA for a human verifier: it never says a signal is real, names a disease, or advises treatment. The rank
// score inside it is presentation priority for a verifier, NOT the probability that an evidence item is correct.
// --persist stores the bundle, its provenance run, its citation rows, the extractive fallback and the signal_evidence
// mirror (append-only, idempotent: running it again for an unchanged signal writes nothing new). It needs an ACTIVE corpus
// snapshot (`npm run evidence:ingest -- --activate`).
import { canonicalBundleJson } from "../src/evidence/bundle/canonical";
import { renderExtractive } from "../src/evidence/bundle/fallback";
import { buildBundleForSignal, bundleSignal } from "../src/evidence/bundle/pipeline";
import { loadCitationMetadata } from "../src/evidence/bundle/persist";
import { makeRankingConfig } from "../src/evidence/ranking/policy";
import { makeRetrievalConfig } from "../src/evidence/retrieval/config";
import { supabaseEvidenceDb } from "./lib/evidence-db";
import { arg, flag, serviceClient } from "./lib/evidence-cli";

const signal = arg("signal");
if (!signal) {
  console.error("usage: npm run evidence:bundle -- --signal=<id> [--synthetic] [--as-of=YYYY-MM-DD] [--top-k=5] [--json] [--fallback] [--persist]");
  process.exit(2);
}
const db = supabaseEvidenceDb(serviceClient());
const retrieval = makeRetrievalConfig({ allowSynthetic: flag("synthetic") });
const ranking = makeRankingConfig({ topK: arg("top-k") ? Number(arg("top-k")) : undefined });
const options = { asOfDate: arg("as-of") };

let bundle;
let stored = "";
try {
  if (flag("persist")) {
    const out = await bundleSignal(db, signal, retrieval, ranking, options);
    bundle = out?.bundle ?? null;
    if (out) {
      const p = out.persisted;
      stored = `stored: bundle ${p.bundleId} (${p.created ? "created" : "already existed, nothing new written"}); ${p.items} citation row(s); fallback ${p.explanationId}${p.explanationCreated ? " (created)" : ""}; signal_evidence +${p.mirror.inserted} ~${p.mirror.updated} -${p.mirror.deleted}`;
    }
  } else {
    bundle = await buildBundleForSignal(db, signal, retrieval, ranking, options);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
if (!bundle) {
  console.error(`signal ${signal} not found`);
  process.exit(1);
}

if (flag("json")) {
  console.log(JSON.stringify(bundle, null, 2));
} else {
  const b = bundle;
  console.log(`${b.notice}\n`);
  console.log(`bundle ${b.schema_version}  hash ${b.bundle_hash}`);
  console.log(`signal ${b.signal.candidate_id}  ${b.signal.syndrome} @ ${b.signal.region.name}  ${b.signal.window.start} .. ${b.signal.window.end}  detector ${b.signal.detector_version ?? "-"}`);
  console.log(`corpus snapshot ${b.corpus.snapshot_id ?? "(none: not storable)"}  corpus ${b.corpus.corpus_hash?.slice(0, 12) ?? "-"}  retrieval ${b.config.retrieval_config_hash.slice(0, 12)}  ranking ${b.config.ranking_config_hash.slice(0, 12)}  as-of ${b.config.as_of_date}`);
  const meta = await loadCitationMetadata(db, b.citations.map((c) => c.evidence_version_id));
  for (const f of b.facets) {
    console.log(`\n${f.name}: ${f.items.length} item(s)`);
    for (const i of f.items) {
      const m = meta.get(i.evidence_version_id);
      console.log(`  [${i.citation_id}] #${i.rank} ${i.tier.label}, ${i.geo_level} scope${m ? `  ${m.title} - ${m.publisher}` : ""}`);
      for (const why of i.why_relevant) console.log(`        - ${why}`);
    }
  }
  if (b.historical_context.length) {
    console.log("\nhistorical context (separate section, not current evidence):");
    for (const h of b.historical_context) console.log(`  [${h.citation_id}] ${h.canonical_id} [${h.relation.status}] superseded by ${h.relation.superseded_by.join(", ") || "-"}`);
  }
  console.log(`\nconflicts (curator tags only): ${b.conflicts.length ? b.conflicts.map((c) => `${c.question_key} (${c.positions.map((p) => p.position).join(" vs ")})`).join("; ") : "none"}`);
  console.log(`gaps: ${b.gaps.length ? "\n  - " + b.gaps.map((g) => g.message).join("\n  - ") : "none"}`);
  console.log(`excluded: ${b.excluded.length} (${JSON.stringify(b.stats.exclusions_by_reason)})`);
  console.log(`stats: ${JSON.stringify({ ...b.stats, exclusions_by_reason: undefined })}`);
  if (stored) console.log(`\n${stored}`);
}
if (flag("fallback")) {
  const meta = await loadCitationMetadata(db, bundle.citations.map((c) => c.evidence_version_id));
  console.log(`\n--- deterministic extractive fallback (no model) ---\n${renderExtractive(bundle, (id) => meta.get(id)).fallback.text}`);
}
if (flag("canonical")) console.log(`\n${canonicalBundleJson(bundle)}`);
