// Mutation tests for the critical M4.4 invariants (canonical hashing, citation ids, verbatim excerpts, exclusion / conflict /
// gap persistence, idempotency, mirror, fallback safety). Each mutant deliberately breaks ONE rule in the real source, runs
// the bundle unit tests and the bundle database tests, and must be KILLED (a test fails). A surviving mutant means a rule has
// no test that would notice it breaking. The original file is restored after every mutant, even on Ctrl-C.
//
//   npm run test:mutation:m44            all mutants
//   npm run test:mutation:m44 -- id,id   only the named mutants
//
// Run it on a clean working tree and do not edit the files while it runs.
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

interface Mutant {
  id: string;
  rule: string;
  file: string;
  find: string;
  replace: string;
}
const B = "src/evidence/bundle";
const MUTANTS: Mutant[] = [
  // ---- canonical serialisation and hashing ----
  { id: "hash-keeps-retrieved-at", rule: "retrieved_at is excluded from the hash", file: `${B}/canonical.ts`, find: 'export const HASH_EXCLUDED_FIELDS = ["bundle_hash", "retrieved_at"] as const;', replace: 'export const HASH_EXCLUDED_FIELDS = ["bundle_hash"] as const;' },
  { id: "hash-keeps-bundle-hash", rule: "bundle_hash is excluded from its own hash", file: `${B}/canonical.ts`, find: 'export const HASH_EXCLUDED_FIELDS = ["bundle_hash", "retrieved_at"] as const;', replace: 'export const HASH_EXCLUDED_FIELDS = ["retrieved_at"] as const;' },
  { id: "hash-exclusion-applied", rule: "excluded fields are actually dropped", file: `${B}/canonical.ts`, find: "for (const f of HASH_EXCLUDED_FIELDS) delete body[f];", replace: ";" },
  { id: "hash-input", rule: "bundle_hash is SHA-256 of the canonical JSON", file: `${B}/canonical.ts`, find: "sha256Hex(canonicalBundleJson(bundle));", replace: "sha256Hex(JSON.stringify(bundle));" },
  { id: "canon-nfc-strings", rule: "strings are NFC-normalised", file: `${B}/canonical.ts`, find: 'if (typeof v === "string") return v.normalize("NFC");', replace: 'if (typeof v === "string") return v;' },
  { id: "canon-nfc-keys", rule: "keys are NFC-normalised", file: `${B}/canonical.ts`, find: '.map(([k, x]) => [k.normalize("NFC"), x] as const)', replace: ".map(([k, x]) => [k, x] as const)" },
  { id: "canon-sorted-keys", rule: "object keys are sorted", file: `${B}/canonical.ts`, find: ".sort((a, b) => compareCodePoints(a[0], b[0]));", replace: ".sort(() => 0);" },
  { id: "canon-duplicate-keys", rule: "keys colliding after normalisation are rejected", file: `${B}/canonical.ts`, find: "if (entries[i][0] === entries[i - 1][0]) throw new Error(", replace: "if (false) throw new Error(" },
  { id: "canon-finite-numbers", rule: "non-finite numbers are rejected", file: `${B}/canonical.ts`, find: "if (!Number.isFinite(v)) throw new Error(", replace: "if (false) throw new Error(" },

  // ---- bundle assembly ----
  { id: "cite-one-id-per-chunk", rule: "one citation id per distinct chunk", file: `${B}/build.ts`, find: "let id = citationOf.get(c.chunkId);", replace: "let id: string | undefined;" },
  { id: "cite-numbering", rule: "citation ids start at E1", file: `${B}/build.ts`, find: "id = `E${citationOf.size + 1}`;", replace: "id = `E${citationOf.size + 2}`;" },
  { id: "cite-facet-order", rule: "citation ids follow facet order", file: `${B}/build.ts`, find: "const facets: BundleFacet[] = QUERY_FACETS.map((name) => {", replace: "const facets: BundleFacet[] = [...QUERY_FACETS].reverse().map((name) => {" },
  { id: "excerpt-verbatim", rule: "excerpts are the stored chunk text, unabridged", file: `${B}/build.ts`, find: "excerpt: c.text,", replace: "excerpt: c.text.slice(0, 120)," },
  { id: "item-chunk-id", rule: "each item is bound to its own chunk id", file: `${B}/build.ts`, find: "chunk_id: c.chunkId,\n    chunk_ordinal: c.chunkOrdinal,\n    chunk_hash: c.chunkHash,\n    version_content_hash", replace: "chunk_id: c.evidenceItemId,\n    chunk_ordinal: c.chunkOrdinal,\n    chunk_hash: c.chunkHash,\n    version_content_hash" },
  { id: "exclusions-carried", rule: "the whole M4.3 exclusion log is persisted", file: `${B}/build.ts`, find: "ranking.exclusions.ranking.map((e) => ({", replace: 'ranking.exclusions.ranking.filter((e) => e.section === "main").map((e) => ({' },
  { id: "conflict-kind", rule: "conflicts are marked as curator-tagged", file: `${B}/build.ts`, find: 'kind: "curator_tagged_conflict",', replace: 'kind: "model_observed_disagreement" as "curator_tagged_conflict",' },
  { id: "conflict-citations", rule: "conflict positions cite their selected chunks", file: `${B}/build.ts`, find: "((d.chunk_ids as string[]) ?? []).map((id) => citationOf.get(id))", replace: "[].map((id: string) => citationOf.get(id))" },
  { id: "gaps-pass-through", rule: "M4.3 gaps are carried over exactly", file: `${B}/build.ts`, find: "const gaps = ranking.gaps.map(", replace: "const gaps = ranking.gaps.slice(1).map(" },
  { id: "historical-after-main", rule: "historical items are cited after the main items, in a flat order", file: `${B}/build.ts`, find: "const rank = i + 1; // one flat, ordered section across facets", replace: "const rank = 1;" },
  { id: "corpus-snapshot", rule: "the bundle records its corpus snapshot", file: `${B}/build.ts`, find: "corpus: { snapshot_id: snap?.id ?? null,", replace: "corpus: { snapshot_id: null," },
  { id: "stats-main-only", rule: "selected counts exclude historical context", file: `${B}/build.ts`, find: "selected_chunks: mainChunks.length,", replace: "selected_chunks: orderedCitations.length," },
  { id: "stats-synthetic", rule: "synthetic evidence is counted as synthetic", file: `${B}/build.ts`, find: "selected_synthetic: [...firstItem.values()].filter((i) => i.is_synthetic).length,", replace: "selected_synthetic: 0," },

  // ---- deterministic reasons ----
  { id: "why-syndrome-general", rule: "a document is 'general' only when it names no syndrome", file: `${B}/reasons.ts`, find: "else if (c.metadata.syndromes.length === 0)", replace: "else if (true)" },
  { id: "why-topic-overlap", rule: "a topic match needs a shared topic", file: `${B}/reasons.ts`, find: "c.metadata.topics.filter((t) => ctx.facetTopics.includes(t))", replace: "c.metadata.topics.filter(() => true)" },
  { id: "why-max-terms", rule: "at most 8 matched terms are listed", file: `${B}/reasons.ts`, find: "const MAX_TERMS_LISTED = 8;", replace: "const MAX_TERMS_LISTED = 20;" },

  // ---- extractive fallback ----
  { id: "fb-opening", rule: "the fallback opens with the required sentence", file: `${B}/fallback.ts`, find: "Evidence relevant to this emerging signal suggests", replace: "Evidence relevant to this emerging signal indicates" },
  { id: "fb-forbidden-outbreak", rule: "'outbreak' is forbidden in the fallback's own wording", file: `${B}/fallback.ts`, find: "/outbreak|epidemic|", replace: "/epidemic|" },
  { id: "fb-forbidden-diagnos", rule: "'diagnos*' is forbidden in the fallback's own wording", file: `${B}/fallback.ts`, find: "|diagnos|confirmed|", replace: "|confirmed|" },
  { id: "fb-forbidden-treat", rule: "'treat*' is forbidden in the fallback's own wording", file: `${B}/fallback.ts`, find: "|treat|therap|", replace: "|therap|" },
  { id: "fb-excerpt-verbatim", rule: "the fallback quotes excerpts unabridged", file: `${B}/fallback.ts`, find: "points.push({ claim_index, citation_id: item.citation_id, facet, excerpt: item.excerpt });", replace: "points.push({ claim_index, citation_id: item.citation_id, facet, excerpt: item.excerpt.slice(0, 80) });" },
  { id: "fb-metadata-required", rule: "a citation with no database metadata is refused, never invented", file: `${B}/fallback.ts`, find: "if (!m) throw new Error(`fallback: no database metadata", replace: "if (false) throw new Error(`fallback: no database metadata" },
  { id: "fb-gaps-exact", rule: "the fallback restates every bundle gap", file: `${B}/fallback.ts`, find: "const gapMessages = bundle.gaps.map((g) => g.message);", replace: "const gapMessages = bundle.gaps.slice(0, 1).map((g) => g.message);" },
  { id: "fb-thin-rule", rule: "a thin result is labelled thin", file: `${B}/fallback.ts`, find: "const thin = bundle.stats.selected_chunks < THIN_MIN_PASSAGES || bundle.stats.facets_covered < THIN_MIN_FACETS;", replace: "const thin = false;" },
  { id: "fb-empty-statement", rule: "an empty result states there is nothing to quote", file: `${B}/fallback.ts`, find: "if (empty) t(", replace: "if (false) t(" },
  { id: "fb-historical-label", rule: "historical documents are labelled as not current evidence", file: `${B}/fallback.ts`, find: "shown for context only and not current evidence", replace: "shown for context" },
  { id: "fb-conflict-label", rule: "conflicts are reported only as curator-tagged", file: `${B}/fallback.ts`, find: "(reported only where curators tagged documents to the same question)", replace: "(detected by the system)" },
  { id: "fb-validate-verbatim", rule: "validation checks excerpts against the bundle", file: `${B}/fallback.ts`, find: "ok: fallback.points.every((p) => itemsByCitation.get(p.citation_id)?.excerpt === p.excerpt)", replace: "ok: true" },
  { id: "fb-validate-wording", rule: "validation rejects forbidden wording", file: `${B}/fallback.ts`, find: "ok: !bad, detail: bad", replace: "ok: true, detail: bad" },
  { id: "fb-validate-gap-wording", rule: "gap messages count as the fallback's own wording", file: `${B}/fallback.ts`, find: '.filter((p) => p.kind === "template" || p.kind === "gap")', replace: '.filter((p) => p.kind === "template")' },
  { id: "fb-validate-citations", rule: "validation rejects citation ids outside the bundle", file: `${B}/fallback.ts`, find: "ok: [...fallback.text.matchAll(/\\[E(\\d+)\\]/g)].every((m) => byCitation.has(`E${m[1]}`))", replace: "ok: true" },

  // ---- persistence ----
  { id: "persist-hash-check", rule: "a bundle that does not hash to its bundle_hash is refused", file: `${B}/persist.ts`, find: "if (bundleHashOf(bundle) !== bundle.bundle_hash) throw new Error(", replace: "if (false) throw new Error(" },
  { id: "persist-snapshot", rule: "a bundle needs a corpus snapshot to be stored", file: `${B}/persist.ts`, find: "if (!bundle.corpus.snapshot_id) throw new Error(", replace: "if (false) throw new Error(" },
  { id: "persist-idempotent-bundle", rule: "persisting the same signal + bundle hash creates nothing new", file: `${B}/persist.ts`, find: 'let bundleRow = (await db.select("evidence_bundles", { signal_candidate_id: signalId, bundle_hash: bundle.bundle_hash }, ["id", "retrieval_run_id"]))[0];', replace: "let bundleRow: Row | undefined;" },
  { id: "persist-item-completion", rule: "an interrupted write is completed without duplicating items", file: `${B}/persist.ts`, find: "if (haveItems.has(p.item.citation_id)) continue;", replace: "if (false) continue;" },
  { id: "persist-fallback-idempotent", rule: "the fallback is stored once per bundle", file: `${B}/persist.ts`, find: 'let existing = (await db.select("generated_explanations", key, ["id", "output"]))[0];', replace: "let existing: Row | undefined;" },
  { id: "persist-fallback-validated", rule: "a fallback that fails validation is never stored", file: `${B}/persist.ts`, find: "if (failed.length) throw new Error(", replace: "if (false) throw new Error(" },
  { id: "persist-fallback-status", rule: "the fallback is stored with status fallback_extractive", file: `${B}/persist.ts`, find: 'status: "fallback_extractive", output: asJson(rendered.fallback),', replace: 'status: "validated", output: asJson(rendered.fallback),' },
  { id: "persist-run-success", rule: "a completed run is marked succeeded", file: `${B}/persist.ts`, find: 'if (created && runId) await db.update("retrieval_runs", { id: runId }, { status: "succeeded", finished_at: now });', replace: ";" },
  { id: "persist-run-recovery", rule: "a run left failed by an interrupted write is repaired", file: `${B}/persist.ts`, find: 'if (prior && prior.status !== "succeeded") await db.update(', replace: "if (false) await db.update(" },
  { id: "persist-mirror-main-only", rule: "the mirror lists current documents, not historical ones", file: `${B}/persist.ts`, find: 'const ids = new Set(b.citations.filter((c) => c.section === "main").map((c) => c.evidence_item_id));', replace: "const ids = new Set(b.citations.map((c) => c.evidence_item_id));" },
  { id: "persist-mirror-delete", rule: "the mirror drops documents no longer cited", file: `${B}/persist.ts`, find: "for (const id of [...have.keys()].filter((k) => !want.has(k)))", replace: "for (const id of [...have.keys()].filter(() => false))" },
  { id: "persist-mirror-repair", rule: "a changed mirror note is repaired", file: `${B}/persist.ts`, find: "} else if (have.get(id) !== note) {", replace: "} else if (false) {" },
  { id: "verify-hash", rule: "verification recomputes the bundle hash", file: `${B}/persist.ts`, find: 'if (bundleHashOf(b) !== row.bundle_hash) problems.push(', replace: "if (false) problems.push(" },
  { id: "verify-chunk-text", rule: "verification compares the excerpt with the stored chunk", file: `${B}/persist.ts`, find: "if (chunk.text !== p.item.excerpt) problems.push(", replace: "if (false) problems.push(" },
  { id: "verify-item-mapping", rule: "verification checks each citation's (version, chunk) row", file: `${B}/persist.ts`, find: "if (stored.evidence_version_id !== p.item.evidence_version_id || stored.chunk_id !== p.item.chunk_id) problems.push(", replace: "if (false) problems.push(" },
  { id: "verify-stale", rule: "verification reports sources that are no longer current", file: `${B}/persist.ts`, find: 'if (p.citation.section === "main" && d && d.status !== "current") stale.push(', replace: "if (false) stale.push(" },
];

