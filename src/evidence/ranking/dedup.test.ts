// @vitest-environment node
import { describe, expect, it } from "vitest";
import { findDuplicate, jaccard, meetsThreshold, overlap, shingleSet, type DedupItem } from "./dedup";

const T = { numerator: 17, denominator: 20 };
const set = (...xs: string[]) => new Set(xs);
const words = (n: number, prefix = "w") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const item = (o: Partial<DedupItem> & { text?: string } = {}): DedupItem => ({
  chunkId: o.chunkId ?? "c1", itemId: o.itemId ?? "i1", canonicalId: o.canonicalId ?? "doc-a", versionContentHash: o.versionContentHash ?? "a".repeat(64),
  chunkHash: o.chunkHash ?? "b".repeat(64), chunkOrdinal: o.chunkOrdinal ?? 0, shingles: o.shingles ?? shingleSet(o.text ?? "alpha beta gamma delta epsilon"),
});

describe("shingles: normalisation (whitespace, case, punctuation, Unicode)", () => {
  it("builds word 3-grams over the retrieval tokenisation", () => {
    expect([...shingleSet("The quick brown fox")].sort()).toEqual(["quick brown fox", "the quick brown"]);
  });

  it("ignores whitespace, case and punctuation differences", () => {
    const a = shingleSet("The quick brown fox jumps over the lazy dog.");
    const b = shingleSet("  THE   quick,\n brown\tfox — jumps over (the) lazy dog!!  ");
    expect([...b].sort()).toEqual([...a].sort());
    expect(jaccard(a, b)).toBe(1);
  });

  it("folds Unicode compatibility forms (full-width letters, ligatures) before comparing", () => {
    expect(jaccard(shingleSet("ｑｕｉｃｋ ｂｒｏｗｎ ｆｏｘ ｊｕｍｐｓ"), shingleSet("quick brown fox jumps"))).toBe(1);
    expect(jaccard(shingleSet("the ﬁeld ofﬁcer reports daily"), shingleSet("the field officer reports daily"))).toBe(1);
  });

  it("treats Hindi sentences with different sentence-final punctuation as identical", () => {
    const a = shingleSet("चरण 1: रिपोर्ट करने वाली स्वास्थ्य सुविधाओं से मामलों की संख्या की जाँच करें।");
    const b = shingleSet("चरण 1 रिपोर्ट करने वाली स्वास्थ्य सुविधाओं से मामलों की संख्या की जाँच करें.");
    expect(jaccard(a, b)).toBe(1);
    expect(a.size).toBeGreaterThan(5);
  });

  it("a text shorter than the shingle size is one shingle; no tokens, no shingles", () => {
    expect([...shingleSet("fever rash")]).toEqual(["fever rash"]);
    expect([...shingleSet("fever")]).toEqual(["fever"]);
    expect(shingleSet("").size).toBe(0);
    expect(shingleSet(" ... --- !!! ").size).toBe(0);
  });

  it("honours a different shingle size", () => {
    expect(shingleSet("a b c d", 2).size).toBe(3);
    expect(shingleSet("a b c d", 1).size).toBe(4);
  });
});

describe("Jaccard similarity", () => {
  it("is 1 for identical sets, 0 for disjoint sets, and the ratio otherwise", () => {
    expect(jaccard(set("a", "b"), set("a", "b"))).toBe(1);
    expect(jaccard(set("a"), set("b"))).toBe(0);
    expect(jaccard(set("a", "b", "c"), set("b", "c", "d"))).toBe(0.5);
  });

  it("is symmetric and never NaN, even for two empty sets", () => {
    expect(jaccard(set(), set())).toBe(0);
    expect(jaccard(set("a"), set())).toBe(0);
    expect(jaccard(set("a", "b"), set("b", "c", "d"))).toBe(jaccard(set("b", "c", "d"), set("a", "b")));
    expect(overlap(set(), set())).toEqual({ intersection: 0, union: 0 });
  });
});

