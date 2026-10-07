// @vitest-environment node
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../hash";
import { buildChunks, ChunkError, DB_MAX_CHUNK_CHARS, MAX_CHUNK_CHARS, packText } from "./chunk";

describe("packText", () => {
  it("keeps short text in one chunk", () => expect(packText("One sentence. Another one.")).toEqual(["One sentence. Another one."]));

  it("never exceeds the packing limit and loses no words", () => {
    const sentence = "This is a sentence of moderate length used for packing tests. ";
    const text = sentence.repeat(80).trim();
    const chunks = packText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    expect(chunks.join(" ").split(/\s+/)).toEqual(text.split(/\s+/));
  });

  it("splits on the Devanagari danda as a sentence boundary", () => {
    const s = "यह एक वाक्य है। ".repeat(120).trim();
    const chunks = packText(s, 300);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(300);
      expect(c.endsWith("।")).toBe(true);
    }
  });

  it("hard-splits a single oversize sentence at whitespace", () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const chunks = packText(long, 200);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
    expect(chunks.join(" ")).toBe(long);
  });

  it("hard-splits a token with no whitespace at the limit", () => {
    const chunks = packText("x".repeat(450), 200);
    expect(chunks.map((c) => c.length)).toEqual([200, 200, 50]);
  });

  it("never merges across a paragraph break", () => {
    expect(packText("First paragraph.\n\nSecond paragraph.")).toEqual(["First paragraph.", "Second paragraph."]);
  });

  it("is deterministic", () => {
    const t = "A. B. C. ".repeat(500);
    expect(packText(t)).toEqual(packText(t));
  });
});

describe("buildChunks", () => {
  it("orders abstract chunks before excerpts and hashes each chunk", () => {
    const c = buildChunks("Abstract text.", ["Excerpt one.", "Excerpt two."]);
    expect(c.map((x) => [x.ordinal, x.kind])).toEqual([[0, "abstract"], [1, "excerpt"], [2, "excerpt"]]);
    for (const x of c) expect(x.chunk_hash).toBe(sha256Hex(x.text));
  });

  it("supports excerpt-only documents", () => {
    expect(buildChunks("", ["Only an excerpt."]).map((x) => x.kind)).toEqual(["excerpt"]);
  });

  it("rejects empty documents, empty or oversize excerpts and duplicate chunks", () => {
    expect(() => buildChunks("", [])).toThrow(ChunkError);
    expect(() => buildChunks("A.", [""])).toThrow(/empty/);
    expect(() => buildChunks("A.", ["x".repeat(DB_MAX_CHUNK_CHARS + 1)])).toThrow(/shorten/);
    expect(() => buildChunks("Same text.", ["Same text."])).toThrow(/duplicate/);
  });

  it("accepts an excerpt exactly at the database limit", () => {
    expect(buildChunks("", ["x".repeat(DB_MAX_CHUNK_CHARS)])[0].text.length).toBe(DB_MAX_CHUNK_CHARS);
  });
});
