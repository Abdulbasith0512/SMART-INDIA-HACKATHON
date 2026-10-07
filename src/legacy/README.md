# Legacy prototype code (reference only)

This folder preserves the original MediCare/"doc-vista-connect" prototype that JanSanket was built from.

- It is **not routed, not type-checked, not linted, and not bundled**. Active code must never import from here (a test enforces this).
- It depends on the old integer-id `users`/`appointments`/`messages` schema and an old Supabase project that are no longer used.
- Hardcoded keys/URLs in `integrations/client.tsx` and `lib/supabase.ts` were replaced with placeholders. Original files are in the untouched backup zip made before M1.
- `components/chat/*` (kept in the main tree) is intended for reuse in later milestones.

Deletion decisions for this folder are deferred until the JanSanket domain model is implemented.
