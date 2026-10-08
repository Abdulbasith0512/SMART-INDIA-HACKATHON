// Read-only retrieval for ONE stored signal (service role). Shows the controlled query and the candidates; writes nothing.
//   npm run evidence:retrieve -- --signal=<signal_candidates.id> [--synthetic] [--as-of=YYYY-MM-DD] [--top=5] [--json]
// `--synthetic` opts in to the explicitly synthetic development corpus (the production configuration excludes it).
// Candidates are lexical-match results (BM25) inside each facet's eligible pool, NOT a ranking of trustworthiness
// and NOT evidence that anything is true. Ranking factors, bundles and summaries are later milestones.
import { makeRetrievalConfig, retrievalConfigHash } from "../src/evidence/retrieval/config";
import { retrieveForSignal } from "../src/evidence/retrieval/retrieve";
import { supabaseEvidenceDb } from "./lib/evidence-db";
import { arg, flag, serviceClient } from "./lib/evidence-cli";

const signal = arg("signal");
if (!signal) {
  console.error("usage: npm run evidence:retrieve -- --signal=<id> [--synthetic] [--as-of=YYYY-MM-DD] [--top=5] [--json]");
  process.exit(2);
}
const cfg = makeRetrievalConfig({ allowSynthetic: flag("synthetic") });
const result = await retrieveForSignal(supabaseEvidenceDb(serviceClient()), signal, cfg, { asOfDate: arg("as-of") });
if (!result) {
  console.error(`signal ${signal} not found`);
  process.exit(1);
}
if (flag("json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const top = Number(arg("top") ?? 5);
  console.log(`config ${result.config.version} ${retrievalConfigHash(cfg).slice(0, 12)}  query ${result.query.hash.slice(0, 12)}  corpus ${result.corpus.digest.slice(0, 12)}  result ${result.resultHash.slice(0, 12)}  as-of ${result.asOfDate}`);
  console.log(`active snapshot: ${result.corpus.activeSnapshot?.corpusVersion ?? "none"}; documents loaded: ${result.corpus.documents}; synthetic allowed: ${cfg.eligibility.allowSynthetic}`);
  for (const f of result.facets) {
    console.log(`\n${f.facet}: ${f.candidates.length} candidate chunks from ${f.stats.documentsEligible}/${f.stats.documentsConsidered} eligible documents`);
    for (const c of f.candidates.slice(0, top)) console.log(`  #${c.rank} ${c.bm25Score.toFixed(4)}  ${c.canonicalId ?? c.evidenceItemId} [chunk ${c.chunkOrdinal}] (${c.metadata.geoMatch}, ${c.metadata.sourceClass})  ${c.matchedTerms.map((m) => m.term).join(",")}`);
  }
}
