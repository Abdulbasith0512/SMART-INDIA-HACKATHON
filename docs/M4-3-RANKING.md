# M4.3 - Deterministic evidence ranking and applicability analysis

Scope: turn M4.2's eligible, lexically matched candidates into an **auditable presentation ranking** for a human
verifier, with deduplication, diversity limits, conflicts, gaps and a complete exclusion log. Evidence bundles,
citations, any model call and any UI are later milestones and are absent. Nothing changes M1-M3, the frozen M3
detector, the M4.0/M4.1 migrations, or the M4.2 algorithm (BM25 parameters, tokeniser, vocabulary, query config and
eligibility are untouched; the M4.2 reference query and result hashes are unchanged).

```
M3 detects -> M4.2 retrieves -> M4.3 prioritises evidence -> M4.4 packages it -> M4.5 explains it -> a human verifies
```

> **The rank score represents presentation priority for a verifier, not the probability that an evidence item is
> correct.** It is not an outbreak probability, not a diagnosis, and not a statement that any source is accurate.
> Every ranking result carries this notice.

## 1. Pipeline

```
M4.2 candidates (per facet)
  -> hard re-checks: source class / geography / time           (excluded with a reason, never down-weighted)
  -> relevance = bm25 / max(bm25 in the facet's rankable set)
  -> relevance floor (0.10)
  -> rank_score = relevance x class_factor x geo_factor x temporal_factor
  -> deduplication (retain the higher-tier, more specific candidate)
  -> diversity (<= 2 chunks per document, <= 3 per publisher) and top-K (5 per facet)
  -> selected evidence      + exclusion log for everything else
cross-facet: conflicts (curator tags), gaps, historical context (separate section)
```

Inputs are only `SignalFacts` (strict, number-free), evidence metadata and the M4.2 candidates. No raw or
de-identified data, no personal identifiers, no network, no model, no secret, no browser import (all enforced by tests).

## 2. The four components

**Relevance** - `bm25 / max(bm25)` over the facet's candidates that survive the hard re-checks. Empty set: nothing.
Single candidate: 1. All-zero: all 0 (never NaN). Ties stay tied; non-finite or negative scores count as 0. It is
**relative**: a facet whose best match is weak still has a top relevance of 1, so the raw BM25 score is always kept
beside it. Scores are rounded to 12 significant digits.

**Source-class factor** - an *ordinal presentation-priority* ladder, not trustworthiness. The order is the M4 plan's
tier order. **The plan fixes the order but gives no numbers ("a small discrete factor"); the spacing below is a policy
choice introduced here** (0.05 per tier, the same span as the geography ladder). It is not estimated and not tuned.

| Class | Tier | Factor |
|---|---|---|
| intergovernmental_health_authority | 1 | 1.00 |
| national_government_health_agency | 2 | 0.95 |
| state_government_health_agency | 3 | 0.90 |
| peer_reviewed_literature | 4 | 0.85 |
| recognized_institution | 5 | 0.80 |
| professional_society_guideline | 6 | 0.75 |
| other_verified | 7 | 0.70 |
| unverified | - | never ranked (excluded by M4.2; re-checked here) |

**Geography factor** - the approved ladder; wrong place is excluded, never down-weighted.

| Evidence scope | Factor |
|---|---|
| the signal's own state or district | 1.0 |
| national | 0.85 |
| regional, global | 0.7 |
| a different state or district, or no scope | **excluded** (`geographic_ineligible`) |

Each candidate records the evidence scope, the signal's geography (region / district / state) and the reason.

**Temporal factor** - the approved rules, applied exactly (newest is not best):
hard exclusions - not current (`withdrawn`, `superseded`, `historical`, other), published after the as-of date
(`look_ahead`), `not_yet_valid`, and expired guidance / case definitions (`expired`). Then: guidance and case
definitions 1.0 (no decay); clinical/epidemiology references 1.0 (no decay); situation reports and surveillance data
by age at the as-of date - <= 90 days 1.0, <= 365 days 0.6, older 0.3 (undated: oldest bucket, recorded); research 1.0
(neutral). These are policy values, not learned parameters, and were not tuned.

