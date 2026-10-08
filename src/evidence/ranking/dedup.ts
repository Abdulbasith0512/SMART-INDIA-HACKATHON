// Deduplication. Duplicates are never silently discarded: the caller records, for every removed candidate, the
// candidate that was retained, the rule that fired and the comparison basis.
//
// Rules, tried in this order against the candidates already retained (which are visited in retention-priority
// order: higher source tier, more specific geography, higher rank score, then identifiers):
//   same_canonical_id  a different row of the same logical document, same chunk position
//   same_content_hash  a different document whose current version has the identical content hash, same chunk position
//   same_chunk_hash    identical chunk text in a different document
//   near_duplicate     token-shingle Jaccard similarity >= 17/20 (0.85)
//
// Shingles are word 3-grams over the SAME tokenisation as retrieval (NFKC, lower-case, any script), so whitespace,
// punctuation, case and Unicode compatibility forms never hide a duplicate. The threshold is compared as an exact
// integer ratio, so there is no floating-point edge at exactly 0.85.
import { tokenize } from "../retrieval/tokenize";

export type DedupRule = "same_canonical_id" | "same_content_hash" | "same_chunk_hash" | "near_duplicate";

export interface DedupItem {
  chunkId: string;
  itemId: string;
  canonicalId: string | null;
  versionContentHash: string;
  chunkHash: string;
  chunkOrdinal: number;
  shingles: ReadonlySet<string>;
}

export interface DuplicateMatch {
  retained: DedupItem;
  rule: DedupRule;
  jaccard: number | null;
  basis: string;
}

/** Word k-grams; a text shorter than k tokens is one shingle of all its tokens; no tokens, no shingles. */
export function shingleSet(text: string, k = 3): Set<string> {
  const tokens = tokenize(text);
  const out = new Set<string>();
  if (tokens.length === 0) return out;
  if (tokens.length < k) {
    out.add(tokens.join(" "));
    return out;
  }
  for (let i = 0; i + k <= tokens.length; i += 1) out.add(tokens.slice(i, i + k).join(" "));
  return out;
}

export function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): { intersection: number; union: number } {
  let intersection = 0;
  for (const s of a) if (b.has(s)) intersection += 1;
  return { intersection, union: a.size + b.size - intersection };
}

/** Jaccard similarity in [0, 1]; two empty sets are NOT similar (0), never NaN. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const { intersection, union } = overlap(a, b);
  return union === 0 ? 0 : intersection / union;
}

export function meetsThreshold(a: ReadonlySet<string>, b: ReadonlySet<string>, t: { numerator: number; denominator: number }): boolean {
  const { intersection, union } = overlap(a, b);
  return union > 0 && intersection * t.denominator >= t.numerator * union;
}

export function findDuplicate(candidate: DedupItem, retained: readonly DedupItem[], t: { numerator: number; denominator: number }): DuplicateMatch | null {
  const other = (k: DedupItem) => k.itemId !== candidate.itemId;
  for (const k of retained) {
    if (candidate.canonicalId !== null && k.canonicalId === candidate.canonicalId && other(k) && k.chunkOrdinal === candidate.chunkOrdinal) {
      return { retained: k, rule: "same_canonical_id", jaccard: null, basis: `canonical_id ${candidate.canonicalId}, chunk ordinal ${candidate.chunkOrdinal}` };
    }
  }
  for (const k of retained) {
    if (k.versionContentHash === candidate.versionContentHash && other(k) && k.chunkOrdinal === candidate.chunkOrdinal) {
      return { retained: k, rule: "same_content_hash", jaccard: null, basis: `version content_hash ${candidate.versionContentHash.slice(0, 12)}, chunk ordinal ${candidate.chunkOrdinal}` };
    }
  }
  for (const k of retained) {
    if (k.chunkHash === candidate.chunkHash && other(k)) {
      return { retained: k, rule: "same_chunk_hash", jaccard: null, basis: `chunk_hash ${candidate.chunkHash.slice(0, 12)}` };
    }
  }
  for (const k of retained) {
    if (meetsThreshold(candidate.shingles, k.shingles, t)) {
      const j = jaccard(candidate.shingles, k.shingles);
      return { retained: k, rule: "near_duplicate", jaccard: Number(j.toFixed(6)), basis: `word 3-gram Jaccard ${j.toFixed(4)} >= ${t.numerator}/${t.denominator}` };
    }
  }
  return null;
}
