# JanSanket

Community Health Intelligence & Response Platform. Current state: **Milestone 1 (secure foundation)** — authentication, roles, RLS, audit log. No AI/signal features yet.

## Setup

1. Create a **fresh** Supabase project (do not reuse the legacy prototype project).
2. Copy `.env.example` to `.env.local` and fill in:
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (browser; public by design, protected by RLS)
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (**dev scripts only; never prefix with `VITE_`; never commit**)
3. Apply the schema: `npx supabase link --project-ref <ref>` then `npx supabase db push`.
4. Install and run: `npm install && npm run dev`.
5. Dev accounts (one per role, random passwords printed once): `npm run seed:dev`.

## Scripts

| Command | Purpose |
|---|---|
| `npm run lint` / `typecheck` / `test` / `build` | Frontend checks |
| `npm run check:secrets` | Fails on JWT-like strings or demo passwords in the repo |
| `npm run validate` | All of the above |
| `npx supabase test db` | pgTAP tests in `supabase/tests` (needs Docker + Supabase CLI) |

Regenerate DB types after schema changes:
`npx supabase gen types typescript --project-id <ref> > src/lib/supabase/database.types.ts`

## Security model (M1)

- Auth is Supabase Auth. New signups are always `citizen`; the client never sends a role.
- Roles live in `user_roles`. Clients have no write access; changes go only through the `admin_set_user_role` RPC, which requires an admin and forbids changing your own roles. Every change is written to the append-only `audit_log`.
- Route guards in the SPA are UX only; RLS is the enforcement layer.
- The first admin is bootstrapped with the seed script (service role) or SQL, never from the browser.

## Legacy code

The original prototype lives in `src/legacy/` for reference only (not routed, built, or linted). See `src/legacy/README.md`.