## 3. Deduplication

Candidates are visited in **retention order** (higher source tier, more specific geography, higher rank score, higher
BM25, then identifiers); each is compared with those already retained. Rules, in order: `same_canonical_id` (another row
of the same logical document, same chunk position), `same_content_hash` (another document with the identical version
hash, same position), `same_chunk_hash` (identical chunk text), `near_duplicate` (word-3-gram Jaccard >= 17/20, an exact
integer comparison, over the retrieval tokenisation so case, whitespace, punctuation and Unicode compatibility forms do
not hide a copy). Nothing is silently dropped: each removed candidate records its reason (`duplicate` /
`near_duplicate`), the retained candidate, the rule, the basis and the similarity. In the development corpus the
exact copy (other_verified) is removed in favour of the national-agency original.

## 4. Diversity and top-K

After ranking and dedup: at most **2 chunks per document** and **3 per publisher**, then the top **5 per facet**
(top-K is a policy choice; the plan says "top-K"). Removals carry `document_diversity`, `publisher_diversity` or
`beyond_top_k`, with the limit and the key. The underlying candidate set is intact and independent of row order.

## 5. Conflicts (curator-controlled)

A conflict is reported only when **two selected documents carry the same `question_key` and different `position`
codes**, both authored by a curator. No model, no text similarity, no BM25. With no tags the answer is "no conflicts",
never a guess. This required **one additive migration** (`20261007080000_m4_3_conflict_metadata.sql`): nullable
`question_key` / `position` on `evidence_items`, a both-or-neither check, a code-shaped pattern, and admin-curation
grants (RLS still limits writes to admins; changes are audited by field name). Document files may carry the tags
(`question_key`, `position`); ingestion writes and updates them. Tags are not part of M4.2 retrieval or its digest, so
tagging never changes a retrieval result. **The committed development corpus ships untagged** so its corpus hash is
unchanged; its deliberately conflicting pair is tagged in tests and in the live verification instead.

## 6. Gaps

Deterministic, template-built, never filled from model knowledge: `no_eligible_evidence`, `facet_not_covered`,
`missing_local_evidence` (exactly "no state-level / district-level evidence for <district>, <state>"),
`no_current_guidance` (no selected operational guidance), `all_evidence_old` (every selected situation report /
surveillance item is over a year old), `only_synthetic_evidence`, `contradicting_evidence`. The last one needs a curator
tag: **a design decision for review** - the reserved position code `contradicts_signal_interpretation` marks evidence a
curator judges to contradict the apparent interpretation of a signal; it is surfaced as a gap and kept in the list,
never suppressed. Nothing infers contradiction from text.

## 7. Historical context

A `superseded` document may appear in the separate `historicalContext` section **only if its successor (or a later
descendant) is among the selected evidence**; otherwise it is logged as `superseded`. `historical`-status documents may
appear there without a successor; `withdrawn` never does. This uses a second M4.2 pass with the existing configuration
surface (statuses widened, expiry rule off for old editions), so M4.2 semantics are unchanged. At most 1 chunk per
document and 2 per facet.

## 8. Exclusion log

Every candidate not selected carries a machine-readable `reason` and `family`: `superseded`, `withdrawn`,
`historical`, `not_current`, `expired`, `look_ahead`, `not_yet_valid`, `geographic_ineligible`,
`source_class_not_rankable`, `below_relevance_floor`, `duplicate`, `near_duplicate`, `document_diversity`,
`publisher_diversity`, `beyond_top_k`. Document-level M4.2 exclusions are summarised per facet (counts, plus the
plausible documents - right topic and syndrome - that did not compete, e.g. the 2022 edition: `expired`,
`superseded`). The log is sorted by identifiers only, so it never depends on arrival order.

## 9. Order and reproducibility

