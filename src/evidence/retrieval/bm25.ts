// In-process Okapi BM25. Pure, deterministic and independent of the database.
//
//   score(q, d) = sum over DISTINCT query terms t of  idf(t) * tf(t,d) * (k1 + 1) / ( tf(t,d) + k1 * (1 - b + b * |d| / avgdl) )
//   idf(t)      = ln( 1 + (N - n_t + 0.5) / (n_t + 0.5) )          (Lucene form: always > 0, defined for any n_t <= N)
//
// N, n_t and avgdl are measured over the documents handed to the index (in M4.2: the chunks that passed the
// metadata eligibility filter for that facet). Parameters are k1 = 1.2 and b = 0.75.
// A BM25 score is a lexical-match strength used to ORDER candidates. It is not a probability, not a measure of
// relevance to truth, and not comparable across different indexes or facets.
//
// Determinism: terms are summed in code-point order and the result is returned sorted by the caller-supplied
// key, so the order of the input documents never leaks into results. Scores are rounded to SCORE_PRECISION
// significant digits so that last-bit floating-point noise can never reorder candidates.
import { compareCodePoints, distinctSorted } from "./tokenize";

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
export const SCORE_PRECISION = 12;

export interface Bm25Params {
  k1: number;
  b: number;
}
export const DEFAULT_PARAMS: Bm25Params = { k1: BM25_K1, b: BM25_B };

export interface Bm25Doc {
  /** Opaque unique key supplied by the caller (used only to key results). */
  key: string;
  tokens: readonly string[];
}

export interface TermMatch {
  term: string;
  tf: number;
  idf: number;
}

export interface Bm25Hit {
  key: string;
  score: number;
  matched: TermMatch[];
}

export interface IndexStats {
  docs: number;
  avgdl: number;
  /** document frequency of each QUERIED term, in code-point order */
  df: Array<{ term: string; df: number; idf: number }>;
}

export const roundScore = (x: number): number => (x === 0 ? 0 : Number(x.toPrecision(SCORE_PRECISION)));

export class Bm25Index {
  private readonly tf: Map<string, number>[];
  private readonly len: number[];
  private readonly df = new Map<string, number>();
  readonly avgdl: number;

  constructor(private readonly docs: readonly Bm25Doc[], private readonly params: Bm25Params = DEFAULT_PARAMS) {
    if (!(params.k1 >= 0) || !(params.b >= 0 && params.b <= 1)) throw new RangeError("invalid BM25 parameters");
    this.tf = docs.map((d) => {
      const m = new Map<string, number>();
      for (const t of d.tokens) m.set(t, (m.get(t) ?? 0) + 1);
      return m;
    });
    this.len = docs.map((d) => d.tokens.length);
    for (const m of this.tf) for (const t of m.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgdl = docs.length ? this.len.reduce((a, b) => a + b, 0) / docs.length : 0;
  }

  get size(): number {
    return this.docs.length;
  }

  idf(term: string): number {
    const n = this.df.get(term) ?? 0;
    return Math.log(1 + (this.docs.length - n + 0.5) / (n + 0.5));
  }

  stats(queryTokens: readonly string[]): IndexStats {
    return {
      docs: this.docs.length,
      avgdl: this.avgdl,
      df: distinctSorted(queryTokens).map((term) => ({ term, df: this.df.get(term) ?? 0, idf: roundScore(this.idf(term)) })),
    };
  }

  /**
   * Score every document that matches at least one query term. Duplicate query terms count once.
   * The result is sorted by key (a neutral, input-order-independent order); callers apply their own tie-break.
   */
  search(queryTokens: readonly string[]): Bm25Hit[] {
    const terms = distinctSorted(queryTokens);
    if (!terms.length || !this.docs.length || this.avgdl === 0) return [];
    const { k1, b } = this.params;
    const idfs = terms.map((t) => this.idf(t));
    const hits: Bm25Hit[] = [];
    this.docs.forEach((doc, i) => {
      const dl = this.len[i];
      if (dl === 0) return;
      let score = 0;
      const matched: TermMatch[] = [];
      terms.forEach((term, j) => {
        const f = this.tf[i].get(term) ?? 0;
        if (f === 0) return;
        score += (idfs[j] * f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl) / this.avgdl));
        matched.push({ term, tf: f, idf: roundScore(idfs[j]) });
      });
      if (matched.length) hits.push({ key: doc.key, score: roundScore(score), matched });
    });
    return hits.sort((x, y) => compareCodePoints(x.key, y.key));
  }
}
