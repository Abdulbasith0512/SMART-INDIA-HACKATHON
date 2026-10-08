// Test helpers for the grounded-generation layer (not a test file): the committed SYNTHETIC reference bundle, its passages as
// the database would resolve them, a metadata resolver, and a one-call way to run a scenario through the real pipeline.
import { devResolver, referenceBundle, type RefOptions } from "../bundle/testkit";
import type { EvidenceBundle } from "../bundle/types";
import { historicalViewFromPrepared, viewFromPrepared } from "../retrieval/testkit";
import { generateExplanation, type GenerateOptions, type GenerationResult } from "./generate";
import { MockProvider, type MockOptions } from "./mock";
import type { LlmProvider, Passage, PassageMap } from "./types";

/** A fixed nonce so prompts are comparable in tests. (Production draws a fresh one per request.) */
export const TEST_NONCE = "0123456789abcdef01234567";

/** Passages for a bundle, resolved by the stored chunk ids from the development corpus (what the database path does with SQL). */
export function passagesFor(bundle: EvidenceBundle, textOverride: Record<string, string> = {}): PassageMap {
  const chunks = new Map([...viewFromPrepared().items, ...historicalViewFromPrepared().items].flatMap((i) => i.chunks.map((c) => [c.id, c.text] as const)));
  const out = new Map<string, Passage>();
  for (const c of bundle.citations) {
    const text = textOverride[c.citation_id] ?? chunks.get(c.chunk_id);
    if (text === undefined) throw new Error(`no development passage for ${c.citation_id}`);
    out.set(c.citation_id, { citation_id: c.citation_id, evidence_version_id: c.evidence_version_id, chunk_id: c.chunk_id, text, facets: c.appears_in.map((a) => a.facet) });
  }
  return out;
}

/** A bundle in which some passages carry the given text (re-hashing is unnecessary: the pipeline reads the bundle, not its hash). */
export function bundleWithPassages(textOverride: Record<string, string>, opts: RefOptions = {}): { bundle: EvidenceBundle; passages: PassageMap } {
  const bundle = referenceBundle(opts);
  return { bundle, passages: passagesFor(bundle, textOverride) };
}

export const resolver = devResolver();

export async function runScenario(mock: MockOptions | LlmProvider | null, o: { bundle?: EvidenceBundle; passages?: PassageMap; options?: GenerateOptions } = {}): Promise<GenerationResult & { provider_obj: LlmProvider | null }> {
  const bundle = o.bundle ?? referenceBundle();
  const provider = mock === null ? null : "generate" in mock ? mock : new MockProvider(mock);
  const result = await generateExplanation({ bundle, passages: o.passages ?? passagesFor(bundle), provider, resolveMetadata: resolver, options: { nonce: () => TEST_NONCE, ...o.options } });
  return { ...result, provider_obj: provider };
}
