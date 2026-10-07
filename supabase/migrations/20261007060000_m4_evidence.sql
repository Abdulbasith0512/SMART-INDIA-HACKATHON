-- JanSanket M4.0: evidence intelligence schema (documents, versions, chunks, bundles, citations, explanations).
--
-- Evidence is DATA. It is never an instruction, and nothing here lets a client write it: corpus, bundle and
-- generation tables are written only by service-role scripts. Nothing in this migration touches the M3
-- detector, its tables' existing columns, or signal_candidates.explanation / evidence (detector-owned).
--
-- Source "trust" is categorical (issuer class + verification basis + status), never a numeric truth score.

-- ---------------------------------------------------------------------------
-- Vocabularies
-- ---------------------------------------------------------------------------
create type public.evidence_source_class as enum (
  'intergovernmental_health_authority', 'national_government_health_agency', 'state_government_health_agency',
  'peer_reviewed_literature', 'recognized_institution', 'professional_society_guideline', 'other_verified', 'unverified'
);
create type public.evidence_kind as enum (
  'operational_guidance', 'case_definition', 'clinical_epidemiology_reference', 'situation_report', 'surveillance_data', 'research'
);
create type public.evidence_status as enum ('draft', 'quarantined', 'current', 'superseded', 'withdrawn', 'historical');
create type public.evidence_geo_scope as enum ('global', 'regional', 'national', 'state', 'district');