const only = process.argv[2] ? new Set(process.argv[2].split(",")) : null;
const TESTS = [B, "src/test/db/m4.bundle.db.test.ts"];
const BACKUP = ".mutation-m4-4.bak";
const restoreAll: Array<() => void> = [];
const restore = () => restoreAll.splice(0).forEach((f) => f());
process.on("exit", restore);
process.on("SIGINT", () => {
  restore();
  process.exit(130);
});

// every pattern must match exactly once, before anything is changed
let invalid = 0;
for (const m of MUTANTS) {
  const n = readFileSync(m.file, "utf8").split(m.find).length - 1;
  if (n !== 1) {
    invalid += 1;
    console.log(`INVALID   ${m.id.padEnd(26)} pattern found ${n} times in ${m.file}`);
  }
}
if (invalid) process.exit(1);

let survived = 0;
let ran = 0;
const survivors: string[] = [];
for (const m of MUTANTS) {
  if (only && !only.has(m.id)) continue;
  const original = readFileSync(m.file, "utf8");
  copyFileSync(m.file, BACKUP);
  restoreAll.push(() => {
    if (existsSync(BACKUP)) {
      copyFileSync(BACKUP, m.file);
      rmSync(BACKUP);
    }
  });
  writeFileSync(m.file, original.replace(m.find, () => m.replace), "utf8");
  const r = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...TESTS, "--reporter=dot"], { encoding: "utf8", timeout: 300_000 });
  restore();
  ran += 1;
  const killed = r.status !== 0;
  if (!killed) {
    survived += 1;
    survivors.push(m.id);
  }
  const failed = /(\d+) failed/.exec(`${r.stdout}\n${r.stderr}`)?.[1];
  console.log(`${killed ? "KILLED  " : "SURVIVED"}  ${m.id.padEnd(26)} ${m.rule}${killed && failed ? `  (${failed} test(s) failed)` : ""}`);
}
console.log(`\n${ran - survived}/${ran} mutants killed, ${survived} survived.${survivors.length ? ` Survivors: ${survivors.join(", ")}` : ""}`);
if (survived) process.exit(1);
