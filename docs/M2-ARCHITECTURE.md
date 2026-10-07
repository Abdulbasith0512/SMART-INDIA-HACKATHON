# M2 — Core health-signal data foundation ("LISTEN")

M2 is deterministic infrastructure. It stores observations, protects them, and prepares population-level
data for the later detection layer. **Nothing in M2 diagnoses, predicts, or calls an LLM.**

> LISTEN → DETECT → CORRELATE → EXPLAIN → VERIFY → INTERVENE → MEASURE → LEARN
> M2 implements the foundation for LISTEN, plus the table contracts that M3+ will fill.

Vocabulary used throughout: **health report** (one observation), **signal candidate** (a population-level
pattern that *may* need investigation), **evidence**, **confidence**, **verification status**. A signal is never
called a confirmed outbreak; the word "outbreak" appears in no schema identifier.

Separation of concerns (unchanged by M2, enforced by what M2 does *not* contain):

| Layer | Responsibility | In M2? |
|---|---|---|
| LLM | extraction / summarisation / explanation | no |
| Statistics + ML | detection, baselines, correlation, forecasting | no (contract only: `signal_candidates`) |
| Rules (SQL, RLS, TS validation) | privacy, safety, authorisation | **yes** |
| Human | verification, decisions, interventions | review workflow (`review_signal_candidate`) |

A test (`src/test/boundaries.test.ts`) fails if an AI SDK, embedding column, vector extension or AI endpoint appears.

---

## 1. Data tiers (privacy pipeline)

```
RAW                        DEIDENTIFIED                        AGGREGATED
health_reports   ──────►   deidentified_observations  ──────►  report_aggregates
(person-level)             (per observation, coarsened)        (block × day × syndrome)
submitter + region +       no submitter, no free text,         counts + suppression flag
age band + free text       block + day only                    true counts service-side only
   │ RLS: own rows only       │ service role only                  │ clients: get_report_aggregates()
```