create table public.evidence_topics (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{1,60}$'),
  label_en text not null,
  description text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.evidence_topics (code, label_en, description) values
  ('diarrhoeal_disease',       'Diarrhoeal disease',             'Acute diarrhoeal illness: definitions, surveillance and response.'),
  ('enteric_infections',       'Enteric infections',             'Waterborne and foodborne enteric infections (family-level reference, not a diagnosis).'),
  ('jaundice_hepatitis',       'Jaundice and hepatitis',         'Acute jaundice syndrome and viral hepatitis family-level reference.'),
  ('rash_illness',             'Fever with rash',                'Fever-with-rash syndromes: case definitions and surveillance.'),
  ('respiratory_illness',      'Respiratory illness',            'Acute respiratory illness surveillance and definitions.'),
  ('fever_illness',            'Fever illness',                  'Acute undifferentiated fever surveillance and definitions.'),
  ('outbreak_investigation',   'Outbreak investigation',         'How public-health staff verify and investigate a reported cluster.'),
  ('case_definition',          'Case definitions',               'Standard surveillance case definitions.'),
  ('water_sanitation',         'Water, sanitation and hygiene',  'Water safety and sanitation context for water-related syndromes.'),
  ('vector_borne_context',     'Vector-borne context',           'Vector-borne disease context for fever and rash syndromes.'),
  ('monsoon_seasonality',      'Monsoon seasonality',            'Seasonal patterns relevant to the monsoon period.'),
  ('surveillance_methods',     'Surveillance methods',           'Syndromic surveillance and signal verification methods.'),
  ('outbreak_response',        'Outbreak response',              'Public-health response and reporting checklists for officers.');

-- ---------------------------------------------------------------------------
-- evidence_items: document-level metadata (existing M2 table, extended)
-- ---------------------------------------------------------------------------
alter table public.evidence_items
  add column source_class public.evidence_source_class not null default 'unverified',
  add column evidence_kind public.evidence_kind,
  add column topics text[] not null default '{}',
  add column syndromes public.syndrome_category[] not null default '{}',
  add column geo_scope public.evidence_geo_scope,
  add column geo_region_id uuid references public.regions (id) on delete restrict,
  add column canonical_id text check (canonical_id is null or canonical_id ~ '^[a-z0-9][a-z0-9._-]{2,119}$'),
  add column valid_from date,
  add column valid_until date,
  add column review_due date,
  add column status public.evidence_status not null default 'draft',
  add column supersedes_id uuid references public.evidence_items (id) on delete restrict,
  add column licence text check (licence is null or char_length(licence) <= 200),
  add column source_domain text check (source_domain is null or source_domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  add column verification_basis text[] not null default '{}'
    check (verification_basis <@ array['domain_allowlist', 'curator_reviewed', 'doi_resolved']),
  add column is_synthetic boolean not null default false;

alter table public.evidence_items
  add constraint evidence_items_validity_chk check (valid_until is null or valid_from is null or valid_until >= valid_from),
  add constraint evidence_items_geo_chk check ((geo_scope in ('state', 'district')) = (geo_region_id is not null)),
  add constraint evidence_items_not_self_superseding_chk check (supersedes_id is distinct from id),
  add constraint evidence_items_topics_max_chk check (cardinality(topics) <= 12),
  -- A document can only be 'current' when it is fully described and has been reviewed by a human.
  add constraint evidence_items_current_ready_chk check (
    status <> 'current' or (
      evidence_kind is not null and geo_scope is not null and canonical_id is not null
      and cardinality(topics) > 0 and source_class <> 'unverified' and trust_level <> 'unreviewed')),
  -- Real (non-synthetic) current documents must be traceable to an allow-listed domain and a verification basis.
  add constraint evidence_items_real_provenance_chk check (
    status <> 'current' or is_synthetic or (source_domain is not null and cardinality(verification_basis) > 0));

create index evidence_items_status_idx on public.evidence_items (status);
create index evidence_items_canonical_idx on public.evidence_items (canonical_id);
create index evidence_items_topics_idx on public.evidence_items using gin (topics);
create index evidence_items_syndromes_idx on public.evidence_items using gin (syndromes);
create index evidence_items_geo_idx on public.evidence_items (geo_scope, geo_region_id);

create function public.evidence_items_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _bad text;
begin
  select t into _bad
  from unnest(new.topics) as t
  where not exists (select 1 from public.evidence_topics e where e.code = t and e.active)
  limit 1;
  if _bad is not null then
    raise exception 'evidence_topic_invalid: %', _bad using errcode = 'JS004';
  end if;

  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'quarantined') then
      raise exception 'new evidence must start as draft or quarantined' using errcode = 'JS007';
    end if;
    return new;
  end if;

  if new.is_synthetic is distinct from old.is_synthetic then
    raise exception 'is_synthetic is immutable' using errcode = 'JS008';
  end if;

  if new.status <> old.status then
    if not (
      (old.status = 'draft'       and new.status in ('quarantined', 'current', 'withdrawn')) or
      (old.status = 'quarantined' and new.status in ('draft', 'current', 'withdrawn')) or
      (old.status = 'current'     and new.status in ('superseded', 'withdrawn', 'historical', 'quarantined')) or
      (old.status = 'superseded'  and new.status in ('historical', 'withdrawn')) or
      (old.status = 'historical'  and new.status = 'withdrawn')
    ) then
      raise exception 'invalid evidence status transition % -> %', old.status, new.status using errcode = 'JS007';
    end if;
    if new.status = 'current' and not exists (
         select 1 from public.evidence_versions v where v.evidence_item_id = new.id and v.is_current) then
      raise exception 'a current document needs a current version' using errcode = 'JS007';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.evidence_items_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Versions and chunks (the unit of retrieval AND of citation)
-- ---------------------------------------------------------------------------
create table public.evidence_versions (
  id uuid primary key default gen_random_uuid(),
  evidence_item_id uuid not null references public.evidence_items (id) on delete restrict,
  version_label text not null check (char_length(btrim(version_label)) between 1 and 60),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  retrieved_at timestamptz,
  source_last_modified timestamptz,
  fetch_status text not null default 'not_fetched' check (fetch_status in ('not_fetched', 'ok', 'not_modified', 'changed', 'unreachable')),
  abstract text,
  licence_note text check (licence_note is null or char_length(licence_note) <= 500),
  is_current boolean not null default false,
  created_at timestamptz not null default now(),
  constraint evidence_versions_label_uk unique (evidence_item_id, version_label),
  constraint evidence_versions_hash_uk unique (evidence_item_id, content_hash),
  constraint evidence_versions_abstract_len_chk check (abstract is null or char_length(abstract) <= 4000),
  constraint evidence_versions_abstract_clean_chk check (
    abstract is null or (
      abstract !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
      and abstract !~ '[​-\u200F\u202A-\u202E⁠-⁤﻿]'
      and abstract !~ '<\s*/?\s*[a-zA-Z!][^>]*>'))
);
create unique index evidence_versions_one_current_uk on public.evidence_versions (evidence_item_id) where is_current;
create index evidence_versions_item_idx on public.evidence_versions (evidence_item_id);

create table public.evidence_chunks (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.evidence_versions (id) on delete restrict,
  ordinal integer not null check (ordinal >= 0),
  kind text not null check (kind in ('abstract', 'excerpt')),
  text text not null,
  chunk_hash text not null check (chunk_hash ~ '^[0-9a-f]{64}$'),
  language text not null default 'en' check (language in ('en', 'hi', 'or')),
  created_at timestamptz not null default now(),
  constraint evidence_chunks_order_uk unique (version_id, ordinal),
  constraint evidence_chunks_len_chk check (char_length(text) between 1 and 1500),
  -- DB backstop for the M4.1 sanitiser: plain text only (no markup, control or invisible characters).
  constraint evidence_chunks_plain_text_chk check (
    text !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
    and text !~ '[​-\u200F\u202A-\u202E⁠-⁤﻿]'
    and text !~ '<\s*/?\s*[a-zA-Z!][^>]*>')
);
create index evidence_chunks_version_idx on public.evidence_chunks (version_id);

create function public.evidence_chunks_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  _h text := encode(sha256(convert_to(new.text, 'UTF8')), 'hex');
begin
  if tg_op = 'UPDATE' then
    raise exception 'evidence chunks are immutable; add a new version instead' using errcode = 'JS008';
  end if;
  if new.chunk_hash is null then
    new.chunk_hash := _h;
  elsif new.chunk_hash <> _h then
    raise exception 'chunk_hash does not match text' using errcode = 'JS008';
  end if;
  return new;
end;
$$;
revoke all on function public.evidence_chunks_guard() from public, anon, authenticated;
create trigger evidence_chunks_guard_trg before insert or update on public.evidence_chunks
  for each row execute function public.evidence_chunks_guard();

create function public.evidence_versions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.content_hash, new.evidence_item_id, new.version_label, new.abstract)
       is distinct from (old.content_hash, old.evidence_item_id, old.version_label, old.abstract) then
    raise exception 'version content is immutable; add a new version instead' using errcode = 'JS008';
  end if;
  return new;
