-- JanSanket M4.3: curator-controlled conflict metadata on evidence documents.
--
-- Two documents that address the SAME question with DIFFERENT positions are reported as a conflict, but only when
-- a human curator has tagged them with a shared `question_key` and different `position` codes. Nothing infers
-- disagreement: no model, no text similarity. An untagged document can never be part of a conflict.
--
-- Additive only: two nullable columns, a both-or-neither check, and admin-curation column grants (RLS still
-- restricts writes to admins; the generic audit trigger already records which fields changed). No M1-M4.2 object
-- is altered.

alter table public.evidence_items
  add column question_key text
    check (question_key is null or question_key ~ '^[a-z][a-z0-9_.-]{2,80}$'),
  add column "position" text
    check ("position" is null or "position" ~ '^[a-z][a-z0-9_.-]{0,59}$');

alter table public.evidence_items
  add constraint evidence_items_conflict_tag_chk check ((question_key is null) = ("position" is null));

comment on column public.evidence_items.question_key is
  'Curator-authored identifier of the question this document answers. Documents sharing a key and differing in position are reported as a conflict. Never inferred.';
comment on column public.evidence_items."position" is
  'Curator-authored code for the stance this document takes on its question_key. The reserved code contradicts_signal_interpretation marks evidence a curator judges to contradict the apparent interpretation of a signal; it is surfaced as a gap, never suppressed.';

create index evidence_items_question_idx on public.evidence_items (question_key) where question_key is not null;

-- Same admin-curation pattern as the other M4 metadata columns.
grant insert (question_key, "position") on public.evidence_items to authenticated;
grant update (question_key, "position") on public.evidence_items to authenticated;