| Tier | Table | `privacy_level` | Who can read | Retention |
|---|---|---|---|---|
| RAW | `health_reports` | `raw` | the submitter only (RLS). Not officers, not admins, not clinicians (for others' reports). | free text cleared after **30 days**, submitter link cleared after **365 days** (configurable demo values), plus user withdrawal (delete) at any time |
| DEIDENTIFIED | `deidentified_observations` | `deidentified` | service role only in M2 | kept; link to raw is cleared if the raw report is withdrawn |
| AGGREGATED | `report_aggregates` | `aggregated` | service role (true counts); officers/admins through `get_report_aggregates()` with suppressed cells masked | kept |

Why deidentified rows are not shown to officers in M2: block + day + age band + symptom set can still single out a
person in a small population (quasi-identifiers). Exposing record-level deidentified data needs a deliberate
disclosure review first; aggregates with suppression are the officer-facing product for now.

### Small-cell suppression — a configurable demonstration parameter
`privacy_settings.min_aggregate_cell_size` (default **5**) hides counts for cells with fewer cases than the
threshold. **This is a demo parameter, not a universal privacy guarantee.** It does not protect against
differencing attacks (e.g. subtracting overlapping queries), nor does it make small populations safe. The value
applied is stored on each aggregate row (`min_cell_size_applied`). Any production threshold needs a policy and
legal review.

---

## 2. Schema

Migrations (apply in order; never edit an applied one):

| File | Contents |
|---|---|
| `20261007000000_m1_auth_foundation.sql` | M1: profiles, user_roles, audit_log, admin RPCs |
| `20261007010000_m1_revoke_trigger_function_execute.sql` | M1 hardening |
| `20261007020000_m2_schema.sql` | **M2 schema**: enums, tables, constraints, indexes, validation triggers, reference vocabularies |
| `20261007030000_m2_security.sql` | **M2 security**: grants, RLS, audit triggers, scoped and service-only functions |
| `20261007040000_m2_role_probe_hardening.sql` | `has_role()` / `is_region_in_scope()` only answer for the caller's own id |

### Tables

| Table | Purpose |
|---|---|
| `regions` | Self-referencing hierarchy: country → state → district → block → locality. `parent_region_id`, `region_type`, `administrative_code` (unique), `name_local` (hi/or), `active`, `is_synthetic`. `region_type` and parent are immutable. |
| `symptom_terms` | Controlled symptom vocabulary (code + en/hi/or labels). Extensible without a migration to the enum. |
| `privacy_settings` | Demo parameters: suppression threshold, retention days. Admin-editable, audited. |
| `detection_methods` | Lookup for `signal_candidates.detection_method` (`unspecified`, `manual`); M3 adds methods by inserting rows. |
| `health_reports` | RAW observation (see §3). |
| `deidentified_observations` | DEIDENTIFIED derivative; `report_id` is a *nullable* back-link (cleared on withdrawal). |
| `report_aggregates` | AGGREGATED cells; unique (region, date, syndrome). |
| `signal_candidates` | Population-level pattern contract for M3 (see §5). |
| `evidence_items` | Reference sources (title, publisher, URL/citation, date, SHA-256 content hash, trust level). No embeddings. |
| `signal_evidence` | Many-to-many signal ↔ evidence. |
| `report_signal_links` | Traces a signal to **deidentified observations or aggregate cells**. It has no column that can reference a raw report, by design. |

### Enums (controlled vocabularies)
`region_type`, `source_type` (citizen, clinician, health_facility, public_health_officer, survey, environmental,
imported_dataset, system_generated), `report_type`, `report_severity` (unknown, mild, moderate, severe),
`age_band`, `syndrome_category`, `privacy_level`, `processing_status`, `signal_status`, `verification_status`,
`signal_origin`, `evidence_source_type`, `evidence_trust_level`. Extend with `ALTER TYPE … ADD VALUE` in a new migration.

### Functions

| Function | Caller | Purpose |
|---|---|---|
| `has_role`, `is_region_in_scope`, `region_subtree` | RLS policies / definer functions | authorisation helpers; self-only evaluation |
| `review_signal_candidate` | officer in scope, admin | the only client path to change a signal's lifecycle; audited |
| `admin_set_user_region_scope` | admin (not for self) | sets a clinician/officer region scope; audited |
| `get_report_aggregates` | officer in scope, admin | reads aggregates with suppressed cells masked |
| `deidentify_pending_reports`, `refresh_report_aggregates`, `apply_report_retention` | **service role only** | the RAW→DEIDENTIFIED→AGGREGATED pipeline and retention; audited |
| `audit_row_change`, `write_audit`, trigger guards | internal | not executable by API roles |

### Indexes (deliberate)
`health_reports`: (region, observed_at desc), observed_at, source_type, partial on pending `processing_status`,
(submitter, created_at). `report_aggregates`: date, (region, date). `deidentified_observations`: (region, date,
syndrome), date. `signal_candidates`: (region, window start), partial on open statuses, (syndrome, window start),
created_at. `regions`: parent, partial (type) where active. No Kafka / graph DB / Redis: Postgres is sufficient at
this scale.

---

## 3. Health report model

`health_reports` columns (an allow-list asserted by a test — adding a column fails it):
`id`, `client_submission_id`, `created_at`, `updated_at`, `observed_at`, `submitted_by`, `source_type`, `region_id`,
`report_type`, `syndrome`, `symptom_codes[]`, `severity`, `age_band`, `case_count`, `language`, `privacy_level`,
`processing_status`, `free_text`, `synthetic_batch`.

**Deliberately absent:** exact GPS, address, phone, e-mail, date of birth, national ID (Aadhaar etc.), name.
Geography is a coarse region (block or locality, never district or above); age is a band; symptoms and syndrome
are controlled vocabularies. `free_text` is optional, ≤ 500 chars, redacted by the service and re-checked by a
database CHECK (phone/ID-like digit runs, e-mail). Heuristic only — see Limitations.

Rules enforced **in the database** (so bypassing the service does not bypass them):
region exists, active and block/locality (`JS001–JS003`); symptom codes in vocabulary (`JS004`); `observed_at` not
in the future and, for live sources, not older than 90 days (`JS005`); `report_type`/`case_count` consistency; only
non-citizens may submit aggregate counts; `privacy_level` is always `raw`; idempotency key
`(submitted_by, client_submission_id)`; content immutable after insert (`JS008`); lifecycle transitions (`JS007`).

Custom SQLSTATEs: `JS001` region not found, `JS002` inactive, `JS003` wrong level/hierarchy, `JS004` bad symptom,
`JS005` bad timestamp, `JS007` bad transition, `JS008` immutable field.

### Source types
| Source | Who/what | How it can arrive |
|---|---|---|
| `citizen` | community member | client (own account), individual observations only |
| `clinician`, `health_facility` | clinician accounts | client, only for regions inside their role scope; facility rows may be `aggregate_count` |
| `public_health_officer` | officer's own field observation | client, only inside their scope |
| `survey`, `environmental`, `imported_dataset`, `system_generated` | trusted batches | **service role only** (not client-submittable) |

### Lifecycle — `processing_status`
`received → validated → deidentified` (or `rejected`). `validated` is reserved for later asynchronous checks;
M2's pipeline moves `received → deidentified` directly. No transition backwards; `rejected` is terminal.
Clients can set none of these (column privileges *and* RLS `WITH CHECK`).

---

## 4. Region hierarchy and scoping

`country → state → district → block → locality`, one self-referencing table; a trigger enforces that each type's
parent is exactly one level above and that type/parent never change. Role scopes live in
`user_roles.region_id` (FK to `regions`, only for `clinician`/`officer`). **A role row with NULL scope grants no
regional access.** Scope is inherited downward (`region_subtree`). Admins set scopes with
`admin_set_user_region_scope` (not for themselves).

The demo geography is **synthetic Odisha**: real district/block names, fictional `SYN-*` administrative codes,
fictional localities, `is_synthetic = true`. It is not authoritative LGD data.

---

## 5. Signal candidates

Contract for M3; M2 never computes a score. Fields: `region_id`, `time_window_start/end`, `syndrome`,
`observed_value`, `baseline_value`, `deviation`, `signal_score`, `sample_count`, `minimum_sample_count`,
`detection_method` (FK lookup), `confidence` (0–1), `status`, `verification_status`, `explanation`, `origin`,
`created_by`, review fields, `resolved_at`. Unique per (region, syndrome, window, method).

Review of the design against the architecture plan (Part 6 "alerts"): the plan's `alerts` became
`signal_candidates`; the plan's single status was split into a **lifecycle** (`status`) and a **human verification
result** (`verification_status`), so "verified" can never be read as a diagnosis. The plan's "distinct reporters"
suppression rule became a **case-count** rule because aggregates deliberately carry no reporter identity.

```
candidate ──► under_review ──► verified ──► monitoring ──► resolved
    │               │              └──────────────────────► resolved
    └──► dismissed ◄┘                       (resolved / dismissed are terminal)
```
Coupling constraints: `candidate` ⇒ `unverified`; `under_review` ⇒ `unverified|in_progress`; `verified|monitoring`
⇒ `supported`; `dismissed` ⇒ not `supported`; `resolved_at` is set exactly for `resolved|dismissed`.
`supported` = a human judged the signal worth acting on; it is not a confirmed diagnosis. Signal identity
(region, syndrome, window, method) is immutable.

---

## 6. Access model (RLS, default deny)

Supabase grants `ALL` to API roles by default, so every table starts with `REVOKE ALL` and gets the minimum back.

| | citizen | clinician | officer | admin | service |
|---|---|---|---|---|---|
| own raw reports | create, read, delete | create, read, delete | create (own scope, `public_health_officer`), read, delete | — | all |
| others' raw reports | ✗ | ✗ | ✗ | ✗ | ✓ |
| submit as clinician/facility | ✗ | ✓ inside scope | ✗ | ✗ | ✓ |
| `deidentified_observations`, `report_aggregates` (tables) | ✗ | ✗ | ✗ | ✗ | ✓ |
| aggregates via `get_report_aggregates` (suppressed) | ✗ | ✗ | ✓ own scope | ✓ all | ✓ |
| signal candidates | ✗ | ✗ | read own scope; review via function | read all; review via function | create |
| evidence | trusted only | all | all | all, write | write |
| regions / symptom terms | read active | read active | read active | read all, write | write |
| privacy settings | ✗ | ✗ | read | read, edit threshold | ✓ |
| role scopes | ✗ | ✗ | ✗ | set (not own) | ✓ |
| audit log | ✗ | ✗ | ✗ | read | write |

Admins deliberately cannot read raw health reports: administering the platform does not require reading them.
Privileged state changes are audited: reference-data edits and signal changes (`audit_row_change`, field names
only, never values), signal reviews, scope changes, pipeline runs, retention runs. **Raw submissions are not
audited individually** (volume, and the log must not become a second copy of health data).

---

## 7. Ingestion service (`src/features/reporting/`)

```
input → auth → validation → normalisation → region validation → privacy validation → sanitisation → persistence
```
Pure TypeScript, no LLM, no business logic in React. `contracts.ts` (typed request/response/error contracts),
`validation.ts` (zod + cross-field rules, strict: unknown keys rejected), `sanitize.ts` (redacts phone-like
numbers incl. Devanagari/Odia numerals, e-mails, links; strips control characters), `service.ts`
(`createReportingService(gateway)` → `submitHealthReport`), `supabaseGateway.ts` (adapter; authorisation is RLS).

Result: `accepted` | `duplicate` | `rejected{code}` with codes `UNAUTHENTICATED`, `VALIDATION_FAILED`,
`REGION_NOT_FOUND`, `REGION_INACTIVE`, `REGION_LEVEL_INVALID`, `PRIVACY_VIOLATION`, `FORBIDDEN`,
`PERSISTENCE_FAILED`. System-controlled fields (`processing_status`, `privacy_level`, `submitted_by`,
`synthetic_batch`) and exact-location/identity fields are **rejected with an explicit error**, not silently dropped.
Unexpected database errors never leak raw messages.

---

## 8. Synthetic dataset (`src/synthetic/`)

Deterministic from seed `20261007`: 54 regions (1 country, 1 state, 4 districts, 16 blocks, 32 localities) and
4,893 reports over 90 days (2026-06-15 → 2026-09-12) across 8 source types and 6 syndromes, in English/Hindi/Odia
metadata. Normal background has weekday and monsoon-like variation, per-block weights and Poisson noise.

Planted ground truth (`data/synthetic/m2-odisha-v1.ground-truth.json`) for evaluating **M3** (no detector exists in M2):
P1 single-block diarrhoeal surge · P2 two-block fever-with-rash cluster · P3 sparse jaundice cluster (small counts) ·
P4 ramping two-block diarrhoeal cluster · D1 decoy one-day bulk-import artifact (should *not* be a signal).

`data/synthetic/m2-odisha-v1.manifest.json` pins the SHA-256 of the report stream; a test regenerates the data and
compares. Determinism relies on integer arithmetic plus `Math.sin/exp`, which are deterministic on V8 (Node and
Chromium); a different JS engine could differ in the last bit. All data is fictional.

Commands: `npm run synth:export` (regenerate manifest/ground truth), `npm run seed:synthetic` (load to your dev
project; replaces the batch `m2-odisha-v1`; **do not run against production**).

---

## 9. Testing

| Suite | What it proves | Run by |
|---|---|---|
| `src/test/db/*.db.test.ts` (PGlite = real Postgres in WASM, runs the actual migrations) | keys, FKs, enums, hierarchy, timestamps, required fields, PII allow-list, lifecycle, RLS for every role, scoped officers, suppression, pipeline, retention, withdrawal, M1 regression | `npm test` (no Docker) |
| `src/features/reporting/ingestion.test.ts` | valid/invalid region, severity, status, timestamps, unauthenticated/forbidden, duplicates, sanitisation, error mapping | `npm test` |
| `src/synthetic/generate.test.ts` | determinism, manifest, geography, no PII, baseline, planted clusters, decoy | `npm test` |
| `src/test/boundaries.test.ts` | no AI/vector/ML in deps, code or migrations | `npm test` |
| `scripts/verify-m1.ts`, `scripts/verify-m2.ts` | the same guarantees against the **live** Supabase project, through the real client | `npm run verify:m1`, `npm run verify:m2` |
| `supabase/tests/m1_auth_foundation.test.sql` | M1 pgTAP (needs Docker) | `supabase test db` |

The harness has a mutation hook (`DB_TEST_MUTATION`) used to confirm that weakening a policy turns the suite red.
Caveat: PGlite stands in for Supabase's `auth` schema and API roles; the live scripts exist to cover that gap.

---

## 10. Security assumptions and limitations

* RLS is the enforcement layer; client route guards and the service layer are UX/defence in depth.
* Service-role credentials exist only in `.env.local` / server scripts and must never be exposed to a browser.
* `submitted_by` links a raw report to an account until the retention window clears it. Deleting an account
  unlinks (does not delete) its reports.
* Free-text redaction is heuristic; names and addresses cannot be detected reliably. Free text is optional, short,
  retention-limited and never sent to an LLM in M2.
* Suppression is a demonstration parameter (see §1). Differencing across overlapping queries is not prevented.
* Retention functions exist but are **not scheduled** (no `pg_cron` yet); run `apply_report_retention()` manually.
* India's DPDP Act 2023 alignment is a design intent, not a compliance claim; it needs legal review.
* Supabase's `rls_auto_enable` helper and the "leaked password protection" setting appear in advisor output; they
  are not part of this schema (the latter is a dashboard/plan setting).
* Not in M2 (by decision): LLM extraction, RAG/embeddings, detection, forecasting, misinformation analysis,
  intervention simulation, maps, WhatsApp/IVR/voice, graph database.