Rank score descending; only on a tie: higher tier, more specific geography, higher BM25; identifiers
(canonical id, chunk ordinal, chunk id) are the **final** tie-break. `rankingHash` is content-addressed (no database
ids or timestamps). The result is identical across repeated runs, shuffled candidates and corpus items, a second
database with different ids, and physically rewritten rows. Ranking policy hash:
`f288734e732142d6bbab1afeeb8acc6e5a47aee0fcd97a3ef07e6ccc44c19d5d`.

## 10. Sensitivity analysis (honest results)

The class factors are policy constants, so the question is how much the ordering moves if they were different.
Retrieval is fixed per scenario; only the ranking policy is perturbed. 15 scenarios (5 syndromes x 3 places) x 32
perturbations x 4 facets = 1,920 cases (64 empty facets excluded from the means). Committed report:
`data/evidence/ranking/m4-3-sensitivity-v1.json` (hash `39022ee8cea3b216190c360fe6c97b7bb08ca3a0247e65c69f4bdcace6d1619e`).

| Perturbation family | Cases | Mean tau | Min tau | Mean top-K overlap | Min top-K overlap | Same selected order | Lead changed |
|---|---|---|---|---|---|---|---|
| one class +/- 0.025 (half step) | 754 | 0.997 | 0.905 | 0.995 | 0.667 | 730 | 0 |
| one class +/- 0.05 (full step) | 754 | 0.995 | 0.905 | 0.993 | 0.667 | 718 | 0 |
| ladder spacing 0.025 / 0.075 / 0.10 | 174 | 0.964 | 0.739 | 0.957 | 0.429 | 137 | 0 |
| no class ladder (all equal) | 58 | 0.950 | 0.619 | 0.925 | 0.667 | 41 | **3** |
| relevance floor 0.05 / 0.20 (supplementary) | 116 | 1.000 | 1.000 | 0.929 | 0.400 | 88 | 0 |

Reading it plainly: small single-class changes (1,508 cases) never changed the leading evidence and kept rank order
very close to the baseline. Re-spacing the ladder moved more. Removing the class ladder entirely changed the leading
item in 3 of 58 cases (the acute-diarrhoeal verification facet, in all three places: the recognized-institution
near-duplicate overtook the national-agency original). The factors were not adjusted in response. **Caveat:** the
corpus is synthetic and small, most facets contain few distinct classes, so this shows the *mechanics* are not
hair-trigger here; it does not show robustness on real evidence.

## 11. Mutation tests

`npm run test:mutation:m43` applies 22 deliberate defects (normalisation divisor, class spacing, unverified class,
national factor, own-region rule, status / look-ahead / expiry rules, age bucket, near-duplicate threshold, content-hash
rule, retention order, relevance floor, document / publisher / top-K limits, identifier tie-break, successor rule,
strict facts, conflict rule, local and synthetic gaps) one at a time to the real source and requires a test to fail.
Result: **22 of 22 killed**.

## 12. Known limits (stated, not hidden)

- **Keyword stuffing is only partly mitigated.** The two stuffed documents (class 0.70) reach ranks 3-4 of the
  verification facet in the reference scenario because their stuffed wording scores a high lexical match; the class
  factor and the floor do not remove them. This is reported, not tuned away; a content-quality or curator signal is
  needed beyond M4.3.
- Normalised relevance hides absolute weakness (see section 2); the raw BM25 score is kept for that reason.
- The class spacing, the relevance floor (0.10), top-K (5), shingle size (3) and the historical limits are policy
  choices introduced or fixed in M4.3. The plan's "title / topic matches boosted by documented constants" was **not**
  implemented (topics are already a hard filter in M4.2, and unmeasured boost constants would be tuning).
- Near-duplicate detection by 3-gram Jaccard is insensitive to a single-word edit in a short chunk (about 0.81 for a
  30-word text) and sensitive at the end of a text; the threshold is the planned 0.85.
- Conflicts and the contradiction gap exist only where a curator has tagged documents; sparse tagging means few are
  reported. Selected-set membership matters: a tagged document that loses to the diversity cap is not compared.
- Ranking runs over the synthetic development corpus; results validate the pipeline, not retrieval or ranking quality
  on real evidence, and say nothing about real-world epidemiology.
