# ADR 0002 — Transparent statistical detection before machine learning

* Status: accepted (M3)
* Related: `docs/M3-DETECTION.md`, `docs/M3-EVALUATION.md`, ADR 0001

## Context

M3 must turn deidentified observations into population-level signals that a public-health officer can verify.
Options ranged from opaque ML anomaly models or LLM "risk scores" to classical surveillance statistics. The
data are small (90 days, 16 blocks, sparse syndromes), count-valued and nearly Poisson; we have synthetic ground
truth but no real outcomes to train or calibrate a learned model against.

## Decision

1. Use an established surveillance family — moving baseline + count exceedance — implemented as a
   Gamma-Poisson predictive test on an exponentially weighted, day-of-week-adjusted baseline, with explicit,
   individually logged gates (evidence floor = privacy threshold, persistence, single-day and bulk-source
   survival checks, practical ratio, concentration).
2. Make every number explainable: the alarm states observed vs expected reports, window, elevated days and
   source types; the score is a documented weighted sum of bounded components; `confidence` is evidence
   sufficiency. Neither is presented as a probability of a real event.
3. Keep the LLM out of detection entirely (it may later *explain* results, M4+), and use no ML model in M3.
4. Freeze the configuration before evaluation; evaluate on independent held-out synthetic replicates and null
   runs with interval estimates; report limitations (clinic batches, sparse clusters) rather than tuning them away.
5. Implement in TypeScript (same code path for evaluation and production); use Python/scipy only offline to
   produce numeric golden fixtures.

## Consequences

* Officers get reasons they can check, and every alarm is reproducible from stored hashes.
* Specificity is prioritised (frozen `alpha = 1e-4`): fewer false alarms, at the cost of missed or late sparse
  clusters. This is an operating choice for this version, not a claim of optimality.
* Some artifacts that look statistically like real surges (single-source multi-day batches) cannot be removed
  by counts alone; human verification remains the control.
* A learned model can be considered later only if it beats this baseline on the same held-out protocol and can
  be explained to the same standard.
