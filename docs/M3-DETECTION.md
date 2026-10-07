# M3 — Statistical signal detection (detector v1)

**What it produces:** *"Emerging signal requiring verification"* candidates for human review. Never a
"confirmed outbreak", never a diagnosis, never auto-verified. No LLM, no ML model, no embeddings, no vector DB.

**Frozen version:** `windowed-gamma-poisson/1.0.0`, method code `windowed_gamma_poisson_v1`,
config hash `23188f021f80bd84113165469456f72165be682522243f908cbb715793d104ba`
(`data/detection/m3-detector-v1.config.json`, committed *before* the held-out evaluation).
Evaluation results: [`docs/M3-EVALUATION.md`](M3-EVALUATION.md). Rationale: [ADR 0002](adr/0002-transparent-statistical-detection-before-ml.md).

> **Operating threshold.** The per-test significance level `alpha = 1e-4` (and the same level for the survival
> checks) is the **frozen high-specificity operating threshold for this detector version**. It is not claimed
> to be epidemiologically optimal; a different setting is a new detector version with a new evaluation.

```
deidentified_observations --(detection_daily_features, service role)--> FeatureRow[] (block x IST day x syndrome)
   -> SeriesStore (dense, zero-filled)
   -> for each as-of day t, district, syndrome:
        block tests (4 windows) -> alarmed blocks -> involved blocks -> pooled cluster test
        (no block alarm) -> district-pooled test -> concentration rule
        gates -> decision {candidate | watch | gated} -> score
   -> episodes (merge alarms, gap <= 2 days) -> upsert_detected_signal -> signal_candidates (status = candidate)
   -> human review via the M2 review_signal_candidate() lifecycle
```

## 1. Input

Rows from the **deidentified** tier only: block, India-local date, syndrome, `reports` (distinct report
**records** — never distinct reporters; the schema carries no reporter identity), `cases` (volume feature),
unknown-severity count, per-source report counts. Syndromes analysed: acute diarrhoeal illness, fever,
fever-with-rash, jaundice, respiratory illness (`other`/`unknown` excluded).

The test unit is **reports**, not cases: facility aggregate rows bundle several cases, which made daily case
counts over-dispersed (var/mean 1.5–1.7) while report counts are close to Poisson (0.98–1.11) — measured
during planning.

## 2. Baseline

For as-of day `t` and window `w`, history = `[t-w-g-L+1, t-w-g]` with guard `g = 2`, `L = 28` days, at least
**14 usable** days (otherwise the test is skipped and counted, never guessed).

* **Exponential weighting** of history days (half-life 14 days). This is a weighting of the baseline only —
  **not** an EWMA control-chart detector (control charts are deferred, §8).
* **Day-of-week factors** from pooled state-wide, *non-bulk* report totals over the same span, shrunk toward 1
  (4 pseudo-observations) and normalised to mean 1.
* **Prior** (sparse cells borrow strength): rate = the unit's own all-syndrome report volume × the state-wide
  share of the syndrome, with strength `k0 = 7` exposure-days and a floor of 0.01/day. No generator knowledge.
* **Exclusions:** days inside any of the detector's own episodes for that block/syndrome (prevents a sustained
  rise from being absorbed into its own baseline) and district-wide zero days (possible reporting outage).

## 3. Test

Gamma-Poisson **posterior predictive** (negative binomial) upper tail `p = P(X >= observed)` for the window,
which carries baseline-estimation uncertainty (a plug-in Poisson test overstated significance in planning).
Windows `w ∈ {3, 5, 7, 14}`; the lowest-p passing window is used (ties: shorter). Detection level
`alpha = 1e-4`. Numerics are checked against scipy goldens (`scripts/golden`, offline only).

## 4. Gates (all logged per finding)

| Gate | Rule (frozen v1) | Purpose |
|---|---|---|
| evidence | window reports `>= max(5, k)` and `>= 3` distinct report records; `k` = `privacy_settings.min_aggregate_cell_size` | privacy floor; cannot be disabled |
| persistence | `>= 2` elevated days (day count `>= max(1, ceil(1.5 x expected day))`) | not a single noisy day |
| burst | largest day `<= 70%` of the window **and** after removing it the rest is still significant at `p <= 1e-4` | one-day artifacts |
| bulk | bulk-source (`imported_dataset`, `system_generated`) share `< 80%` **and** after removing them the rest is still significant at `p <= 1e-4` | batch-import artifacts |
| ratio | observed / expected `>= 2` | practical, not only statistical, significance |
| concentration | district-pooled alarm only: no single block carries `>= 70%` of the excess | pooling must not launder a single-block artifact |

Decision: all pass → **candidate**; p passes but only the evidence floor fails → **watch** (internal, count not
stored if `< k`); otherwise **gated**.

## 5. Geography (hierarchy only — there is no adjacency/geometry data)

Blocks are tested individually. If any block alarms, *involved* blocks = alarmed blocks plus blocks with
`p <= 0.005`, ratio `>= 1.5`, `>= 2` reports; the involved set is re-tested pooled. If no block alarms, the
district-pooled test may alarm (subject to the concentration rule); its involved blocks are those carrying
`>= 15%` of the excess. All alarmed blocks of one district/syndrome/time form one cluster (adjacency-free
approximation, documented limitation).

## 6. Score (ranking only)

