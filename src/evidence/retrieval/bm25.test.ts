// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BM25_B, BM25_K1, Bm25Index, roundScore, type Bm25Doc } from "./bm25";
import { compareCodePoints, distinctSorted, normalizeText, tokenize, TOKENIZER_VERSION } from "./tokenize";

describe("tokenizer", () => {
  it("is versioned", () => expect(TOKENIZER_VERSION).toMatch(/^tokenize\/\d+\.\d+\.\d+$/));

  it("lower-cases, splits on punctuation and keeps digits", () => {
    expect(tokenize("Step 1: Compare the OBSERVED counts, (week 36)!")).toEqual(["step", "1", "compare", "the", "observed", "counts", "week", "36"]);
  });

  it("splits hyphens and apostrophes and claims no stemming", () => {
    expect(tokenize("pre-monsoon don't diarrhoeal")).toEqual(["pre", "monsoon", "don", "t", "diarrhoeal"]);
    expect(tokenize("cases case")).toEqual(["cases", "case"]);
  });

  it("folds compatibility forms with NFKC (full-width letters, ligatures) and is idempotent", () => {
    expect(tokenize("ｆｅｖｅｒ ﬁeld")).toEqual(["fever", "field"]);
    expect(normalizeText(normalizeText("ＡＢＣ"))).toBe(normalizeText("ＡＢＣ"));
  });

  it("is locale independent (no Turkish dotted-I surprises)", () => {
    expect(tokenize("DIARRHOEA I")).toEqual(["diarrhoea", "i"]);
  });

  it("keeps Hindi words whole, including vowel signs and viraama", () => {
    expect(tokenize("तीव्र दस्त रोग समूह की पुष्टि।")).toEqual(["तीव्र", "दस्त", "रोग", "समूह", "की", "पुष्टि"]);
  });

  it("keeps Odia words whole", () => {
    expect(tokenize("ଜ୍ୱର ମାମଲାର ସଂଖ୍ୟା ଯାଞ୍ଚ କରନ୍ତୁ।")).toEqual(["ଜ୍ୱର", "ମାମଲାର", "ସଂଖ୍ୟା", "ଯାଞ୍ଚ", "କରନ୍ତୁ"]);
  });

  it("handles mixed scripts, digits in Indic numerals and emoji", () => {
    expect(tokenize("चरण 1: fever ज्वर \u{1F600} ३६")).toEqual(["चरण", "1", "fever", "ज्वर", "३६"]);
  });

  it("returns nothing for empty, whitespace or punctuation-only input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("  \n\t ")).toEqual([]);
    expect(tokenize("... --- !!!")).toEqual([]);
  });

  it("orders distinct terms by code point, not by locale", () => {
    expect(distinctSorted(["b", "a", "b", "é", "z", "A"])).toEqual(["A", "a", "b", "z", "é"]);
    expect(compareCodePoints("a", "b")).toBe(-1);
    expect(compareCodePoints("b", "b")).toBe(0);
  });
});

/** An independent, deliberately naive BM25: recomputes every statistic from scratch for every (doc, term) pair. */
function referenceBm25(docs: Array<{ key: string; tokens: string[] }>, query: string[], k1 = 1.2, b = 0.75): Map<string, number> {
  const N = docs.length;
  const avgdl = docs.reduce((s, d) => s + d.tokens.length, 0) / N;
  const out = new Map<string, number>();
  const terms = query.filter((t, i) => query.indexOf(t) === i);
  for (const d of docs) {
    let s = 0;
    for (const t of terms) {
      const tf = d.tokens.filter((x) => x === t).length;
      if (tf === 0) continue;
      const n = docs.filter((o) => o.tokens.includes(t)).length;
      const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
      s += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.tokens.length) / avgdl)));
    }
    if (s > 0) out.set(d.key, s);
  }
  return out;
}