describe("near-duplicate threshold (17/20 = 0.85, inclusive, exact)", () => {
  const shared = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);

  it("counts exactly 0.85 as a near-duplicate", () => {
    const a = set(...shared(17), "onlyA1"); // 18 shingles
    const b = set(...shared(17), "onlyB1", "onlyB2"); // 19 shingles; union 20, intersection 17
    expect(overlap(a, b)).toEqual({ intersection: 17, union: 20 });
    expect(jaccard(a, b)).toBe(0.85);
    expect(meetsThreshold(a, b, T)).toBe(true);
  });

  it("rejects just below the threshold", () => {
    const a = set(...shared(16), "onlyA1"); // intersection 16
    const b = set(...shared(16), "onlyB1", "onlyB2"); // union 19 -> 0.8421
    expect(meetsThreshold(a, b, T)).toBe(false);
    const c = set(...shared(33), "x"); // 34
    const d = set(...shared(33), "y", "z", "w"); // 36 -> union 37 -> 33/37 = 0.8918... above; make a below case
    expect(meetsThreshold(c, d, T)).toBe(true);
    const e = set(...shared(84), "p", "q"); // 86
    const f = set(...shared(84), "r", "s", "t", "u", "v", "w", "x", "y", "z", "m", "n", "o", "k"); // union 99 -> 84/99 = 0.848...
    expect(jaccard(e, f)).toBeLessThan(0.85);
    expect(meetsThreshold(e, f, T)).toBe(false);
  });

  it("accepts just above the threshold and identical sets, and never treats empty sets as duplicates", () => {
    expect(meetsThreshold(set(...shared(18), "a"), set(...shared(18), "b"), T)).toBe(true); // 18/20 = 0.90
    expect(meetsThreshold(set("a"), set("a"), T)).toBe(true);
    expect(meetsThreshold(set(), set(), T)).toBe(false);
  });

  it("a one-word edit at the end of a text is a near-duplicate, while a mid-text edit of a short text is not (shingle sensitivity)", () => {
    const base = words(30).join(" ");
    expect(meetsThreshold(shingleSet(base), shingleSet(`${words(29).join(" ")} changed`), T)).toBe(true); // 27/29 = 0.93
    const mid = words(30);
    mid[15] = "changed";
    expect(jaccard(shingleSet(base), shingleSet(mid.join(" ")))).toBeCloseTo(25 / 31, 6); // 0.806: below threshold
    expect(meetsThreshold(shingleSet(base), shingleSet(mid.join(" ")), T)).toBe(false);
    const long = words(60);
    const longMid = [...long];
    longMid[30] = "changed";
    expect(meetsThreshold(shingleSet(long.join(" ")), shingleSet(longMid.join(" ")), T)).toBe(true); // 55/61 = 0.90
  });
});

