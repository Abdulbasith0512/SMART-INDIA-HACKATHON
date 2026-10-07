-- JanSanket M4.1: record the hash of the sanitised SOURCE text as fetched, separately from the curated content
-- hash, so the link checker can tell "the publisher changed the page" apart from "a curator edited an excerpt".
-- Additive only: one nullable column and an updated immutability guard. No M1-M3 object is touched.

alter table public.evidence_versions
  add column source_hash text check (source_hash is null or source_hash ~ '^[0-9a-f]{64}$');

-- Same guard as M4.0 plus source_hash: version content (including the source hash) is immutable.
-- fetch_status / retrieved_at / source_last_modified / is_current remain updatable (link-check bookkeeping).
create or replace function public.evidence_versions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.content_hash, new.evidence_item_id, new.version_label, new.abstract, new.source_hash)
       is distinct from (old.content_hash, old.evidence_item_id, old.version_label, old.abstract, old.source_hash) then
    raise exception 'version content is immutable; add a new version instead' using errcode = 'JS008';
  end if;
  return new;
end;
$$;
revoke all on function public.evidence_versions_guard() from public, anon, authenticated;
