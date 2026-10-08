// Read-only ranking for ONE stored signal (service role). Shows the presentation ranking and how it was made.
//   npm run evidence:rank -- --signal=<signal_candidates.id> [--synthetic] [--as-of=YYYY-MM-DD] [--top-k=5] [--json]
// The rank score is presentation priority for a verifier, NOT the probability that an evidence item is correct, not
// an outbreak probability and not a diagnosis. Writes nothing.
import { makeRetrievalConfig } from "../src/evidence/retrieval/config";
import { rankForSignal } from "../src/evidence/ranking/pipeline";
import { makeRankingConfig } from "../src/evidence/ranking/policy";
import { supabaseEvidenceDb } from "./lib/evidence-db";
import { arg, flag, serviceClient } from "./lib/evidence-cli";

const signal = arg("signal");
if (!signal) {
  console.error("usage: npm run evidence:rank -- --signal=<id> [--synthetic] [--as-of=YYYY-MM-DD] [--top-k=5] [--json]");
  process.exit(2);
}
const result = await rankForSignal(
  supabaseEvidenceDb(serviceClient()), signal, makeRetrievalConfig({ allowSynthetic: flag("synthetic") }),
  makeRankingConfig({ topK: arg("top-k") ? Number(arg("top-k")) : undefined }), { asOfDate: arg("as-of") },
);
if (!result) {
  console.error(`signal ${signal} not found`);
  process.exit(1);
}
if (flag("json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`${result.notice}\n`);
  console.log(`ranking ${result.ranking.version} ${result.ranking.configHash.slice(0, 12)}  retrieval ${result.retrieval.resultHash.slice(0, 12)}  result ${result.rankingHash.slice(0, 12)}  as-of ${result.asOfDate}`);
  for (const f of result.facets) {
    console.log(`\n${f.facet}: ${f.selected.length} selected (retrieved ${f.stats.retrieved}, after floor ${f.stats.afterFloor}, after dedup ${f.stats.afterDedup})`);
    for (const c of f.selected) {
      const s = c.scoreComponents;
      console.log(`  #${c.rank} ${s.rankScore.toFixed(4)} = rel ${s.relevance.value.toFixed(3)} x class ${s.classFactor.value} x geo ${s.geoFactor.value} x time ${s.temporalFactor.value}   ${c.canonicalId ?? c.evidenceItemId} [chunk ${c.chunkOrdinal}] ${c.tierLabel}, ${s.geoFactor.evidenceScope}`);
    }
  }
  if (result.historicalContext.length) {
    console.log("\nhistorical context (separate section):");
    for (const h of result.historicalContext) console.log(`  ${h.facet}: ${h.canonicalId} [${h.relation.status}] superseded by ${h.relation.supersededBy.join(", ") || "-"}`);
  }
  console.log(`\nconflicts: ${result.conflicts.length ? result.conflicts.map((c) => `${c.questionKey} (${c.positions.map((p) => p.position).join(" vs ")})`).join("; ") : "none (curator tags only)"}`);
  console.log(`gaps: ${result.gaps.length ? "\n  - " + result.gaps.map((g) => g.message).join("\n  - ") : "none"}`);
  console.log(`exclusions: ${JSON.stringify(result.exclusions.counts)}`);
}