describe("BM25: golden fixture (values derived by hand, outside the library)", () => {
  const docs: Bm25Doc[] = [
    { key: "d1", tokens: ["diarrhoea", "outbreak", "diarrhoea", "water"] },
    { key: "d2", tokens: ["water", "safety", "sanitation"] },
    { key: "d3", tokens: ["fever", "surveillance", "method"] },
    { key: "d4", tokens: ["diarrhoea"] },
  ];
  const index = new Bm25Index(docs);

  it("uses the approved parameters", () => {
    expect(BM25_K1).toBe(1.2);
    expect(BM25_B).toBe(0.75);
  });

  it("matches the hand-derived statistics and scores", () => {
    expect(index.avgdl).toBe(2.75);
    expect(index.idf("diarrhoea")).toBeCloseTo(0.6931471805599453, 14); // ln 2: N=4, n=2
    expect(index.idf("fever")).toBeCloseTo(1.2039728043259361, 14);
    const hits = new Map(index.search(["diarrhoea", "water"]).map((h) => [h.key, h.score]));
    expect(hits.get("d1")).toBe(1.42951149986);
    expect(hits.get("d2")).toBe(0.668293297592);
    expect(hits.get("d4")).toBe(0.937104009472);
    expect(hits.has("d3")).toBe(false); // no query term: not a candidate
  });

  it("reports which terms matched, with their frequencies", () => {
    const d1 = index.search(["diarrhoea", "water"]).find((h) => h.key === "d1")!;
    expect(d1.matched.map((m) => [m.term, m.tf])).toEqual([["diarrhoea", 2], ["water", 1]]);
  });

  it("handles a single-document index", () => {
    const one = new Bm25Index([{ key: "x", tokens: ["a", "a", "b"] }]);
    expect(one.search(["a"])[0].score).toBe(0.395562849621);
    expect(one.idf("a")).toBeCloseTo(0.28768207245178085, 14);
  });
});

describe("BM25: equivalence with an independent reference", () => {
  const rng = (seed: number) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const VOCAB = ["fever", "rash", "water", "cluster", "line", "list", "सर्दी", "ज्वर", "monsoon", "case", "report", "block", "ଜ୍ୱର"];

  it("agrees on 300 random corpora and queries (including duplicate query terms)", () => {
    const next = rng(4242);
    for (let trial = 0; trial < 300; trial += 1) {
      const n = 1 + Math.floor(next() * 12);
      const docs = Array.from({ length: n }, (_, i) => ({
        key: `doc-${String(i).padStart(2, "0")}`,
        tokens: Array.from({ length: 1 + Math.floor(next() * 25) }, () => VOCAB[Math.floor(next() * VOCAB.length)]),
      }));
      const query = Array.from({ length: 1 + Math.floor(next() * 6) }, () => VOCAB[Math.floor(next() * VOCAB.length)]);
      const ref = referenceBm25(docs, query);
      const got = new Map(new Bm25Index(docs).search(query).map((h) => [h.key, h.score]));
      expect([...got.keys()].sort()).toEqual([...ref.keys()].sort());
      for (const [k, v] of ref) expect(got.get(k)!, `trial ${trial} ${k}`).toBeCloseTo(v, 9);
    }
  });

  it("agrees with the reference for non-default parameters", () => {
    const docs = [
      { key: "a", tokens: ["x", "y", "x"] },
      { key: "b", tokens: ["y", "z"] },
      { key: "c", tokens: ["x", "z", "z", "z", "w"] },
    ];
    for (const [k1, b] of [[0, 0.75], [2, 0.3], [1.2, 0], [1.2, 1]]) {
      const ref = referenceBm25(docs, ["x", "z"], k1, b);
      const got = new Map(new Bm25Index(docs, { k1, b }).search(["x", "z"]).map((h) => [h.key, h.score]));
      for (const [key, v] of ref) expect(got.get(key)!, `k1=${k1} b=${b}`).toBeCloseTo(v, 9);
    }
  });
});

