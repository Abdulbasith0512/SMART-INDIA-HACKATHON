// Database-backed entry points: signal id -> its latest stored M4.4 bundle -> grounded explanation (or the stored fallback).
// Reads the bundle tables and the evidence rows the bundle cites; writes only through persist.ts. No browser path.
import type { EvidenceDb } from "../ingest/ingest";
import { loadStoredBundle } from "../bundle/persist";
import type { GenerateOptions } from "./generate";
import { explainStoredBundle, type ExplainOutcome } from "./persist";
import type { LlmProvider } from "./types";

/** Explain the most recently created bundle of a signal, or the bundle with the given hash. Null if the signal has no stored bundle. */
export async function explainSignal(
  db: EvidenceDb, signalId: string, provider: LlmProvider | null, opts: { bundleHash?: string; generate?: GenerateOptions } = {},
): Promise<(ExplainOutcome & { bundleId: string }) | null> {
  const stored = await loadStoredBundle(db, signalId, opts.bundleHash);
  if (!stored) return null;
  return { ...(await explainStoredBundle(db, stored.id, provider, { generate: opts.generate })), bundleId: stored.id };
}
