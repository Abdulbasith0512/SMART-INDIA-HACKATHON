# M4.2 - Deterministic evidence retrieval

Scope of this milestone: **retrieval only.** A stored M3 signal becomes a controlled query; metadata rules decide
which evidence may compete; in-process BM25 scores the eligible text; the candidates come back in a fully
deterministic order. Ranking factors, deduplication, diversity, conflicts, gaps, bundles, citations and any model
use belong to M4.3 and later and are deliberately absent. Nothing here changes M1-M3 or the frozen M3 detector.

```
stored M3 candidate ──> SignalFacts (strict, minimal) ──> controlled query (4 facets)
                                                              │
   corpus (evidence tables only) ──> metadata eligibility ────┤  FILTER: may this document compete at all?
                                                              ▼
                                                    BM25 over eligible chunks ──> candidates (deterministic order)
```

Retrieval is a **lexical match** engine. A BM25 score orders candidates inside one facet's eligible pool. It is not
a probability, not a measure of truth, not a measure of trustworthiness, and not comparable across facets.

## 1. Files

| File (`src/evidence/retrieval/`) | Role |
|---|---|
| `signal.ts` | `SignalFacts` strict schema; projection from a stored candidate; loader that names its columns |
| `queryConfig.ts` | Versioned query wording, seasons, characteristic variants, query stop words |
| `query.ts` | Deterministic query builder (one query per facet) and its hash |
| `eligibility.ts` | The metadata FILTER (binary rules, all reasons recorded) |
| `corpus.ts` | Read-only corpus view, loader (evidence tables only), content-addressed digest |
| `tokenize.ts`, `bm25.ts` | Script-agnostic tokeniser; Okapi BM25 |
| `config.ts` | Retrieval configuration and its SHA-256 |
| `retrieve.ts` | Pipeline: facts -> query -> eligibility -> BM25 -> candidates; result hash |

CLI: `npm run evidence:retrieve -- --signal=<id> [--synthetic]` (read-only). Live check: `npm run verify:m42`.

## 2. What retrieval may know about a signal (`SignalFacts`)

Only: syndrome; the signal's region and its ancestors (id, name, level); the window as inclusive India-Standard-Time
dates; the names of the involved blocks (already shown to officers); and two coarse characteristics derived from M3
score components - **spread** (`single_block` / `multi_block` / `district_wide` / `unknown`, from involved blocks vs
blocks in the district, threshold 0.5) and **persistence** (`emerging` / `sustained` / `unknown`, from the share of
window days that were elevated, threshold 0.75).

It contains **no counts, scores, p-values, explanation text, reviewer notes, user ids, raw or de-identified rows, names
of people, contact details or coordinates.** The schema is strict, so an extra field is rejected rather than carried
along; the loader reads a named list of seven candidate columns and never `select *`. Tests prove the facts contain no
numbers at all, and that the retrieval source never references report, observation, aggregate, role, profile or audit
data, never touches the network or the environment, and is not importable from the browser.

## 3. Query construction (`retrieval-query/1`)

Four facets (`verification_guidance`, `case_definition`, `epidemiological_context`, `regional_context`). For each:

- **topics** (metadata filter): the M4.0 syndrome -> topic map in `vocab.ts` (`QUERY_VOCAB_VERSION = query-vocab/1.0.0`).
- **terms**: facet wording (`queryConfig.ts`, `QUERY_CONFIG_VERSION = query-config/1.0.0`) + the syndrome's controlled
  terms (`vocab.ts`) + for `regional_context` the state/district/involved-block names and the calendar season of the
  window (IMD convention; a calendar mapping, not weather) + optional wording chosen by spread/persistence.
- **tokens**: the distinct tokens of the terms in code-point order, minus a small versioned English function-word list
  (`QUERY_STOP_WORDS`, query side only - documents are always indexed in full).

Identical facts -> byte-identical query -> identical `queryHash`. Golden hashes for every syndrome are pinned in tests.
No model, no free text, no user input.

## 4. Metadata eligibility (FILTER, not RANK)

A document competes for a facet only if **all** of these hold; every failing reason is recorded (sorted):

| Rule | Reason code |
|---|---|
| status is `current` (quarantined, draft, withdrawn, superseded, historical never compete) | `status_not_eligible` |
| trust at least `reviewed` | `trust_below_minimum` |
| source class is not `unverified` | `source_class_excluded` |
| synthetic documents only if the configuration opts in | `synthetic_not_allowed` |
| has a current version with text; last link check not `changed`/`unreachable` | `no_current_version`, `no_chunks`, `source_check_failed` |
| language is one the query vocabulary covers (English now) | `language_not_queryable` |
| topics overlap the facet's controlled topics | `topic_mismatch` |
| names no syndrome (general) or names the signal's syndrome | `syndrome_mismatch` |
| geography: global/regional/national always; **state/district only if it is the signal's own state/district** | `geo_scope_mismatch`, `geo_scope_missing` |
| no look-ahead past the as-of date; not-yet-valid excluded; expired guidance/case definitions excluded | `published_after_as_of`, `not_yet_valid`, `validity_ended` |

