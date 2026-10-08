// Deterministic, script-agnostic tokenisation for lexical retrieval.
//   1. Unicode NFKC normalisation (compatibility forms such as full-width letters or ligatures fold together)
//   2. locale-independent lower-casing (String.prototype.toLowerCase, never toLocaleLowerCase)
//   3. a token is a maximal run of letters, combining marks and digits in ANY script (\p{L}\p{M}\p{N})
// Combining marks are KEPT: in Devanagari and Odia the vowel signs and viraama are marks, and dropping them would
// shred words. There is NO stemming, NO stop-word removal and NO transliteration; none is claimed. Hyphens and
// apostrophes split tokens ("non-urgent" -> "non", "urgent"). The same function normalises documents and queries,
// so both sides always agree.

export const TOKENIZER_VERSION = "tokenize/1.0.0";

const TOKEN_RUN = /[\p{L}\p{M}\p{N}]+/gu;

export function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

export function tokenize(text: string): string[] {
  return normalizeText(text).match(TOKEN_RUN) ?? [];
}

/** Distinct query terms in code-point order (the fixed summation order used by the scorer). */
export function distinctSorted(tokens: readonly string[]): string[] {
  return [...new Set(tokens)].sort(compareCodePoints);
}

/** Byte-order-style comparison independent of locale (never use localeCompare for identity-bearing order). */
export function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