end;
$$;
revoke all on function public.evidence_versions_guard() from public, anon, authenticated;
create trigger evidence_versions_guard_trg before update on public.evidence_versions
  for each row execute function public.evidence_versions_guard();

create trigger evidence_items_guard_trg before insert or update on public.evidence_items
  for each row execute function public.evidence_items_guard();

-- Translations are stored with provenance and are never used for retrieval ranking in M4.
create table public.evidence_translations (
  id uuid primary key default gen_random_uuid(),
  evidence_item_id uuid not null references public.evidence_items (id) on delete restrict,
  language text not null check (language in ('hi', 'or')),
  title text not null check (char_length(btrim(title)) between 1 and 300),
  abstract text check (abstract is null or char_length(abstract) <= 4000),
  provenance text not null check (provenance in ('human', 'machine')),
  review_status text not null default 'draft' check (review_status in ('draft', 'reviewed')),
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint evidence_translations_uk unique (evidence_item_id, language),
  constraint evidence_translations_reviewed_chk check (review_status = 'draft' or reviewed_at is not null)
);

-- ---------------------------------------------------------------------------
-- Corpus snapshots, retrieval runs, bundles, citations
-- ---------------------------------------------------------------------------
create table public.corpus_snapshots (
  id uuid primary key default gen_random_uuid(),
  corpus_version text not null check (char_length(btrim(corpus_version)) between 1 and 100),
  corpus_hash text not null check (corpus_hash ~ '^[0-9a-f]{64}$'),
  item_count integer not null check (item_count >= 0),
  chunk_count integer not null check (chunk_count >= 0),
  includes_synthetic boolean not null,
  notes text check (notes is null or char_length(notes) <= 1000),
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  constraint corpus_snapshots_version_uk unique (corpus_version),
  constraint corpus_snapshots_hash_uk unique (corpus_hash)
);
create unique index corpus_snapshots_one_active_uk on public.corpus_snapshots (is_active) where is_active;

