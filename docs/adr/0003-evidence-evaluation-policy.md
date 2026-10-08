# ADR 0003 — Evidence evaluation policy: synthetic benchmark, frozen test split, no tuning on test, human evaluation required

* Status: accepted (M4.6)
* Related: `docs/M4-EVALUATION.md`, `docs/M4-5-GENERATION.md`, ADR 0002 (the M3 freeze discipline this mirrors)

## Context

M4 delivers a chain — detection → controlled retrieval → auditable ranking → immutable bundle → constrained generation → machine
validation → human verification. Before anyone relies on it we need a repeatable way to measure it and to notice when a change makes it
worse. But the only corpus we can legitimately use today is synthetic, the relevance judgments are written by the people who wrote the
pipeline, and no language model is configured. A harness that reported impressive numbers from that setup, or that let a score be improved by
adjusting the system it measures, would be actively misleading in a public-health setting.

## Decision

1. **The synthetic benchmark measures the pipeline, not the world.** Results demonstrate pipeline correctness, determinism, regression
   detection and that the metrics are implemented correctly. They are never described as real-world retrieval quality, clinical accuracy
   or public-health usefulness. Every artefact and report carries that disclaimer; judgments are labelled `synthetic_reference_judgment`
   and are never called expert judgments.
2. **M4.6 is an evaluation milestone, not a tuning milestone.** No production module, migration, configuration, prompt or threshold changes
   in it, and none is changed to improve a score. A weakness the harness finds (for example keyword-stuffed pages reaching the final
   selection) is **reported and documented as a candidate for a separate, versioned change**, which would be re-frozen and re-evaluated.
3. **Freeze before the held-out run, and refuse to run if anything frozen changed.** The scenario set (which fixes the dev/test split), the
   reference judgments, the corpus, the retrieval and ranking configurations, the bundle schema, the generation prompt, the non-test
   production sources and the M3 detector configuration are hashed into `frozen-config.json`. The test split, the adversarial run and the
   reproducibility check refuse to run on any difference. The test split is described honestly as held out from tuning, **not blind**,
   because the scenarios were authored with knowledge of the corpus.
4. **No arbitrary quality thresholds.** Quality figures are descriptive, with denominators and intervals, weak ones included. Only
   *invariants* can fail the evaluation: zero stale, wrong-place or ineligible evidence presented; zero forbidden, fabricated or
   unsupported output accepted; correct abstention in every no-evidence scenario; no false confidence (critical); harness integrity. An
   invariant with no data is `not_exercised`, never passed. A regression against a baseline is a safety flip, or a descriptive metric below
   the baseline's own interval (which needs a documented reason).
5. **Independent checks guard against circularity.** The safety oracle, the duplicate detector and the reference judgments are written
   from stated rules without calling the production eligibility, ranking or deduplication code. Disagreement is a finding, not averaged away.
   Mutation tests on the harness itself must kill every mutant, so a wrong metric or a missed violation cannot pass silently.
6. **Generation is evaluated from stored outputs.** Provider answers are recorded and replayed through the real pipeline; temperature 0 is
   not assumed deterministic. With a scripted provider the generation metrics are pipeline metrics and are labelled so. Fallback, rejection,
   hallucination and forbidden-claim rates **include** failed and abstained generations and separate provider failure, schema failure,
   validator rejection and fallback extraction. A live provider may only be run as a separate opt-in experiment that cannot overwrite
   frozen results.
7. **LLM-as-judge is experimental until validated against humans.** A judge may report groundedness or factual consistency only after
   agreeing with at least 100 adjudicated human labels from at least two raters (kappa ≥ 0.61, agreement ≥ 0.80, invalid ≤ 5%) — thresholds
   fixed here, before any judge result. It never alters a production output. Today it is **not validated**; no judge number is reported.
8. **Human evaluation is required for what automation cannot establish**, and is exported rather than faked: real-corpus relevance, clinical
   and epidemiological accuracy, usefulness to a verifier, source-tier appropriateness and Hindi/Odia quality. The harness accepts a
   curator-supplied real corpus only with licence and source verification, at least two raters, agreement above the floor and judgments
   frozen by hash before any system result; no real document is added or scraped by this milestone.

## Consequences

* The numbers are modest and honest: they will not impress, but they cannot be mistaken for a clinical claim, and any later change to
  retrieval, ranking or the prompt is compared against a committed, reproducible baseline.
* Real quality remains unknown until a curated corpus and expert raters exist; the harness is ready to take them.
* The evaluation costs a freeze step and a repeatable pipeline; changing production after the freeze requires a new freeze.
* Findings (lexical vulnerability to stuffing, facet leakage, the per-document diversity cap) are visible and attributable instead of
  being tuned away on the same data that measures them.
