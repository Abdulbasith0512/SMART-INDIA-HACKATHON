// Deterministic controlled query builder: SignalFacts -> one query per facet. No model, no free text.
//   terms   = facet wording  +  the syndrome's controlled terms (vocab.ts)  +  [regional facet] region names and
//             the calendar season of the signal window  +  optional wording selected by signal characteristics
//   tokens  = the distinct tokens of those terms, in code-point order (the canonical form that is scored/hashed)
//   topics  = the controlled topics the facet may match (metadata filter), from vocab.ts
// Identical SignalFacts => byte-identical query => identical queryHash.
import { hashJson } from "../hash";
import { QUERY_FACETS, QUERY_VOCAB_VERSION, SYNDROME_QUERY, type QueryFacet } from "../vocab";
import { FACET_BASE_TERMS, PERSISTENCE_TERMS, QUERY_CONFIG_VERSION, QUERY_STOP_WORDS, SEASON_TERMS, SPREAD_TERMS, seasonOf } from "./queryConfig";
import type { SignalFacts } from "./signal";
import { compareCodePoints, distinctSorted, tokenize } from "./tokenize";

export const QUERY_SCHEMA = "retrieval-query/1";

export interface FacetQuery {
  facet: QueryFacet;
  topics: string[];
  /** Human-readable terms/phrases, in construction order, de-duplicated. */
  terms: string[];
  /** Canonical scored form: distinct tokens in code-point order. */
  tokens: string[];
  /** Where the terms came from (for the audit trail; never used for scoring). */
  sources: { facet: string[]; syndrome: string[]; region: string[]; season: string[]; characteristics: string[] };
}

export interface RetrievalQuery {
  schema: typeof QUERY_SCHEMA;
  vocabVersion: string;
  configVersion: string;
  signalId: string;
  syndrome: string;
  asOfDate: string;
  facets: FacetQuery[];
  queryHash: string;
}

const STOP: ReadonlySet<string> = new Set(QUERY_STOP_WORDS);

const uniq = (xs: readonly string[]): string[] => {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
};

function regionNames(facts: SignalFacts): string[] {
  const names = [facts.region.name, ...facts.ancestors.filter((a) => a.level === "state" || a.level === "district").map((a) => a.name), ...facts.involved_blocks.map((b) => b.name)];
  return uniq(names.map((n) => n.trim()).filter(Boolean)).sort(compareCodePoints);
}

export function buildFacetQuery(facts: SignalFacts, facet: QueryFacet, asOfDate: string): FacetQuery {
  const spec = SYNDROME_QUERY[facts.syndrome];
  if (!spec) throw new Error(`unsupported syndrome: ${facts.syndrome}`);
  const sources: FacetQuery["sources"] = { facet: [...FACET_BASE_TERMS[facet]], syndrome: [...spec.terms], region: [], season: [], characteristics: [] };
  if (facet === "regional_context") {
    sources.region = regionNames(facts);
    sources.season = [...SEASON_TERMS[seasonOf(asOfDate)]];
  }
  sources.characteristics = [...(SPREAD_TERMS[facts.spread][facet] ?? []), ...(PERSISTENCE_TERMS[facts.persistence][facet] ?? [])];
  const terms = uniq([...sources.facet, ...sources.syndrome, ...sources.region, ...sources.season, ...sources.characteristics]);
  return {
    facet,
    topics: [...spec.topics[facet]].sort(compareCodePoints),
    terms,
    tokens: distinctSorted(tokenize(terms.join(" ")).filter((t) => !STOP.has(t))),
    sources,
  };
}

export function buildQuery(facts: SignalFacts, opts: { asOfDate?: string } = {}): RetrievalQuery {
  const asOfDate = opts.asOfDate ?? facts.window.end;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) throw new RangeError(`asOfDate must be YYYY-MM-DD: ${asOfDate}`);
  const body = {
    schema: QUERY_SCHEMA,
    vocabVersion: QUERY_VOCAB_VERSION,
    configVersion: QUERY_CONFIG_VERSION,
    signalId: facts.signal_id,
    syndrome: facts.syndrome,
    asOfDate,
    facets: QUERY_FACETS.map((f) => buildFacetQuery(facts, f, asOfDate)),
  };
  return { ...body, queryHash: hashJson(body) } as RetrievalQuery;
}