create table public.retrieval_runs (
  id uuid primary key default gen_random_uuid(),
  signal_candidate_id uuid not null references public.signal_candidates (id) on delete cascade,
  corpus_snapshot_id uuid not null references public.corpus_snapshots (id) on delete restrict,
  retrieval_version text not null,
  retrieval_config_hash text not null check (retrieval_config_hash ~ '^[0-9a-f]{64}$'),
  query_vocab_version text not null,
  as_of_date date not null,
  queries jsonb not null default '[]'::jsonb check (jsonb_typeof(queries) = 'array'),
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  stats jsonb not null default '{}'::jsonb,
  error text check (error is null or char_length(error) <= 2000),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index retrieval_runs_signal_idx on public.retrieval_runs (signal_candidate_id, started_at desc);

create table public.evidence_bundles (
  id uuid primary key default gen_random_uuid(),
  retrieval_run_id uuid not null references public.retrieval_runs (id) on delete cascade,
  signal_candidate_id uuid not null references public.signal_candidates (id) on delete cascade,
  bundle_hash text not null check (bundle_hash ~ '^[0-9a-f]{64}$'),
  schema_version text not null,
  bundle jsonb not null check (jsonb_typeof(bundle) = 'object'),
  item_count integer not null default 0 check (item_count >= 0),
  gap_count integer not null default 0 check (gap_count >= 0),
  conflict_count integer not null default 0 check (conflict_count >= 0),
  created_at timestamptz not null default now(),
  constraint evidence_bundles_signal_hash_uk unique (signal_candidate_id, bundle_hash)
);
create index evidence_bundles_run_idx on public.evidence_bundles (retrieval_run_id);

create table public.evidence_bundle_items (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references public.evidence_bundles (id) on delete cascade,
  evidence_version_id uuid not null references public.evidence_versions (id) on delete restrict,
  chunk_id uuid not null references public.evidence_chunks (id) on delete restrict,
  facet text not null check (char_length(facet) between 1 and 60),
  rank integer not null check (rank >= 1),
  citation_id text not null check (citation_id ~ '^E[0-9]{1,3}$'),
  score_components jsonb not null default '{}'::jsonb,
  why jsonb not null default '[]'::jsonb check (jsonb_typeof(why) = 'array'),
  constraint evidence_bundle_items_cite_uk unique (bundle_id, citation_id),
  constraint evidence_bundle_items_rank_uk unique (bundle_id, facet, rank)
);

create function public.evidence_bundle_items_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from public.evidence_chunks c where c.id = new.chunk_id and c.version_id = new.evidence_version_id) then
    raise exception 'chunk does not belong to the cited evidence version' using errcode = 'JS008';
  end if;
  return new;
end;
$$;
revoke all on function public.evidence_bundle_items_guard() from public, anon, authenticated;
create trigger evidence_bundle_items_guard_trg before insert on public.evidence_bundle_items
  for each row execute function public.evidence_bundle_items_guard();

-- ---------------------------------------------------------------------------
-- Generated explanations (summaries OF retrieved evidence) and their citations
-- ---------------------------------------------------------------------------
create table public.generated_explanations (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references public.evidence_bundles (id) on delete cascade,
  provider text not null check (char_length(provider) between 1 and 60),
  model text not null check (char_length(model) between 1 and 120),
  model_version text,
  prompt_version text not null check (char_length(prompt_version) between 1 and 120),
  params jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  language text not null default 'en' check (language in ('en', 'hi', 'or')),
  status text not null check (status in ('validated', 'rejected', 'fallback_extractive')),
  output jsonb,
  validation_report jsonb not null default '{}'::jsonb,
  citation_status text not null default 'verified' check (citation_status in ('verified', 'stale')),
  created_at timestamptz not null default now(),
  constraint generated_explanations_output_chk check ((status = 'rejected') or (output is not null and jsonb_typeof(output) = 'object')),
  constraint generated_explanations_idem_uk unique (bundle_id, prompt_version, provider, model, input_hash)
);

-- Raw model output is admin-only and kept apart from the validated, officer-readable explanation.
create table public.generated_explanation_raw (
  explanation_id uuid primary key references public.generated_explanations (id) on delete cascade,
  raw text not null check (char_length(raw) <= 200000),
  created_at timestamptz not null default now()
);

create table public.explanation_citations (
  id uuid primary key default gen_random_uuid(),
  explanation_id uuid not null references public.generated_explanations (id) on delete cascade,
  claim_index integer not null check (claim_index >= 0),
  bundle_item_id uuid not null references public.evidence_bundle_items (id) on delete restrict,
  quote text check (quote is null or char_length(quote) <= 600),
  anchor_verified boolean not null default false,
  support_check jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint explanation_citations_uk unique (explanation_id, claim_index, bundle_item_id)
);

create function public.explanation_citations_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
       select 1 from public.generated_explanations g
       join public.evidence_bundle_items i on i.bundle_id = g.bundle_id
       where g.id = new.explanation_id and i.id = new.bundle_item_id) then
    raise exception 'a citation must point to an item of the explanation''s own bundle' using errcode = 'JS008';
  end if;
  return new;
end;
$$;
revoke all on function public.explanation_citations_guard() from public, anon, authenticated;
create trigger explanation_citations_guard_trg before insert on public.explanation_citations
  for each row execute function public.explanation_citations_guard();