Different-state or different-district evidence is excluded, never treated as local; nothing is inferred from names.
The temporal rules are **binary**. Age weighting, source-class weighting and geography weighting are M4.3.
Keyword-stuffed documents compete only if they pass these rules; whether they are presented is M4.3's decision.

The as-of date defaults to the signal window's last day; pass `asOfDate` explicitly for a retrospective run.

## 5. Tokenisation and BM25

Tokeniser (`tokenize/1.0.0`): NFKC, locale-independent lower-casing, tokens are maximal runs of letters, combining
marks and digits in any script. Combining marks are kept, so Devanagari and Odia words stay whole. **No stemming, no
stop-word removal, no transliteration is claimed.** Hyphens and apostrophes split tokens.

BM25: `k1 = 1.2`, `b = 0.75`;
`idf = ln(1 + (N - n + 0.5) / (n + 0.5))`; `score = sum_t idf * tf * (k1+1) / (tf + k1 * (1 - b + b * |d| / avgdl))`.
N, n and avgdl are measured over the **eligible chunks of that facet**. Duplicate query terms count once; terms are
summed in code-point order; scores are rounded to 12 significant digits so floating-point noise cannot reorder
results. Verified against hand-derived golden values and against an independent naive reference on 300 random
corpora, and end to end against the reference on every syndrome x facet.

## 6. Deterministic order

`bm25 score desc -> canonical_id asc (row id if absent) -> chunk ordinal asc -> chunk id asc`. The order uses only
stable identifiers - never row order. Using `canonical_id` before the database UUID means two databases holding the
same corpus produce the same order even though their UUIDs differ (an exact duplicate sorts by canonical id).

## 7. Configuration and hashes

`retrieval/1.0.0` bundles BM25 parameters, tokeniser, query vocabulary + config versions + stop words, the eligibility
policy (statuses, trust floor, languages, synthetic opt-in, temporal rules) and the tie-break policy. Its canonical
SHA-256 is the `config.hash` on every result. The production configuration excludes synthetic documents;
`RETRIEVAL_CONFIG_DEV` opts in.

| Hash | Value |
|---|---|
| production config | `1e0705bdeec1d940159da695bf27814f68c6339a69636d9e34c211c1a24903b1` |
| development config | `029b517ac9986c47588303c98a594a2fc9819371f3f3f201f3e199894bccda7f` |

Every result also carries `query.hash`, `corpus.digest` (content-addressed over exactly what retrieval could see; no
UUIDs, no timestamps), the active corpus snapshot if any, and `resultHash` (content-addressed fingerprint of the
candidates). Same signal + same corpus content + same configuration = same everything, across repeated runs,
shuffled inputs, physically rewritten rows, and a second database with different ids.

## 8. Candidate provenance (input to M4.3)

Per candidate: facet, rank, item/version/chunk ids, canonical id, version content hash, chunk ordinal/kind/hash/
language, text, BM25 score, matched terms (term, tf, idf), and the metadata M4.3 will weigh (title, publisher, source
class, evidence kind, trust, topics, syndromes, geo scope/region and `geoMatch`, dates, synthetic flag, supersedes).
No M4.3 factor is computed or implied.

## 9. Known limits (stated, not hidden)

- **Lexical only.** A relevant chunk that shares no query term (e.g. an excerpt that never names the syndrome) is not
  retrieved. How often this happens on real documents is unmeasured; the synthetic corpus cannot tell us.
- **English only.** Hindi and Odia documents are excluded (`language_not_queryable`); the tokeniser handles those
  scripts and is tested, but no Hindi/Odia vocabulary exists, and no cross-lingual retrieval is claimed.
- **Per-facet statistics over small pools** make IDF coarse; scores are not comparable across facets or corpora.
- **No title or topic boost** in M4.2: topics are a hard filter only. Any boost is an M4.3 policy decision.
- Spread/persistence thresholds, the season mapping and the query stop-word list are fixed policy choices, not
  estimates, and are part of the config hash so changes are visible.
- A generic query token can make an eligible but unhelpful document a weak candidate; M4.3 and a relevance floor, not
  M4.2, decide what is presented.
- `canonical_id` uniqueness is an ingestion convention (no unique index); tie-breaking falls back to the row id.
- Results on the synthetic corpus show the pipeline is correct and deterministic, **not** that retrieval quality is
  good on real evidence. Relevance judgments on a real, curator-built corpus remain required follow-up work.
