-- JanSanket M2 (1/2): core health-signal data foundation — SCHEMA.
-- A health report is an OBSERVATION, not a diagnosis. A signal candidate is a population-level
-- pattern that may need investigation, never a confirmed outbreak.
-- Security (RLS, grants, privileged functions) lives in the next migration.
--
-- Privacy tiers:  RAW (health_reports) -> DEIDENTIFIED (deidentified_observations) -> AGGREGATED (report_aggregates)

-- ---------------------------------------------------------------------------
-- Controlled vocabularies (enums). Extend with ALTER TYPE ... ADD VALUE in a new migration.
-- ---------------------------------------------------------------------------
create type public.region_type as enum ('country', 'state', 'district', 'block', 'locality');

create type public.source_type as enum (
  'citizen', 'clinician', 'health_facility', 'public_health_officer',
  'survey', 'environmental', 'imported_dataset', 'system_generated'
);

create type public.report_type as enum ('individual_observation', 'aggregate_count');

create type public.report_severity as enum ('unknown', 'mild', 'moderate', 'severe');

create type public.age_band as enum ('age_0_4', 'age_5_17', 'age_18_44', 'age_45_59', 'age_60_plus', 'age_unknown');

create type public.syndrome_category as enum (
  'acute_diarrhoeal_illness', 'fever', 'fever_with_rash', 'jaundice', 'respiratory_illness', 'other', 'unknown'
);

create type public.privacy_level as enum ('raw', 'deidentified', 'aggregated');

create type public.processing_status as enum ('received', 'validated', 'deidentified', 'rejected');

create type public.signal_status as enum ('candidate', 'under_review', 'verified', 'monitoring', 'resolved', 'dismissed');

-- Result of HUMAN verification. 'supported' means an officer judged the signal worth acting on;
-- it is NOT a confirmed diagnosis or outbreak declaration.
create type public.verification_status as enum ('unverified', 'in_progress', 'supported', 'not_supported', 'inconclusive');

create type public.signal_origin as enum ('system_detector', 'officer_manual', 'imported');

create type public.evidence_source_type as enum (
  'guideline', 'government_advisory', 'peer_reviewed', 'situation_report', 'dataset', 'other'
);

create type public.evidence_trust_level as enum ('unreviewed', 'reviewed', 'trusted');