-- Append-only: bundles, bundle items and citations are never edited in place (re-run to produce a new bundle).
create function public.m4_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% rows are append-only', tg_table_name using errcode = 'JS008';
end;
$$;
revoke all on function public.m4_append_only() from public, anon, authenticated;
create trigger evidence_bundles_append_only before update on public.evidence_bundles
  for each row execute function public.m4_append_only();
create trigger evidence_bundle_items_append_only before update on public.evidence_bundle_items
  for each row execute function public.m4_append_only();
create trigger explanation_citations_append_only before update on public.explanation_citations
  for each row execute function public.m4_append_only();

-- Generated explanations are append-only too, except the stale-citation flag set by the re-validation job.
create function public.generated_explanations_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.bundle_id, new.provider, new.model, new.model_version, new.prompt_version, new.params, new.input_hash,
      new.language, new.status, new.output, new.validation_report, new.created_at)
     is not distinct from
     (old.bundle_id, old.provider, old.model, old.model_version, old.prompt_version, old.params, old.input_hash,
      old.language, old.status, old.output, old.validation_report, old.created_at) then
    return new; -- only citation_status may differ
  end if;
  raise exception 'generated_explanations rows are append-only (only citation_status may change)' using errcode = 'JS008';
end;
$$;
revoke all on function public.generated_explanations_guard() from public, anon, authenticated;
create trigger generated_explanations_guard_trg before update on public.generated_explanations
  for each row execute function public.generated_explanations_guard();

-- ---------------------------------------------------------------------------
-- Evaluation results (synthetic benchmark outcomes; admin-only)
-- ---------------------------------------------------------------------------
create table public.evidence_evaluation_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('dev', 'test', 'adversarial', 'judge_validation')),
  retrieval_config_hash text not null check (retrieval_config_hash ~ '^[0-9a-f]{64}$'),
  prompt_version text,
  corpus_hash text not null check (corpus_hash ~ '^[0-9a-f]{64}$'),
  scenario_set_ref text not null,
  n_scenarios integer not null check (n_scenarios >= 0),
  metrics jsonb not null,
  disclaimer text not null default 'Synthetic corpus and scenarios: validates the pipeline, not real-world retrieval or summary quality.',
  created_at timestamptz not null default now(),
  constraint evidence_evaluation_runs_uk unique (kind, retrieval_config_hash, prompt_version, corpus_hash, scenario_set_ref)
);
create table public.evidence_evaluation_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.evidence_evaluation_runs (id) on delete cascade,
  scenario_id text not null,
  passed boolean not null,
  metrics jsonb not null default '{}'::jsonb,
  constraint evidence_evaluation_results_uk unique (run_id, scenario_id)
);

-- ---------------------------------------------------------------------------
-- Privileges (revoke first; corpus/bundle/generation tables are service-only writes)
-- ---------------------------------------------------------------------------
revoke all on public.evidence_topics, public.evidence_versions, public.evidence_chunks, public.evidence_translations,
  public.corpus_snapshots, public.retrieval_runs, public.evidence_bundles, public.evidence_bundle_items,
  public.generated_explanations, public.generated_explanation_raw, public.explanation_citations,
  public.evidence_evaluation_runs, public.evidence_evaluation_results
  from anon, authenticated;

grant select on public.evidence_topics, public.evidence_versions, public.evidence_chunks, public.evidence_translations,
  public.corpus_snapshots, public.retrieval_runs, public.evidence_bundles, public.evidence_bundle_items,
  public.generated_explanations, public.explanation_citations
  to authenticated;
grant select on public.generated_explanation_raw, public.evidence_evaluation_runs, public.evidence_evaluation_results to authenticated; -- RLS: admin only

-- New evidence_items columns: admin curation (RLS still restricts writes to admins).
grant insert (source_class, evidence_kind, topics, syndromes, geo_scope, geo_region_id, canonical_id, valid_from, valid_until,
              review_due, status, supersedes_id, licence, source_domain, verification_basis, is_synthetic)
  on public.evidence_items to authenticated;
grant update (source_class, evidence_kind, topics, syndromes, geo_scope, geo_region_id, canonical_id, valid_from, valid_until,
              review_due, status, supersedes_id, licence, source_domain, verification_basis)
  on public.evidence_items to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.evidence_topics enable row level security;
