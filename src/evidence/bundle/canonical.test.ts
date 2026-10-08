// @vitest-environment node
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../hash";
import { HASH_EXCLUDED_FIELDS, bundleHashOf, canonicalBundleJson, snakeKeys } from "./canonical";

describe("canonical bundle JSON", () => {
  it("sorts keys at every depth, whatever order they were built in", () => {
    const a = { b: 1, a: { d: [1, 2], c: "x" } };
    const b = { a: { c: "x", d: [1, 2] }, b: 1 };
    expect(canonicalBundleJson(a)).toBe(canonicalBundleJson(b));
    expect(canonicalBundleJson(a)).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
  });

  it("keeps array order (order is meaningful and is fixed by the builder)", () => {
    expect(canonicalBundleJson({ a: [1, 2] })).not.toBe(canonicalBundleJson({ a: [2, 1] }));
  });

  it("orders keys by code point, not by locale", () => {
    expect(canonicalBundleJson({ b: 1, B: 2, a: 3, "é": 4, z: 5 })).toBe('{"B":2,"a":3,"b":1,"z":5,"é":4}');
  });

  it("normalises strings and keys to NFC, so composed and decomposed forms hash identically", () => {
    const composed = { name: "café", ["clé"]: "x" };
    const decomposed = { name: "café", ["clé"]: "x" };
    expect(canonicalBundleJson(decomposed)).toBe(canonicalBundleJson(composed));
    expect(bundleHashOf(decomposed)).toBe(bundleHashOf(composed));
  });

  it("refuses keys that collide only after normalisation", () => {
    expect(() => canonicalBundleJson({ ["clé"]: 1, ["clé"]: 2 })).toThrow(/duplicate key/);
  });

  it("serialises numbers deterministically: -0 becomes 0, floats are not reformatted", () => {
    expect(canonicalBundleJson({ a: -0, b: 0, c: 0.5, d: 1e21, e: 12 })).toBe('{"a":0,"b":0,"c":0.5,"d":1e+21,"e":12}');
    expect(canonicalBundleJson({ a: -0 })).toBe(canonicalBundleJson({ a: 0 }));
  });

  it("rejects values that have no canonical form", () => {
    for (const bad of [{ a: Number.NaN }, { a: Number.POSITIVE_INFINITY }, { a: undefined }, { a: () => 1 }, { a: 10n }, { a: Symbol("x") }]) {
      expect(() => canonicalBundleJson(bad as never)).toThrow();
    }
  });

  it("drops the hash and the clock from what is hashed, and nothing else", () => {
    expect([...HASH_EXCLUDED_FIELDS]).toEqual(["bundle_hash", "retrieved_at"]);
    const core = { x: 1, nested: { retrieved_at: "keep: only the top-level stamp is excluded" } };
    const a = { ...core, bundle_hash: "a".repeat(64), retrieved_at: "2026-01-01T00:00:00.000Z" };
    const b = { ...core, bundle_hash: "b".repeat(64), retrieved_at: "2030-12-31T23:59:59.999Z" };
    expect(canonicalBundleJson(a)).toBe(canonicalBundleJson(core));
    expect(bundleHashOf(a)).toBe(bundleHashOf(b));
    expect(canonicalBundleJson(a)).toContain("keep: only the top-level stamp is excluded");
  });

  it("does not mutate its input", () => {
    const input = { b: 1, a: [{ z: 1, y: 2 }], retrieved_at: "t", bundle_hash: "h" };
    const copy = JSON.parse(JSON.stringify(input));
    canonicalBundleJson(input);
    expect(input).toEqual(copy);
  });

  it("is SHA-256 over exactly that text, and sensitive to any change in any field", () => {
    const base = { a: { b: [1, "two", null, true] } };
    expect(bundleHashOf(base)).toBe(sha256Hex(canonicalBundleJson(base)));
    expect(bundleHashOf(base)).toMatch(/^[0-9a-f]{64}$/);
    const variants = [
      { a: { b: [1, "two", null, false] } }, { a: { b: [1, "two", null] } }, { a: { b: [1, "twO", null, true] } }, { a: { b: [1, "two", 0, true] } },
      { a: { b: [1, "two", null, true], c: 1 } }, { a: { b: ["1", "two", null, true] } }, { A: { b: [1, "two", null, true] } },
    ];
    const hashes = new Set([bundleHashOf(base), ...variants.map(bundleHashOf)]);
    expect(hashes.size).toBe(variants.length + 1);
  });
});

describe("snakeKeys", () => {
  it("converts camelCase keys at every depth and leaves values alone", () => {
    expect(snakeKeys({ evidenceItemId: "aB", nested: { bm25Score: 1, chunkIds: ["xY"] }, list: [{ rankScore: 2 }] })).toEqual({
      evidence_item_id: "aB", nested: { bm25_score: 1, chunk_ids: ["xY"] }, list: [{ rank_score: 2 }],
    });
  });

  it("is idempotent on keys that are already snake_case or lower-case", () => {
    const x = { already_snake: 1, plain: { operational_guidance: 2, "main:duplicate": 3 } };
    expect(snakeKeys(x)).toEqual(x);
    expect(snakeKeys(snakeKeys({ someKeyName: 1 }))).toEqual({ some_key_name: 1 });
  });

  it("passes primitives, null and empty containers through", () => {
    expect(snakeKeys(null)).toBeNull();
    expect(snakeKeys(5)).toBe(5);
    expect(snakeKeys("camelCase")).toBe("camelCase");
    expect(snakeKeys([])).toEqual([]);
    expect(snakeKeys({})).toEqual({});
  });
});
