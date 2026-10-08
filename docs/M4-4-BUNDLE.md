# M4.4 - Canonical evidence bundle and deterministic extractive fallback

Scope: package what M4.2 retrieved and M4.3 prioritised into one **canonical, hashable, auditable evidence bundle**,
store it in the M4.0 tables, and produce a deterministic **extractive fallback** that uses no model. Any LLM call,
prompt, generated explanation, embedding, UI and automatic verification are later milestones and are absent. Nothing
changes M1-M3, the frozen M3 detector, the M4.0/M4.1/M4.3 migrations, the M4.2 algorithm or the M4.3 ranking (the M4.2
and M4.3 hashes are unchanged and asserted). **No migration was needed**: every invariant fits the M4.0 tables.

```
M3 detects -> M4.2 retrieves -> M4.3 prioritises evidence -> M4.4 packages it -> M4.5 explains it -> a human verifies
```

> The bundle is **data for a human verifier**. It never says a signal is real, never names a disease as a cause, and
> never advises treatment. `rank_score` inside it is presentation priority for a verifier, **not the probability that an
> evidence item is correct** (the bundle carries that notice in `notice`).

## 1. What a bundle is

`schema_version = "evidence-bundle/1"`. Keys (all snake_case):

| Key | Content |
|---|---|
| `schema_version`, `bundle_hash`, `notice` | schema id; SHA-256 of the canonical JSON (see 2); the presentation-priority statement |
| `signal` | `candidate_id`, `episode_key`, `region{id,name,level,district,state}`, `syndrome`, `window{start,end}`, `detector_version` - officer-visible aggregate facts only (no counts, no free text) |
| `corpus` | `snapshot_id`, `corpus_hash` (the snapshot), `corpus_digest` (content-addressed digest of exactly what retrieval could see; independent of database ids) |
| `config` | `retrieval_version`, `retrieval_config_hash`, `query_vocab_version`, `query_config_version`, `ranking_version`, `ranking_config_hash`, `as_of_date` |
| `provenance` | `query_hash`, `retrieval_result_hash`, `historical_retrieval_result_hash`, `ranking_hash` (all content-addressed) |
| `facets[4]` | always the four facets, in fixed order, never merged: `verification_guidance`, `case_definition`, `epidemiological_context`, `regional_context`. Each: `name`, `query_terms`, `query_topics`, `gaps`, `items[]` |
| `facets[].items[]` | `citation_id`, `rank`, `evidence_item_id`, `evidence_version_id`, `chunk_id`, `chunk_ordinal`, `chunk_hash`, `version_content_hash`, `canonical_id`, `evidence_kind`, `is_synthetic`, `tier{source_class,label,position}`, `geo_level`, `temporal_status{rule,reason,age_days,factor}`, `score_components`, `why_relevant[]`, `excerpt` |
| `citations[]` | one row per citation id: `citation_id`, `section` (`main`/`historical_context`), the ids it stands for, `appears_in[{facet,rank}]` |
| `historical_context[]` | superseded / historical documents shown for context only (M4.3 rules), numbered after the main items |
| `conflicts[]` | `kind: "curator_tagged_conflict"`, `question_key`, `positions[{position, documents[{..., citation_ids}]}]`, `basis: "curator_tags"`, `note` |
| `gaps[]` | M4.3's gaps exactly (no new categories). An empty result carries `no_eligible_evidence` |
| `excluded[]` | M4.3's full exclusion log: `id` (chunk id), `reason`, `family`, `facet`, `section`, `candidate`, `bm25_score`, `score_components`, `detail` (with the retained candidate for duplicates) |
| `retrieval_exclusions` | M4.2's eligibility exclusions (counts and reasons) |
| `stats` | `eligible_candidates`, `selected_chunks`, `selected_slots`, `selected_documents`, `excluded_candidates`, `exclusions_by_reason`, `facets_covered/total`, `gaps`, `conflicts`, `historical_context_items`, `selected_synthetic/non_synthetic`, `tier_distribution` - no timestamps |
| `retrieved_at` | metadata only; **not** part of the hash |

Titles, publishers, URLs and publication dates are **not** copied into selected items or citations. They are
rendered from the database through the stored ids (see 6). The only descriptive metadata inside a bundle is the
`publisher` inside M4.3's exclusion records, which is how a publisher-diversity exclusion is explained.

## 2. Canonical serialisation and the bundle hash