alter table public.evidence_versions enable row level security;
alter table public.evidence_chunks enable row level security;
alter table public.evidence_translations enable row level security;
alter table public.corpus_snapshots enable row level security;
alter table public.retrieval_runs enable row level security;
alter table public.evidence_bundles enable row level security;
alter table public.evidence_bundle_items enable row level security;
alter table public.generated_explanations enable row level security;
alter table public.generated_explanation_raw enable row level security;
alter table public.explanation_citations enable row level security;
alter table public.evidence_evaluation_runs enable row level security;
alter table public.evidence_evaluation_results enable row level security;

-- Replace the M2 evidence policy: only CURRENT documents are visible outside admin curation.
-- Citizens additionally need trusted + non-synthetic + a real issuer class.
drop policy evidence_items_select on public.evidence_items;
create policy evidence_items_select on public.evidence_items for select to authenticated
  using (
    public.has_role((select auth.uid()), 'admin')
    or (
      status = 'current'
      and (
        public.has_role((select auth.uid()), 'officer')
        or public.has_role((select auth.uid()), 'clinician')
        or (trust_level = 'trusted' and not is_synthetic and source_class <> 'unverified')
      )
    )
  );

-- Versions / chunks / translations are exactly as visible as their document (the subquery is RLS-filtered).
create policy evidence_versions_select on public.evidence_versions for select to authenticated
  using (exists (select 1 from public.evidence_items i where i.id = evidence_item_id));
create policy evidence_chunks_select on public.evidence_chunks for select to authenticated
  using (exists (select 1 from public.evidence_versions v where v.id = version_id));
create policy evidence_translations_select on public.evidence_translations for select to authenticated
  using (exists (select 1 from public.evidence_items i where i.id = evidence_item_id));

create policy evidence_topics_select on public.evidence_topics for select to authenticated
  using (public.has_role((select auth.uid()), 'admin') or public.has_role((select auth.uid()), 'officer') or public.has_role((select auth.uid()), 'clinician'));

create policy corpus_snapshots_select on public.corpus_snapshots for select to authenticated
  using (public.has_role((select auth.uid()), 'admin') or public.has_role((select auth.uid()), 'officer'));

-- Runs, bundles, explanations and citations: visible exactly when the parent signal is visible
-- (admins; officers inside the signal's region scope). The subqueries are themselves RLS-filtered.
create policy retrieval_runs_select on public.retrieval_runs for select to authenticated
  using (exists (select 1 from public.signal_candidates s where s.id = signal_candidate_id));
create policy evidence_bundles_select on public.evidence_bundles for select to authenticated
  using (exists (select 1 from public.signal_candidates s where s.id = signal_candidate_id));
create policy evidence_bundle_items_select on public.evidence_bundle_items for select to authenticated
  using (exists (select 1 from public.evidence_bundles b where b.id = bundle_id));
create policy generated_explanations_select on public.generated_explanations for select to authenticated
  using (exists (select 1 from public.evidence_bundles b where b.id = bundle_id));
create policy explanation_citations_select on public.explanation_citations for select to authenticated
  using (exists (select 1 from public.generated_explanations g where g.id = explanation_id));

create policy generated_explanation_raw_select on public.generated_explanation_raw for select to authenticated
  using (public.has_role((select auth.uid()), 'admin'));
create policy evidence_evaluation_runs_select on public.evidence_evaluation_runs for select to authenticated
  using (public.has_role((select auth.uid()), 'admin'));
create policy evidence_evaluation_results_select on public.evidence_evaluation_results for select to authenticated
  using (public.has_role((select auth.uid()), 'admin'));

-- ---------------------------------------------------------------------------
-- Audit (field names only; chunk-level writes are not audited for volume)
-- ---------------------------------------------------------------------------
create trigger evidence_versions_audit after insert or update on public.evidence_versions
  for each row execute function public.audit_row_change();
create trigger evidence_translations_audit after insert or update on public.evidence_translations
  for each row execute function public.audit_row_change();
create trigger corpus_snapshots_audit after insert or update on public.corpus_snapshots
  for each row execute function public.audit_row_change();
create trigger retrieval_runs_audit after insert or update on public.retrieval_runs
  for each row execute function public.audit_row_change();
create trigger evidence_bundles_audit after insert on public.evidence_bundles
  for each row execute function public.audit_row_change();
create trigger generated_explanations_audit after insert on public.generated_explanations
  for each row execute function public.audit_row_change();
create trigger evidence_evaluation_runs_audit after insert on public.evidence_evaluation_runs
  for each row execute function public.audit_row_change();