describe("findDuplicate: rules, precedence and the retained candidate", () => {
  it("returns null when nothing matches", () => {
    expect(findDuplicate(item({ chunkId: "n", itemId: "iN", canonicalId: "other", versionContentHash: "9".repeat(64), chunkHash: "8".repeat(64), text: "completely different words here now" }), [item()], T)).toBeNull();
    expect(findDuplicate(item(), [], T)).toBeNull();
  });

  it("same canonical id in a different row, same chunk position", () => {
    const kept = item({ chunkId: "k", itemId: "row1", canonicalId: "doc-x", versionContentHash: "1".repeat(64), chunkHash: "2".repeat(64), text: "one two three four" });
    const cand = item({ chunkId: "c", itemId: "row2", canonicalId: "doc-x", versionContentHash: "3".repeat(64), chunkHash: "4".repeat(64), text: "unrelated tokens go here today" });
    const m = findDuplicate(cand, [kept], T)!;
    expect(m).toMatchObject({ rule: "same_canonical_id", jaccard: null });
    expect(m.retained.chunkId).toBe("k");
    expect(m.basis).toMatch(/canonical_id doc-x/);
  });

  it("does not call two chunks of the SAME row duplicates just because they share a canonical id", () => {
    const a = item({ chunkId: "k", itemId: "row1", canonicalId: "doc-x", chunkOrdinal: 0, versionContentHash: "1".repeat(64), chunkHash: "2".repeat(64), text: "one two three four" });
    const b = item({ chunkId: "c", itemId: "row1", canonicalId: "doc-x", chunkOrdinal: 0, versionContentHash: "1".repeat(64), chunkHash: "4".repeat(64), text: "wholly other words appear now" });
    expect(findDuplicate(b, [a], T)).toBeNull();
  });

  it("same version content hash in a different document, same chunk position", () => {
    const kept = item({ chunkId: "k", itemId: "iA", canonicalId: "doc-a", versionContentHash: "7".repeat(64), chunkHash: "1".repeat(64), chunkOrdinal: 2, text: "alpha one two three" });
    const cand = item({ chunkId: "c", itemId: "iB", canonicalId: "doc-b", versionContentHash: "7".repeat(64), chunkHash: "2".repeat(64), chunkOrdinal: 2, text: "beta four five six" });
    expect(findDuplicate(cand, [kept], T)).toMatchObject({ rule: "same_content_hash" });
    // a different chunk position within identical-hash documents is not matched by this rule
    expect(findDuplicate({ ...cand, chunkOrdinal: 3 }, [kept], T)).toBeNull();
  });

  it("identical chunk text in a different document", () => {
    const kept = item({ chunkId: "k", itemId: "iA", canonicalId: "doc-a", versionContentHash: "1".repeat(64), chunkHash: "5".repeat(64), text: "one two three four" });
    const cand = item({ chunkId: "c", itemId: "iB", canonicalId: "doc-b", versionContentHash: "2".repeat(64), chunkHash: "5".repeat(64), text: "completely other words here" });
    expect(findDuplicate(cand, [kept], T)).toMatchObject({ rule: "same_chunk_hash" });
  });

  it("near-duplicate by shingle Jaccard, recording the similarity", () => {
    const base = words(40).join(" ");
    const kept = item({ chunkId: "k", itemId: "iA", canonicalId: "doc-a", versionContentHash: "1".repeat(64), chunkHash: "1".repeat(64), text: base });
    const cand = item({ chunkId: "c", itemId: "iB", canonicalId: "doc-b", versionContentHash: "2".repeat(64), chunkHash: "2".repeat(64), text: `${words(39).join(" ")} different` });
    const m = findDuplicate(cand, [kept], T)!;
    expect(m.rule).toBe("near_duplicate");
    expect(m.jaccard).toBeGreaterThanOrEqual(0.85);
    expect(m.basis).toMatch(/Jaccard 0\.9\d+ >= 17\/20/);
  });

  it("applies the rules in order: canonical id, then content hash, then chunk hash, then near-duplicate", () => {
    const kept = item({ chunkId: "k", itemId: "iA", canonicalId: "doc-x", versionContentHash: "7".repeat(64), chunkHash: "5".repeat(64), text: "same words in every one" });
    const cand = item({ chunkId: "c", itemId: "iB", canonicalId: "doc-x", versionContentHash: "7".repeat(64), chunkHash: "5".repeat(64), text: "same words in every one" });
    expect(findDuplicate(cand, [kept], T)!.rule).toBe("same_canonical_id");
    expect(findDuplicate({ ...cand, canonicalId: "doc-y" }, [kept], T)!.rule).toBe("same_content_hash");
    expect(findDuplicate({ ...cand, canonicalId: "doc-y", versionContentHash: "8".repeat(64) }, [kept], T)!.rule).toBe("same_chunk_hash");
    expect(findDuplicate({ ...cand, canonicalId: "doc-y", versionContentHash: "8".repeat(64), chunkHash: "6".repeat(64) }, [kept], T)!.rule).toBe("near_duplicate");
  });

  it("returns the FIRST retained candidate that matches (the retention order is the caller's)", () => {
    const k1 = item({ chunkId: "k1", itemId: "i1", canonicalId: "a", chunkHash: "5".repeat(64), versionContentHash: "1".repeat(64), text: "x y z w" });
    const k2 = item({ chunkId: "k2", itemId: "i2", canonicalId: "b", chunkHash: "5".repeat(64), versionContentHash: "2".repeat(64), text: "x y z w" });
    const cand = item({ chunkId: "c", itemId: "i3", canonicalId: "c", chunkHash: "5".repeat(64), versionContentHash: "3".repeat(64), text: "x y z w" });
    expect(findDuplicate(cand, [k1, k2], T)!.retained.chunkId).toBe("k1");
    expect(findDuplicate(cand, [k2, k1], T)!.retained.chunkId).toBe("k2");
  });
});