```
score = 100 x Q x (0.35 D + 0.20 P + 0.15 V + 0.15 G + 0.15 S)
D = 0.5 clamp((-log10 p - 4)/8) + 0.5 clamp(log2(ratio)/3)     deviation
P = elevated days / window                                     persistence
V = clamp(log10(reports)/log10(30))                            volume
G = 1 - (involved - 1)/(blocks in district - 1); 1 if the district has <= 1 block   concentration
S = clamp((1/HHI - 1)/3), HHI over source types                source diversity
Q = min(1, history/28) x (1 - bulk share) x (1 - 0.5 unknown-severity share)        data quality
priority: low < 40 <= medium < 65 <= high
confidence = Q x min(1, reports/20)
```
`signal_score` is a transparent **ranking/priority** score; `confidence` is an **evidence-sufficiency** index.
**Neither is a probability that an event is real, a probability of an outbreak, or a diagnostic confidence**
(also stated in the schema column comments and in every candidate's `score_components.note`).

## 7. Episodes and candidates

Consecutive alarms for a (district, syndrome) merge while gaps are `<= 2` days. Episode key =
`sha256(method | syndrome | district | first alarm date)` → one candidate per episode (unique index), idempotent
re-runs. Location = the peak alarm's blocks plus blocks involved on at least half of the alarm days (no
single-day inflation). Candidate region = the block, or the district when several blocks are involved; the
region may only **widen** (block → its district). Metrics are the peak alarm's. Explanation is a fixed template:
"Emerging signal requiring verification: … This is a statistical flag, not a confirmed outbreak or a diagnosis.
Human verification required."

## 8. Database (migration `20261007050000_m3_detection.sql`)

* `detector_runs` (version, config + hash, input hash, data range, k applied, stats), `detector_findings`
  (screened tests; **counts below k are never stored**, enforced by trigger), `evaluation_runs` /
  `evaluation_event_results` (scored synthetic benchmark outcomes — ground truth itself is never stored).
* `signal_candidates` + `episode_key`, `first_run_id`/`last_run_id`, `first_detected_on`/`last_seen_on`,
  `score_components`, `evidence`.
* Service-only functions: `detection_daily_features(from, to)`, `upsert_detected_signal(payload)`.
* Guard extended: the detector may extend an *unreviewed* candidate only through the upsert function; once a
  human starts review, evidence/metrics are frozen (the detector only records `last_seen_on`).
* Invariant trigger for detector rows: `sample_count >= k`, block/district region, safe wording, score 0–100,
  inserts start as `candidate`.
* RLS: runs → officers + admins; findings → admins + officers in scope; evaluations → admins; candidates →
  M2 rules (admins; officers in scope). Clients cannot call the detector functions or write any of these tables.

## 9. Running

```
npm run detect                      # full replay over live deidentified data, idempotent
npm run detect -- --dry-run
npm run eval:detector -- --split=dev    # dev seeds (calibration)
npm run eval:detector -- --split=test   # held-out evaluation (refuses if config != frozen hash)
npm run eval:detector -- --persist      # store results in evaluation_runs
npm run verify:m3                   # live end-to-end checks
```
A scheduled production job is **not** part of M3.

## 10. Reproducibility

Pure functions, injected as-of day (no clock), stable ordering, rounded persisted values; config hash + input
hash (SHA-256 of canonical feature rows) + git commit recorded per run; look-ahead mutation test, determinism
and row-order tests, incremental-equals-replay test; live features and live episodes are verified identical to
the in-memory path (`verify:m3`). Same V8 floating-point caveat as M2.

## 11. Deviations from the approved plan (disclosed)

1. **Survival checks** were added to the burst and bulk gates (the plan had share thresholds only), after
   detector fixtures showed share thresholds are brittle in 14-day windows.
2. Their level was first 0.05 and was set to the detection level **1e-4 after dev-split diagnostics** (a bulk
   day plus a weak chance excess passed the looser level). Decided before the freeze; dev effect: false
   episodes per null run 0.30 → 0, cluster recall 75% → 61.5%.
3. **Concentration rule** for district-pooled alarms and **excess-share involvement** (fixture findings).
4. **Stable involvement** (no union of single-day involvements) and involvement p 0.01 → 0.005.
5. Detector invariants apply to rows carrying an `episode_key` (all detector writes); manually curated M2
   rows keep the M2 contract.
6. Live execution is **replay mode** only (idempotent full replay); incremental as-of runs are proven equivalent
   in tests but not wired to the database; no scheduler.
7. Findings are readable by in-scope officers *because* sub-`k` counts are never stored.

## 12. Known limitations

* **3-day single-source clinic batch** (20 reports/day from one clinician source): by counts alone it is
  indistinguishable from a genuine 3-day surge reported by a clinic, and it is **not rejected**. Its low
  source diversity lowers its score, but no gate removes it. Human verification is the control.
* **Sparse syndromes / sparse clusters** (e.g. the M2 jaundice cluster P3) are often missed or late under the
  evidence floor and the high-specificity threshold — a deliberate privacy/specificity trade-off.
* Detection needs >= 2 elevated days: no alarm on a cluster's first day.
* Synthetic Poisson benchmark ⇒ results validate implementation and calibration, **not** real-world
  epidemiological performance.
* No adjacency/population data: clusters are district-scoped; no space-time scan statistic.
* Replay ≠ real time (no reporting-delay model); level shifts from new reporting sources can look like signals.
* Differencing across overlapping signals is not prevented (counts shown are always `>= k`).
* Deferred: EWMA/CUSUM control charts, Farrington (needs multi-year history), Kulldorff scan, Python worker,
  forecasting, cross-syndrome correlation (M4).