describe("BM25: edge cases", () => {
  const docs: Bm25Doc[] = [
    { key: "a", tokens: ["fever", "fever", "cluster"] },
    { key: "b", tokens: ["fever", "water"] },
    { key: "c", tokens: ["water", "sanitation", "monsoon", "rain", "flood"] },
  ];

  it("returns nothing for an empty query, an empty index, or a query that matches nothing", () => {
    expect(new Bm25Index(docs).search([])).toEqual([]);
    expect(new Bm25Index([]).search(["fever"])).toEqual([]);
    expect(new Bm25Index(docs).search(["absent", "missing"])).toEqual([]);
    expect(new Bm25Index([{ key: "e", tokens: [] }]).search(["fever"])).toEqual([]);
  });

  it("counts duplicate query terms once", () => {
    const once = new Bm25Index(docs).search(["fever"]);
    const many = new Bm25Index(docs).search(["fever", "fever", "fever"]);
    expect(many).toEqual(once);
  });

  it("is independent of query term order", () => {
    const a = new Bm25Index(docs).search(["fever", "water", "cluster"]);
    const b = new Bm25Index(docs).search(["cluster", "water", "fever"]);
    expect(a).toEqual(b);
  });

  it("is independent of document order (scores keyed by document, output sorted by key)", () => {
    const a = new Bm25Index(docs).search(["fever", "water"]);
    const b = new Bm25Index([...docs].reverse()).search(["fever", "water"]);
    expect(b).toEqual(a);
  });

  it("gives identical scores to identical documents (so ties are exact, not noisy)", () => {
    const twins = new Bm25Index([
      { key: "t1", tokens: ["fever", "water", "cluster"] },
      { key: "t2", tokens: ["fever", "water", "cluster"] },
      { key: "o", tokens: ["rain"] },
    ]).search(["fever", "cluster"]);
    expect(twins[0].score).toBe(twins[1].score);
  });

  it("keeps idf positive even for a term present in every document", () => {
    const idx = new Bm25Index([{ key: "1", tokens: ["a"] }, { key: "2", tokens: ["a", "b"] }]);
    expect(idx.idf("a")).toBeGreaterThan(0);
    expect(idx.search(["a"]).every((h) => h.score > 0)).toBe(true);
  });

  it("saturates term frequency and penalises length", () => {
    const idx = new Bm25Index([
      { key: "tf1", tokens: ["fever", "x", "x", "x", "x"] },
      { key: "tf10", tokens: ["fever", "fever", "fever", "fever", "fever", "fever", "fever", "fever", "fever", "fever"] },
      { key: "short", tokens: ["fever"] },
      { key: "long", tokens: ["fever", ...Array(30).fill("pad")] },
    ]);
    const s = new Map(idx.search(["fever"]).map((h) => [h.key, h.score]));
    expect(s.get("tf10")!).toBeLessThan(10 * s.get("tf1")!);
    expect(s.get("short")!).toBeGreaterThan(s.get("long")!);
  });

  it("rejects invalid parameters", () => {
    expect(() => new Bm25Index(docs, { k1: -1, b: 0.5 })).toThrow(RangeError);
    expect(() => new Bm25Index(docs, { k1: 1.2, b: 1.5 })).toThrow(RangeError);
  });

  it("works on Hindi and Odia text end to end (tokeniser + scorer)", () => {
    const corpus = [
      { key: "hi1", text: "तीव्र दस्त रोग के समूह की पुष्टि के चरण" },
      { key: "hi2", text: "मौसमी स्तर से गिनती की तुलना करें" },
      { key: "or1", text: "ଜ୍ୱର ମାମଲାର ସଂଖ୍ୟା ଯାଞ୍ଚ କରନ୍ତୁ" },
    ].map((d) => ({ key: d.key, tokens: tokenize(d.text) }));
    const idx = new Bm25Index(corpus);
    expect(idx.search(tokenize("दस्त रोग")).map((h) => h.key)).toEqual(["hi1"]);
    expect(idx.search(tokenize("ଜ୍ୱର")).map((h) => h.key)).toEqual(["or1"]);
    expect(idx.search(tokenize("fever")).length).toBe(0); // no cross-lingual retrieval is claimed
  });

  it("rounds scores to a fixed precision so last-bit noise cannot reorder results", () => {
    expect(roundScore(0.1 + 0.2)).toBe(0.3);
    expect(roundScore(0)).toBe(0);
  });

  it("reports query statistics (document frequency and idf) in code-point order", () => {
    const st = new Bm25Index(docs).stats(["water", "fever", "absent"]);
    expect(st.docs).toBe(3);
    expect(st.df.map((d) => [d.term, d.df])).toEqual([["absent", 0], ["fever", 2], ["water", 2]]);
  });
});