`bundle_hash = SHA-256( canonical JSON of the bundle WITHOUT bundle_hash and retrieved_at )`, so the hash equals the
SHA-256 of the canonical bytes. Canonical JSON: object keys sorted by **code point** (not locale); array order exactly as
built (the builder fixes every array's order; database order is never used); every string and key **NFC-normalised**
(keys that collide after normalisation are rejected); numbers finite and serialised by `JSON.stringify` (`-0` becomes
`0`; non-finite, `undefined`, functions, bigint and symbols are rejected); no random ids; no clock values except the
excluded `retrieved_at`.

The same signal, corpus snapshot, retrieval configuration, ranking configuration, vocabulary and as-of date always give
byte-identical canonical JSON and the same hash. The bundle records database ids (evidence item / version / chunk), so
its **bytes are database-specific** by design: two databases loaded in different orders produce the same bundle *after*
mapping ids to content (`canonical_id`, chunk ordinal), the same content-addressed `provenance`, and the same fallback
text. The tests prove each of those.

## 3. Stable citation ids

Ids are `E1, E2, ...`, assigned in **(facet order, rank)** over the main items, then the historical items. **One id per
distinct chunk**: a chunk selected in two facets is the same `E<n>` (its `appears_in` lists both). Every id maps to exactly
one `(evidence_version_id, chunk_id)` and is persisted in `evidence_bundle_items` (unique per bundle, FK-enforced: the
chunk must belong to the version). No random ids, no database order: the numbering is a pure function of the ranking.

## 4. Why-relevant reasons (deterministic)

Fixed templates over facts that already exist in the candidate's metadata or recorded score components, in a fixed
order: topic match, syndrome match (only if the document names the signal's syndrome, or names none and is "general"),
query terms matched (at most 8, then "(+n more)"), lexical match strength, kind of document, regional line (regional facet
only), geographic applicability, source tier (n of 7), temporal applicability. No model, no claim beyond ranking metadata;
tests ban confirm/prove/cause/diagnos*/likely/probab*/treat in every reason.

## 5. Persistence (existing M4.0 tables; service role only; RLS-protected)

| Table | Row written |
|---|---|
| `retrieval_runs` | one provenance row per **created** bundle: queries (facet, topics, terms), configuration hashes, corpus snapshot id, as-of date, `status` running -> succeeded/failed |
| `evidence_bundles` | the canonical bundle JSON, `bundle_hash`, `schema_version`, `item_count`, `gap_count`, `conflict_count`. **Append-only; unique per (signal, bundle_hash)** |
| `evidence_bundle_items` | one row per citation id: `(evidence_version_id, chunk_id)`, primary `facet`/`rank` (historical items: facet `historical_context`), `score_components` (+ `appears_in`, `section`), `why` |
| `generated_explanations` | the extractive fallback: provider `extractive`, model `deterministic-fallback`, `prompt_version = extractive-fallback/1.0.0`, `input_hash = bundle_hash`, **status `fallback_extractive`**, `output`, `validation_report` |
| `explanation_citations` | one row per quoted passage, bound to its bundle item (`quote` = the excerpt, at most 600 characters) |
| `signal_evidence` | the compact mirror (see 7) |

The M4.3 exclusion log, curator-tagged conflicts, gaps and historical context are persisted **inside the bundle JSON**,
exactly as ranked (the table has no column that could hold them separately, and none is needed). Persistence is
**idempotent**: a second persist of the same signal + bundle hash creates nothing. It is also **convergent**: the REST API
has no transaction, so an interrupted write is completed by running the same persist again (missing items, fallback,
citations and mirror are filled in; a run left `failed` by the interruption is marked `succeeded` once the bundle is
complete). Concurrent writers converge through the unique key. `persistBundle` refuses a bundle whose hash does not match
its content, one with no corpus snapshot, and a fallback that fails its own validation.

Row-level security (M4.0, unchanged): runs, bundles, items, explanations and citations are visible exactly where the parent
signal is visible - admins and officers inside the signal's district; not other officers, unscoped officers, clinicians or
citizens. No client (admin included) can insert, update or delete any of these tables.

## 6. The extractive fallback (no model)

Required opening, character for character: **"Evidence relevant to this emerging signal suggests..."** (a single U+2026
ellipsis). Then the signal line, a statement that the passages are quoted exactly as stored, one section per facet (a
facet without evidence says so), each passage as `[E<n>] "<excerpt verbatim>"` followed by its source line, an optional
historical section and conflicts section, the gaps (exactly as the bundle records them) and a closing notice. Source
metadata (title, publisher, URL or citation text, publication date, synthetic marker) is resolved from the **database by
the stored `evidence_version_id`**; a missing row is an error, never invented text.

Everything the fallback itself writes is a fixed template; excerpts, source metadata and gap messages are labelled parts,
so tests prove that its **own wording** never contains diagnosis, cause, outbreak, epidemic, confirmation or treatment
language (`outbreak|epidemic|pandemic|diagnos|confirmed|treat|therap|medicat|prescri|dose|cure|vaccin|caused by|due to|infection|patient`),
while quoting evidence that happens to use such words remains possible (it is quoted data, not the fallback's claim).
Thin evidence (fewer than 3 passages or fewer than 2 facets) says "Limited evidence...". Empty evidence says there is
nothing to quote and quotes nothing. Nine validation checks run before storing (opening, ids exist, excerpts verbatim,
quoted parts are stored excerpts, no foreign citation ids, own wording, gaps exact, thin/empty stated, bound to the
bundle). This is the baseline the M4.5 model-written explanation will be evaluated against.

## 7. The `signal_evidence` mirror

A compact convenience copy of the documents the **most recently persisted** bundle cites in its main section (one row per
document, note `Cited in evidence bundle <hash12>: E1 (facet #rank), ...`, at most 480 characters). It is **not the source
of truth**: it can be deleted and rebuilt from the bundle at any time, bundles never read it, and historical (superseded)
documents are never listed. The mirror follows the bundle last persisted - including when a curator reverts a change and
the rebuilt bundle is content-identical to an earlier one (dedup reuses that bundle; the mirror follows it).

## 8. Reference bundle (golden)

Built over the committed SYNTHETIC development corpus with an in-memory snapshot, the default configurations and the
reference signal (acute diarrhoeal illness, Balianta/Khordha/Odisha, 2025-08-31..2025-09-07):

| | |
|---|---|
| `bundle_hash` | `347d388f9b4cd5aa07cf15720386a2dc3167281dd6f80a8c0e5137846f37f97b` (114,471 canonical bytes) |
| Items | 16 citations (E1-E16), 17 facet slots: verification guidance 5, case definition 5, epidemiological context 2, regional context 5 (one chunk is selected in two facets and shares its id) |
| Exclusions | 37, with reasons (7 below relevance floor, 21 beyond top-K, 4 duplicate, 2 document diversity, 1 publisher diversity, 2 superseded in the historical pass) |
| Gaps | `only_synthetic_evidence` |
| Fallback text | `0f3ebd8d5c375d4b90ebe9cdd5d2c371086b5118a684299b7dcd81fc1ae659af` (8,428 characters, 17 quoted passages) |

Pinned inputs: retrieval config `029b517a...bccda7f` (development), ranking config `f288734e...c19d5d`, corpus
`a66e0364...fd497d2`, corpus digest `cbd9f2ab...840014a`. A variant built **without** a snapshot reproduces the frozen
M4.2 result hash `fa55022a...badedd5a` and the frozen M4.3 ranking hash `01f7ac49...fbcf5f`; the bundle stage therefore
changes neither.

## 9. Tests and mutation tests

Unit: canonical serialisation, hashing and its exclusions, golden bundle, byte determinism, row-order independence,
citation-id determinism, facet preservation, provenance, exclusion / conflict / gap persistence, historical context,
reasons, fallback (opening, determinism, verbatim excerpts, metadata from the database, forbidden wording, empty, thin,
conflicts, validation negatives), privacy (static source scans, runtime tripwires, column discipline).
Database (PGlite on the real migrations): persistence, citation integrity, idempotency and recovery from an interruption at
every insert, append-only, mirror, RLS for six kinds of reader, thin/empty/conflict/historical bundles, tamper and
staleness detection, and identity across databases loaded in different orders.

`npm run test:mutation:m44` breaks one invariant at a time in the real source and requires a test to fail: 56 mutants (canonical hashing and its exclusions, NFC, key order, citation numbering and one-id-per-chunk, verbatim excerpts, exclusion / conflict / gap carry-over, snapshot recording, historical numbering and statistics, reasons, every fallback rule and validator, persistence refusals, idempotency, recovery, run status, mirror rules, verification checks). The first run killed 53; the three survivors (flat historical numbering, historical statistics, the per-citation (version, chunk) check in verification) were genuine test gaps, fixed with new tests; all 56 are now killed. Report: `npm run test:mutation:m44` (about 25 minutes, run on a clean tree).

## 10. Known limits (stated, not hidden)

- **Synthetic corpus only.** Nothing here says anything about real-world retrieval quality or evidence correctness.
- `rank_score` is a presentation priority for a verifier. Tiers, geography and time factors are policy choices, not
  learned parameters.
- Bundle bytes include database ids, so a bundle is reproducible per database, and content-reproducible across databases
  (see 2).
- Conflicts exist only where a curator tagged documents; the system never infers one from wording. A future model's
  disagreement notes would use a different `kind`.
- A fallback is as complete as the selected evidence: it does not summarise, explain terminology or synthesise across
  sources - that is what M4.5 is for, and it will be judged against this baseline.
- `loadStoredBundle(signal)` returns the most recently **created** bundle; a bundle reused by dedup (content returned to an
  earlier state) is addressed by hash.
- The REST API has no multi-statement transaction; consistency is by idempotent, convergent writes (tested).
- Audit-log entries written by the generic triggers are append-only system records and remain after test cleanup.

## 11. Validation record

Local: `npm run lint`, `typecheck`, `build`, `check:secrets` pass; `npm test` 1284 tests in 51 files pass (M4.4 adds 180: canonical 13,
bundle assembly 48, reasons 10, fallback 33, privacy 23, database 53); `evidence:verify` (corpus hash unchanged), `evidence:build --check`
and `evidence:sensitivity --check` (hash unchanged) pass; no previous migration, M3 file, M4.2 algorithm or M4.3 ranking file differs
from the M4.3 commit. Live (Supabase, run one at a time): `verify:m1` 43, `m2` 95, `m3` 28, `m41` 31, `m42` 38, `m43` 71, `m44` 96 checks, and
each removed everything it created (the live project holds 0 evidence rows afterwards).

Commands: `npm run evidence:bundle -- --signal=<id> [--synthetic] [--fallback] [--json] [--persist]` (read-only unless `--persist`;
`--persist` needs an active corpus snapshot), `npm run verify:m44`, `npm run test:mutation:m44`.