-- ---------------------------------------------------------------------------
-- Regions: one self-referencing hierarchy (country > state > district > block > locality).
-- ---------------------------------------------------------------------------
create table public.regions (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  name_local jsonb not null default '{}'::jsonb check (jsonb_typeof(name_local) = 'object'),
  region_type public.region_type not null,
  parent_region_id uuid references public.regions (id) on delete restrict,
  administrative_code text check (administrative_code is null or char_length(administrative_code) between 1 and 64),
  is_synthetic boolean not null default false, -- demo geography: codes/boundaries are NOT authoritative
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint regions_root_has_no_parent check ((region_type = 'country') = (parent_region_id is null)),
  constraint regions_not_own_parent check (parent_region_id is distinct from id)
);
create unique index regions_administrative_code_uk on public.regions (administrative_code) where administrative_code is not null;
create unique index regions_parent_name_uk
  on public.regions (coalesce(parent_region_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create index regions_parent_idx on public.regions (parent_region_id);
create index regions_type_active_idx on public.regions (region_type) where active;

create function public.regions_validate()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  _parent_type public.region_type;
  _expected public.region_type;
begin
  if tg_op = 'UPDATE' then
    if new.region_type is distinct from old.region_type
       or new.parent_region_id is distinct from old.parent_region_id then
      raise exception 'region_type and parent_region_id are immutable' using errcode = 'JS008';
    end if;
    new.updated_at := now();
    return new;
  end if;

  if new.region_type <> 'country' then
    select r.region_type into _parent_type from public.regions r where r.id = new.parent_region_id;
    _expected := case new.region_type
      when 'state' then 'country'::public.region_type
      when 'district' then 'state'::public.region_type
      when 'block' then 'district'::public.region_type
      when 'locality' then 'block'::public.region_type
    end;
    if _parent_type is distinct from _expected then
      raise exception 'a % must have a % parent (got %)', new.region_type, _expected, coalesce(_parent_type::text, 'none')
        using errcode = 'JS003';
    end if;
  end if;
  return new;
end;
$$;

create trigger regions_validate_trg
  before insert or update on public.regions
  for each row execute function public.regions_validate();

-- Region helpers (used by RLS policies and functions).
create function public.region_subtree(_root uuid)
returns table (id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive t as (
    select r.id from public.regions r where r.id = _root
    union all
    select c.id from public.regions c join t on c.parent_region_id = t.id
  )
  select t.id from t;
$$;

-- True when _user holds _role with a region scope that contains _region.
-- A role row with NULL region_id grants NO regional access (scope must be explicit).
create function public.is_region_in_scope(_user_id uuid, _role public.app_role, _region_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    where ur.user_id = _user_id
      and ur.role = _role
      and ur.region_id is not null
      and _region_id in (select s.id from public.region_subtree(ur.region_id) s)
  );
$$;

-- Region scope on role rows (the M1 column gets its foreign key now).
alter table public.user_roles
  add constraint user_roles_region_id_fkey foreign key (region_id) references public.regions (id) on delete restrict;
alter table public.user_roles
  add constraint user_roles_scope_only_for_regional_roles check (region_id is null or role in ('clinician', 'officer'));

-- ---------------------------------------------------------------------------
-- Reference vocabularies
-- ---------------------------------------------------------------------------
create table public.symptom_terms (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  syndrome_hint public.syndrome_category,
  label_en text not null,
  label_hi text,
  label_or text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.symptom_terms (code, syndrome_hint, label_en, label_hi, label_or) values
  ('diarrhoea',        'acute_diarrhoeal_illness', 'Loose stools / diarrhoea', 'दस्त', 'ଝାଡ଼ା'),
  ('vomiting',         'acute_diarrhoeal_illness', 'Vomiting', 'उल्टी', 'ବାନ୍ତି'),
  ('dehydration_signs','acute_diarrhoeal_illness', 'Signs of dehydration', 'निर्जलीकरण के लक्षण', 'ଶରୀରରେ ପାଣି ଅଭାବ'),
  ('abdominal_pain',   'acute_diarrhoeal_illness', 'Abdominal pain', 'पेट दर्द', 'ପେଟ ଯନ୍ତ୍ରଣା'),
  ('fever',            'fever',                    'Fever', 'बुखार', 'ଜ୍ୱର'),
  ('headache',         'fever',                    'Headache', 'सिरदर्द', 'ମୁଣ୍ଡବିନ୍ଧା'),
  ('body_ache',        'fever',                    'Body ache', 'बदन दर्द', 'ଦେହ ବିନ୍ଧା'),
  ('rash',             'fever_with_rash',          'Skin rash', 'त्वचा पर दाने', 'ଚର୍ମରେ ଦାଗ'),
  ('jaundice',         'jaundice',                 'Yellow eyes / skin', 'पीलिया', 'ଜଣ୍ଡିସ'),
  ('dark_urine',       'jaundice',                 'Dark urine', 'गहरे रंग का पेशाब', 'ଗାଢ଼ ରଙ୍ଗର ପରିସ୍ରା'),
  ('cough',            'respiratory_illness',      'Cough', 'खांसी', 'କାଶ'),
  ('breathlessness',   'respiratory_illness',      'Difficulty breathing', 'सांस लेने में तकलीफ', 'ଶ୍ୱାସକଷ୍ଟ');

-- Demonstration/operational parameters. These are CONFIGURABLE DEMO VALUES, not universal
-- privacy guarantees or legal retention periods.
create table public.privacy_settings (
  key text primary key,
  value_int integer not null check (value_int >= 0),
  description text not null,
  updated_at timestamptz not null default now()
);

insert into public.privacy_settings (key, value_int, description) values
  ('min_aggregate_cell_size', 5,
   'DEMONSTRATION PARAMETER. Aggregate cells with fewer cases than this are suppressed in officer-facing output. Not a universal privacy guarantee; set by policy review.'),
  ('raw_free_text_retention_days', 30,
   'DEMONSTRATION PARAMETER. Free text on raw health reports is cleared after this many days by apply_report_retention().'),
  ('raw_identity_retention_days', 365,
   'DEMONSTRATION PARAMETER. The submitter link on raw health reports is cleared after this many days by apply_report_retention().');

create table public.detection_methods (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  description text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.detection_methods (code, description) values
  ('unspecified', 'Method not recorded.'),
  ('manual', 'Raised manually by a human reviewer.');

-- ---------------------------------------------------------------------------
-- health_reports (RAW tier): one observation. Data-minimised: no GPS, no address, no phone,
-- no email, no DOB, no national ID. Coarse region + age band + controlled vocabularies only.
-- ---------------------------------------------------------------------------
create table public.health_reports (
  id uuid primary key default gen_random_uuid(),
  client_submission_id uuid not null default gen_random_uuid(), -- idempotency key (offline retry safe)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  observed_at timestamptz not null,
  submitted_by uuid default auth.uid() references auth.users (id) on delete set null,
  source_type public.source_type not null,
  region_id uuid not null references public.regions (id) on delete restrict,
  report_type public.report_type not null default 'individual_observation',
  syndrome public.syndrome_category not null,
  symptom_codes text[] not null default '{}',
  severity public.report_severity not null default 'unknown',
  age_band public.age_band not null default 'age_unknown',
  case_count integer not null default 1,
  language text not null default 'en',
  privacy_level public.privacy_level not null default 'raw',
  processing_status public.processing_status not null default 'received',
  free_text text,
  synthetic_batch text,
  constraint health_reports_language_chk check (language in ('en', 'hi', 'or')),
  constraint health_reports_raw_tier_chk check (privacy_level = 'raw'),
  constraint health_reports_symptom_count_chk check (cardinality(symptom_codes) <= 10),
  constraint health_reports_case_count_chk check (case_count between 1 and 10000),
  constraint health_reports_individual_single_chk check (report_type = 'aggregate_count' or case_count = 1),
  constraint health_reports_citizen_individual_chk check (report_type = 'individual_observation' or source_type <> 'citizen'),
  constraint health_reports_free_text_len_chk check (free_text is null or char_length(free_text) <= 500),
  -- Backstop for the TS sanitiser: reject long digit runs (phones / national IDs) and e-mail addresses.
  -- Heuristic defence-in-depth, not a guarantee that free text is PII-free.
  constraint health_reports_free_text_no_pii check (
    free_text is null
    or (free_text !~ '(\d[\s.-]?){10,}' and free_text !~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}')
  ),
  constraint health_reports_synthetic_batch_chk check (synthetic_batch is null or char_length(synthetic_batch) between 1 and 64),
  constraint health_reports_idempotency_uk unique (submitted_by, client_submission_id)
);

create index health_reports_region_observed_idx on public.health_reports (region_id, observed_at desc);
create index health_reports_observed_idx on public.health_reports (observed_at desc);
create index health_reports_source_idx on public.health_reports (source_type);
create index health_reports_pending_idx on public.health_reports (created_at) where processing_status in ('received', 'validated');
create index health_reports_submitter_idx on public.health_reports (submitted_by, created_at desc) where submitted_by is not null;
create index health_reports_synthetic_idx on public.health_reports (synthetic_batch) where synthetic_batch is not null;

create function public.health_reports_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _rtype public.region_type;
  _active boolean;
  _bad text;
  _norm text[];
begin
  if tg_op = 'INSERT' then
    -- Region: must exist, be active, and be coarse enough (block or locality).
    -- (A NULL region_id is left to the NOT NULL constraint so the error is the standard one.)
    if new.region_id is not null then
      select r.region_type, r.active into _rtype, _active from public.regions r where r.id = new.region_id;
      if not found then
        raise exception 'region_not_found' using errcode = 'JS001';
      end if;
      if not _active then
        raise exception 'region_inactive' using errcode = 'JS002';
      end if;
      if _rtype not in ('block', 'locality') then
        raise exception 'region_level_invalid: reports must reference a block or locality (got %)', _rtype using errcode = 'JS003';
      end if;
    end if;

    -- Symptom codes: normalise (dedupe, sort) and require known active codes.
    select coalesce(array_agg(distinct c order by c), '{}') into _norm from unnest(new.symptom_codes) as c;
    new.symptom_codes := _norm;
    select c into _bad
    from unnest(new.symptom_codes) as c
    where not exists (select 1 from public.symptom_terms t where t.code = c and t.active)
    limit 1;
    if _bad is not null then
      raise exception 'symptom_code_invalid: %', _bad using errcode = 'JS004';
    end if;

    -- Timestamps.
    if new.observed_at > now() + interval '5 minutes' then
      raise exception 'observed_at_in_future' using errcode = 'JS005';
    end if;
    if new.synthetic_batch is null
       and new.source_type in ('citizen', 'clinician', 'health_facility', 'public_health_officer')
       and new.observed_at < now() - interval '90 days' then
      raise exception 'observed_at_too_old: live submissions must be within 90 days' using errcode = 'JS005';
    end if;

    new.free_text := nullif(btrim(regexp_replace(coalesce(new.free_text, ''), '\s+', ' ', 'g')), '');
    new.updated_at := now();
    return new;
  end if;

  -- UPDATE: observation content is immutable. Only lifecycle + privacy-driven clearing is allowed.
  if (new.id, new.client_submission_id, new.created_at, new.observed_at, new.source_type, new.region_id,
      new.report_type, new.syndrome, new.symptom_codes, new.severity, new.age_band, new.case_count,
      new.language, new.privacy_level, new.synthetic_batch)
     is distinct from
     (old.id, old.client_submission_id, old.created_at, old.observed_at, old.source_type, old.region_id,
      old.report_type, old.syndrome, old.symptom_codes, old.severity, old.age_band, old.case_count,
      old.language, old.privacy_level, old.synthetic_batch) then
    raise exception 'health report content is immutable' using errcode = 'JS008';
  end if;
  if new.free_text is not null and new.free_text is distinct from old.free_text then
    raise exception 'free_text may only be cleared, not changed' using errcode = 'JS008';
  end if;
  if new.submitted_by is not null and new.submitted_by is distinct from old.submitted_by then
    raise exception 'submitted_by may only be cleared, not changed' using errcode = 'JS008';
  end if;

  if new.processing_status <> old.processing_status then
    if not (
      (old.processing_status = 'received'  and new.processing_status in ('validated', 'deidentified', 'rejected')) or
      (old.processing_status = 'validated' and new.processing_status in ('deidentified', 'rejected'))
    ) then
      raise exception 'invalid processing_status transition % -> %', old.processing_status, new.processing_status
        using errcode = 'JS007';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger health_reports_guard_trg
  before insert or update on public.health_reports
  for each row execute function public.health_reports_guard();

-- ---------------------------------------------------------------------------
-- deidentified_observations (DEIDENTIFIED tier): derived, coarsened to block + day, no submitter,
-- no free text, no client id. Service-side input to detection; NOT exposed to clients in M2.
-- ---------------------------------------------------------------------------
create table public.deidentified_observations (
  id uuid primary key default gen_random_uuid(),
  report_id uuid unique references public.health_reports (id) on delete set null, -- unlinked if the raw report is deleted
  observed_date date not null,
  region_id uuid not null references public.regions (id) on delete restrict, -- block level
  source_type public.source_type not null,
  report_type public.report_type not null,
  syndrome public.syndrome_category not null,
  symptom_codes text[] not null default '{}',
  severity public.report_severity not null,
  age_band public.age_band not null,
  case_count integer not null check (case_count >= 1),
  privacy_level public.privacy_level not null default 'deidentified',
  is_synthetic boolean not null default false,
  created_at timestamptz not null default now(),
  constraint deidentified_observations_tier_chk check (privacy_level = 'deidentified')
);
create index deidentified_obs_region_date_idx on public.deidentified_observations (region_id, observed_date, syndrome);
create index deidentified_obs_date_idx on public.deidentified_observations (observed_date);

-- ---------------------------------------------------------------------------
-- report_aggregates (AGGREGATED tier): block x day x syndrome. True counts are stored for
-- service-side use; client access goes ONLY through get_report_aggregates(), which masks
-- suppressed cells.
-- ---------------------------------------------------------------------------
create table public.report_aggregates (
  id uuid primary key default gen_random_uuid(),
  region_id uuid not null references public.regions (id) on delete restrict,
  observed_date date not null,
  syndrome public.syndrome_category not null,
  report_count integer not null check (report_count > 0),
  case_count integer not null check (case_count > 0),
  suppressed boolean not null,
  min_cell_size_applied integer not null check (min_cell_size_applied >= 0),
  privacy_level public.privacy_level not null default 'aggregated',
  computed_at timestamptz not null default now(),
  constraint report_aggregates_tier_chk check (privacy_level = 'aggregated'),
  constraint report_aggregates_cell_uk unique (region_id, observed_date, syndrome)
);
create index report_aggregates_date_idx on public.report_aggregates (observed_date);
create index report_aggregates_region_date_idx on public.report_aggregates (region_id, observed_date);

-- ---------------------------------------------------------------------------
-- signal_candidates: a population-level pattern that MAY need investigation.
-- M2 only defines the contract; M3 will populate it. Scores/baselines are never computed here.
-- ---------------------------------------------------------------------------
create table public.signal_candidates (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  region_id uuid not null references public.regions (id) on delete restrict,
  time_window_start timestamptz not null,
  time_window_end timestamptz not null,
  syndrome public.syndrome_category not null,
  observed_value numeric not null check (observed_value >= 0),
  baseline_value numeric check (baseline_value is null or baseline_value >= 0),
  deviation numeric,
  signal_score numeric check (signal_score is null or signal_score >= 0),
  sample_count integer check (sample_count is null or sample_count >= 0),
  minimum_sample_count integer not null default 1 check (minimum_sample_count >= 1),
  detection_method text not null default 'unspecified' references public.detection_methods (code),
  confidence numeric(4, 3) check (confidence is null or confidence between 0 and 1),
  status public.signal_status not null default 'candidate',
  verification_status public.verification_status not null default 'unverified',
  explanation text check (explanation is null or char_length(explanation) <= 4000),
  origin public.signal_origin not null default 'system_detector',
  created_by uuid references auth.users (id) on delete set null,
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  review_note text check (review_note is null or char_length(review_note) <= 1000),
  resolved_at timestamptz,
  constraint signal_candidates_window_chk check (time_window_end > time_window_start),
  constraint signal_candidates_resolved_chk check ((status in ('resolved', 'dismissed')) = (resolved_at is not null)),
  -- Lifecycle <-> verification coupling.
  constraint signal_candidates_candidate_unverified_chk check (status <> 'candidate' or verification_status = 'unverified'),
  constraint signal_candidates_review_state_chk check (status <> 'under_review' or verification_status in ('unverified', 'in_progress')),
  constraint signal_candidates_verified_supported_chk check (status not in ('verified', 'monitoring') or verification_status = 'supported'),
  constraint signal_candidates_dismissed_not_supported_chk check (status <> 'dismissed' or verification_status <> 'supported'),
  constraint signal_candidates_unique_run_uk unique (region_id, syndrome, time_window_start, time_window_end, detection_method)
);
create index signal_candidates_region_window_idx on public.signal_candidates (region_id, time_window_start desc);
create index signal_candidates_status_idx on public.signal_candidates (status) where status in ('candidate', 'under_review', 'verified', 'monitoring');
create index signal_candidates_syndrome_window_idx on public.signal_candidates (syndrome, time_window_start desc);
create index signal_candidates_created_idx on public.signal_candidates (created_at desc);

create function public.signal_candidates_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if (new.region_id, new.syndrome, new.time_window_start, new.time_window_end, new.detection_method, new.created_at, new.origin)
       is distinct from
       (old.region_id, old.syndrome, old.time_window_start, old.time_window_end, old.detection_method, old.created_at, old.origin) then
      raise exception 'signal identity (region, syndrome, window, method) is immutable' using errcode = 'JS008';
    end if;

    if new.status <> old.status and not (
      (old.status = 'candidate'    and new.status in ('under_review', 'dismissed')) or
      (old.status = 'under_review' and new.status in ('verified', 'dismissed')) or
      (old.status = 'verified'     and new.status in ('monitoring', 'resolved')) or
      (old.status = 'monitoring'   and new.status = 'resolved')
    ) then
      raise exception 'invalid signal status transition % -> %', old.status, new.status using errcode = 'JS007';
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger signal_candidates_guard_trg
  before insert or update on public.signal_candidates
  for each row execute function public.signal_candidates_guard();

-- ---------------------------------------------------------------------------
-- Evidence foundation (no embeddings / retrieval in M2).
-- ---------------------------------------------------------------------------
create table public.evidence_items (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 300),
  publisher text not null check (char_length(btrim(publisher)) between 1 and 200),
  source_type public.evidence_source_type not null,
  reference_url text check (reference_url is null or reference_url ~* '^https?://'),
  citation text check (citation is null or char_length(citation) <= 1000),
  publication_date date,
  language text check (language is null or language in ('en', 'hi', 'or')),
  content_hash text check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  trust_level public.evidence_trust_level not null default 'unreviewed',
  verified_by uuid references auth.users (id) on delete set null,
  verified_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint evidence_items_has_reference_chk check (reference_url is not null or citation is not null),
  constraint evidence_items_trust_verified_chk check (trust_level = 'unreviewed' or verified_at is not null)
);
create unique index evidence_items_content_hash_uk on public.evidence_items (content_hash) where content_hash is not null;
create unique index evidence_items_url_uk on public.evidence_items (lower(reference_url)) where reference_url is not null;
create index evidence_items_trust_idx on public.evidence_items (trust_level);
create index evidence_items_published_idx on public.evidence_items (publication_date desc);

create function public.touch_updated_at_generic()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger evidence_items_touch_trg
  before update on public.evidence_items
  for each row execute function public.touch_updated_at_generic();

create table public.signal_evidence (
  signal_candidate_id uuid not null references public.signal_candidates (id) on delete cascade,
  evidence_item_id uuid not null references public.evidence_items (id) on delete restrict,
  relevance_note text check (relevance_note is null or char_length(relevance_note) <= 500),
  created_at timestamptz not null default now(),
  primary key (signal_candidate_id, evidence_item_id)
);
create index signal_evidence_evidence_idx on public.signal_evidence (evidence_item_id);

-- ---------------------------------------------------------------------------
-- report_signal_links: traces a signal back to DEIDENTIFIED observations or AGGREGATE cells.
-- Deliberately never references raw health_reports, so a contributing report is not exposed
-- to a reviewer merely because it contributed to a signal.
-- ---------------------------------------------------------------------------
create table public.report_signal_links (
  id uuid primary key default gen_random_uuid(),
  signal_candidate_id uuid not null references public.signal_candidates (id) on delete cascade,
  observation_id uuid references public.deidentified_observations (id) on delete cascade,
  aggregate_id uuid references public.report_aggregates (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint report_signal_links_one_target_chk check (num_nonnulls(observation_id, aggregate_id) = 1)
);
create unique index report_signal_links_obs_uk on public.report_signal_links (signal_candidate_id, observation_id) where observation_id is not null;
create unique index report_signal_links_agg_uk on public.report_signal_links (signal_candidate_id, aggregate_id) where aggregate_id is not null;
create index report_signal_links_observation_idx on public.report_signal_links (observation_id) where observation_id is not null;
create index report_signal_links_aggregate_idx on public.report_signal_links (aggregate_id) where aggregate_id is not null;

-- Trigger/helper functions are internal: API roles must not be able to execute the trigger functions.
revoke all on function public.regions_validate() from public, anon, authenticated;
revoke all on function public.health_reports_guard() from public, anon, authenticated;
revoke all on function public.signal_candidates_guard() from public, anon, authenticated;
revoke all on function public.touch_updated_at_generic() from public, anon, authenticated;
