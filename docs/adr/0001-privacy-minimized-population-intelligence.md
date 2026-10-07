# ADR 0001 — Store privacy-minimised population health intelligence, not individual conversations treated as diagnoses

* Status: accepted (M2)
* Deciders: JanSanket team
* Related: `docs/M2-ARCHITECTURE.md`

## Context

JanSanket's goal is early, explainable public-health intelligence for officers: LISTEN → DETECT → CORRELATE →
EXPLAIN → VERIFY → INTERVENE → MEASURE → LEARN. The easy way to build "AI for health" is a chatbot that keeps
every conversation and interprets each one as a clinical encounter ("you probably have X"). That design would:

* turn the platform into a **medical-record system** with the legal, ethical and security burden that implies;
* make a single unverified, possibly adversarial or mistaken message look like a **diagnosis**, and a handful of
  them look like a **confirmed outbreak**;
* concentrate **identifiable health data** (names, places, phones, free-text stories) in one place that officers,
  admins and eventually an LLM provider could read;
* gain nothing for the actual objective: public-health surveillance works on **patterns across people**
  (counts, rates, deviations from a local baseline), not on a verdict about one person.

## Decision

1. A **health report is an observation**, never a diagnosis. It records *what was seen, where (coarsely), when,
   and how severe*, using controlled vocabularies, an age band and a block/locality — not who, not exact where.
2. Data flows through explicit privacy tiers: **RAW → DEIDENTIFIED → AGGREGATED**. Person-level data stays in the
   RAW tier, readable only by the submitter, with short retention and user-initiated withdrawal. Officers work with
   population-level aggregates (small cells suppressed by a configurable demonstration threshold) and with
   **signal candidates**.
3. A **signal candidate is a hypothesis about a population**, not a finding. It carries a score, baseline,
   confidence and evidence, moves through a human-verified lifecycle, and is never labelled a confirmed outbreak.
   "Verified" means a person judged it worth acting on.
4. **Data minimisation by construction**: no GPS, address, phone, e-mail, date of birth, national ID or name in the
   health-report schema; this is asserted by tests, enforced by database constraints, and backed by an
   allow-listed column set.
5. **Least privilege**: administrators and officers do *not* get raw reports. Authorisation is enforced by
   row-level security and scoped functions in the database, not by the UI.
6. **Roles stay separated**: LLMs (later) may extract, summarise and explain; statistics/ML detect and correlate;
   rules enforce privacy, safety and authorisation; humans verify and decide. M2 contains only the rules layer.

## Consequences

Positive
* A smaller, defensible attack surface and privacy footprint; a breach of aggregates or signals discloses little
  about any individual.
* Honest epistemics: the product claims "potential emerging signal requiring verification", which is what the data
  can actually support.
* The same pipeline serves detection, evaluation (synthetic ground truth) and, later, intervention measurement.

Negative / costs
* Some analytic ideas that need individual-level linkage (longitudinal follow-up of one person) are deliberately out
  of scope.
* Suppressing small cells and withholding record-level data reduces sensitivity in small blocks; detection in M3
  must treat low-sample signals with explicit lower confidence rather than hiding the problem.
* Deidentification here is a design control, not a mathematical guarantee: differencing attacks and quasi-identifier
  linkage remain possible and are documented limitations. Thresholds are demonstration values that need policy and
  legal review before any real deployment.

## Alternatives considered

* **Conversation store + LLM triage:** rejected — creates diagnoses from unverified text and a high-value PII store.
* **Full patient records / EMR integration:** rejected for M2 — wrong product, wrong regulatory posture.
* **Only anonymous submissions (no account link):** rejected for now — users could then neither see the status of
  their report nor withdraw it. The submitter link is retention-limited and cleared on schedule.
