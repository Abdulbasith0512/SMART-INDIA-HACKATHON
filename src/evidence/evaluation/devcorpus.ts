// The committed SYNTHETIC development corpus as the evaluation harness sees it. Reads the corpus from disk, so this module is
// for scripts and tests only (it follows the precedent of ranking/scenarios.ts and retrieval/testkit.ts) and is never imported
// by application code.
import { join } from "node:path";
import { SNAPSHOT } from "../bundle/testkit";
import { buildCorpus } from "../ingest/loader";
import { historicalViewFromPrepared, viewFromPrepared } from "../retrieval/testkit";
import type { CorpusBase } from "./scenarioCorpus";

export interface DevCorpus extends CorpusBase {
  corpusHash: string;
  documents: number;
  chunks: number;
}

/** Reference identity and snapshot used for every evaluation bundle, so the bundle for the reference scenario equals the M4.4 golden bundle. */
export const EVAL_SNAPSHOT = SNAPSHOT;

let cached: DevCorpus | null = null;
export function loadDevCorpus(root = process.cwd()): DevCorpus {
  if (cached && root === process.cwd()) return cached;
  const built = buildCorpus(join(root, "data", "evidence", "corpus"), join(root, "data", "evidence", "allowlist.json"), "jansanket-dev-corpus");
  const view = { ...viewFromPrepared(built.prepared), activeSnapshot: EVAL_SNAPSHOT };
  const historicalView = { ...historicalViewFromPrepared(built.prepared), activeSnapshot: EVAL_SNAPSHOT };
  const out: DevCorpus = { view, historicalView, corpusHash: built.manifest.corpus_hash, documents: built.prepared.length, chunks: built.prepared.reduce((n, p) => n + p.chunks.length, 0) };
  if (root === process.cwd()) cached = out;
  return out;
}
