# JanSanket

Community Health Intelligence & Response Platform. Current state: **Milestone 2 (core health-signal data foundation)** on top of M1 (secure foundation). Deterministic infrastructure only — no AI, detection, RAG or maps yet.

> LISTEN → DETECT → CORRELATE → EXPLAIN → VERIFY → INTERVENE → MEASURE → LEARN. M2 implements the foundation for LISTEN.
> A health report is an **observation**, not a diagnosis. A signal candidate is a **hypothesis requiring verification**, never a confirmed outbreak.

Docs: [M2 architecture](docs/M2-ARCHITECTURE.md) · [ADR 0001: privacy-minimised population intelligence](docs/adr/0001-privacy-minimized-population-intelligence.md)

## Setup

1. Create a **fresh** Supabase project (do not reuse the legacy prototype project).
2. Copy `.env.example` to `.env.local` and fill in:
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (browser; public by design, protected by RLS)
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (**dev scripts only; never prefix with `VITE_`; never commit**)
3. Apply the schema: `npx supabase link --project-ref <ref>` then `npx supabase db push`.
4. Install and run: `npm install && npm run dev`.
5. Dev accounts (one per role, random passwords printed once): `npm run seed:dev`.
6. Synthetic Odisha dataset + regional scopes for the demo officer/clinician: `npm run seed:synthetic` (**dev projects only** — it replaces the synthetic batch).

## Scripts

| Command | Purpose |
|---|---|
| `npm run lint` / `typecheck` / `test` / `build` | Frontend checks. `test` also runs the database suites (real Postgres via PGlite — no Docker needed) |
| `npm run check:secrets` | Fails on JWT-like strings or demo passwords in the repo |
| `npm run validate` | All of the above |
| `npm run verify:m1` / `npm run verify:m2` | End-to-end checks of auth, RLS, ingestion and the privacy tiers against the **live** project |
| `npm run synth:export` | Regenerate the synthetic dataset manifest and planted-cluster ground truth |
| `npx supabase test db` | M1 pgTAP tests in `supabase/tests` (needs Docker + Supabase CLI) |

Regenerate DB types after schema changes:
`npx supabase gen types typescript --linked --schema public > src/lib/supabase/database.generated.ts`

## Security model

- Auth is Supabase Auth. New signups are always `citizen`; the client never sends a role.
- Roles live in `user_roles`. Clients have no write access; changes go only through the `admin_set_user_role` / `admin_set_user_region_scope` RPCs, which require an admin and forbid changing your own roles. Changes are written to the append-only `audit_log`.
- Raw health reports are readable **only by their submitter**. Officers and admins see population-level aggregates (small cells suppressed by a configurable demo threshold) and signal candidates inside their authorised region. See the access matrix in the M2 doc.
- Route guards in the SPA are UX only; RLS is the enforcement layer.
- The first admin is bootstrapped with the seed script (service role) or SQL, never from the browser.

## Legacy code

The original prototype lives in `src/legacy/` for reference only (not routed, built, or linted). See `src/legacy/README.md`.
