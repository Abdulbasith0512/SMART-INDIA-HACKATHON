// @vitest-environment node
import { describe, expect, it } from "vitest";
import { hashJson } from "../hash";
import { RETRIEVAL_CONFIG_DEV, RETRIEVAL_CONFIG_V1, RETRIEVAL_VERSION, makeRetrievalConfig, retrievalConfigHash, type RetrievalConfig } from "./config";

/**
 * Pinned on purpose (like the frozen M3 config hash): any change to retrieval behaviour changes the hash, and
 * updating the pin is a deliberate, reviewed act.
 */
const GOLDEN_HASH_PRODUCTION = "1e0705bdeec1d940159da695bf27814f68c6339a69636d9e34c211c1a24903b1";
const GOLDEN_HASH_DEV = "029b517ac9986c47588303c98a594a2fc9819371f3f3f201f3e199894bccda7f";

const clone = (c: RetrievalConfig): RetrievalConfig => JSON.parse(JSON.stringify(c));

describe("retrieval configuration", () => {
  it("states the approved BM25 parameters and the version of every component", () => {
    const c = RETRIEVAL_CONFIG_V1;
    expect(c.version).toBe(RETRIEVAL_VERSION);
    expect(c.bm25.k1).toBe(1.2);
    expect(c.bm25.b).toBe(0.75);
    expect(c.tokenization.version).toMatch(/^tokenize\//);
    expect(c.tokenization.stemming).toBe("none");
    expect(c.queryVocabulary.version).toBe("query-vocab/1.0.0");
    expect(c.queryVocabulary.configVersion).toMatch(/^query-config\//);
    expect(c.eligibility.version).toMatch(/^eligibility\//);
    expect(c.tieBreak.version).toMatch(/^tiebreak\//);
    expect(c.tieBreak.order).toEqual(["bm25_score_desc", "canonical_id_asc", "chunk_ordinal_asc", "chunk_id_asc"]);
  });

  it("makes synthetic documents opt-in: off in the production config, on in the development config", () => {
    expect(RETRIEVAL_CONFIG_V1.eligibility.allowSynthetic).toBe(false);
    expect(RETRIEVAL_CONFIG_DEV.eligibility.allowSynthetic).toBe(true);
  });

  it("is a pure function of its inputs: the same configuration always has the same hash", () => {
    expect(retrievalConfigHash(makeRetrievalConfig({ allowSynthetic: false }))).toBe(retrievalConfigHash(makeRetrievalConfig({ allowSynthetic: false })));
    expect(retrievalConfigHash(clone(RETRIEVAL_CONFIG_V1))).toBe(retrievalConfigHash(RETRIEVAL_CONFIG_V1));
    for (let i = 0; i < 50; i += 1) expect(retrievalConfigHash(RETRIEVAL_CONFIG_DEV)).toBe(GOLDEN_HASH_DEV);
  });

  it("does not depend on key order", () => {
    const reversed = Object.fromEntries(Object.entries(RETRIEVAL_CONFIG_V1).reverse()) as unknown as RetrievalConfig;
    expect(retrievalConfigHash(reversed)).toBe(retrievalConfigHash(RETRIEVAL_CONFIG_V1));
  });

  it("matches the pinned golden hashes", () => {
    expect(retrievalConfigHash(RETRIEVAL_CONFIG_V1)).toBe(GOLDEN_HASH_PRODUCTION);
    expect(retrievalConfigHash(RETRIEVAL_CONFIG_DEV)).toBe(GOLDEN_HASH_DEV);
    expect(GOLDEN_HASH_PRODUCTION).not.toBe(GOLDEN_HASH_DEV);
  });

  it("is a 64-hex SHA-256 over canonical JSON", () => {
    expect(retrievalConfigHash(RETRIEVAL_CONFIG_V1)).toMatch(/^[0-9a-f]{64}$/);
    expect(retrievalConfigHash(RETRIEVAL_CONFIG_V1)).toBe(hashJson(RETRIEVAL_CONFIG_V1));
  });

  it("changes when ANY behaviour-relevant setting changes", () => {
    const base = retrievalConfigHash(RETRIEVAL_CONFIG_V1);
    const mutations: Array<[string, (c: RetrievalConfig) => void]> = [
      ["k1", (c) => (c.bm25.k1 = 1.3)],
      ["b", (c) => (c.bm25.b = 0.7)],
      ["idf form", (c) => (c.bm25.idf = "ln(N/n)")],
      ["tokenizer version", (c) => (c.tokenization.version = "tokenize/9.9.9")],
      ["normalization", (c) => (c.tokenization.normalization = "NFC")],
      ["query vocabulary version", (c) => (c.queryVocabulary.version = "query-vocab/9.9.9")],
      ["query config version", (c) => (c.queryVocabulary.configVersion = "query-config/9.9.9")],
      ["query stop words", (c) => (c.queryVocabulary.queryStopWords = [...c.queryVocabulary.queryStopWords, "extra"])],
      ["eligibility version", (c) => (c.eligibility.version = "eligibility/9.9.9")],
      ["statuses", (c) => (c.eligibility.statuses = ["current", "historical"])],
      ["minimum trust", (c) => (c.eligibility.minTrust = "trusted")],
      ["excluded classes", (c) => (c.eligibility.excludedSourceClasses = [])],
      ["languages", (c) => (c.eligibility.languages = ["en", "hi"])],
      ["synthetic opt-in", (c) => (c.eligibility.allowSynthetic = true)],
      ["fetch statuses", (c) => (c.eligibility.excludedFetchStatuses = [])],
      ["look-ahead rule", (c) => (c.eligibility.temporal.noLookAhead = false)],
      ["expiry kinds", (c) => (c.eligibility.temporal.expiryKinds = [])],
      ["tie-break order", (c) => (c.tieBreak.order = ["chunk_id_asc", "bm25_score_desc"])],
      ["score precision", (c) => (c.tieBreak.scorePrecision = 10)],
      ["retrieval version", (c) => (c.version = "retrieval/9.9.9")],
    ];
    const seen = new Set<string>([base]);
    for (const [name, mutate] of mutations) {
      const c = clone(RETRIEVAL_CONFIG_V1);
      mutate(c);
      const h = retrievalConfigHash(c);
      expect(h, name).not.toBe(base);
      seen.add(h);
    }
    expect(seen.size).toBe(mutations.length + 1); // every mutation yields a distinct hash
  });
});
