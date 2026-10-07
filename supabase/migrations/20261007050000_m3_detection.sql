-- JanSanket M3: statistical signal detection — provenance, findings, evaluation, and safe candidate upserts.
-- No LLM, no ML model, no vectors. The detector is deterministic TypeScript run with the service role; this
-- migration gives it (a) a feature function over the DEIDENTIFIED tier, (b) an idempotent, invariant-checked
-- path into signal_candidates, and (c) provenance/evaluation tables.
--
-- signal_score is a transparent RANKING/PRIORITY score; confidence is an EVIDENCE-SUFFICIENCY index.
-- Neither is a probability that an event is real, a probability of an outbreak, or a diagnostic confidence.

insert into public.detection_methods (code, description) values
  ('windowed_gamma_poisson_v1', 'Windowed Gamma-Poisson predictive exceedance with day-of-week-adjusted, exponentially weighted baseline, evidence/persistence/survival gates (detector v1).')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Provenance
-- ---------------------------------------------------------------------------
create table public.detector_runs (
  id uuid primary key default gen_random_uuid(),
  detector_name text not null check (char_length(detector_name) between 1 and 100),
  detector_version text not null check (char_length(detector_version) between 1 and 100),
  method_code text not null references public.detection_methods (code),
  config jsonb not null,
  config_hash text not null check (config_hash ~ '^[0-9a-f]{64}$'),
  mode text not null check (mode in ('replay', 'as_of')),
  data_from date not null,
  data_to date not null,
  as_of_from date,
  as_of_to date,
  input_row_count integer not null default 0 check (input_row_count >= 0),
  input_hash text check (input_hash is null or input_hash ~ '^[0-9a-f]{64}$'),
  code_version text check (code_version is null or char_length(code_version) <= 100),
  privacy_k_applied integer not null check (privacy_k_applied >= 1),
  evidence_floor integer not null check (evidence_floor >= 1),
  stats jsonb not null default '{}'::jsonb,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  error text check (error is null or char_length(error) <= 2000),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint detector_runs_range_chk check (data_to >= data_from)
);
create index detector_runs_started_idx on public.detector_runs (started_at desc);

-- Screened tests (candidate / watch / gated). Counts below the suppression threshold are never stored.
create table public.detector_findings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.detector_runs (id) on delete cascade,
  as_of_date date not null,
  district_id uuid not null references public.regions (id) on delete restrict,
  block_ids uuid[] not null,
  scope text not null check (scope in ('block', 'cluster', 'district')),
  syndrome public.syndrome_category not null,
  window_days integer not null check (window_days between 1 and 60),
  observed integer, -- NULL when below the suppression threshold (enforced by trigger)
  expected numeric not null check (expected >= 0),
  p_value double precision not null check (p_value >= 0 and p_value <= 1),
  ratio numeric,
  decision text not null check (decision in ('candidate', 'watch', 'gated')),
  failed_gates text[] not null default '{}' check (failed_gates <@ array['evidence', 'persistence', 'burst', 'bulk', 'ratio', 'concentration']),
  score numeric check (score is null or (score >= 0 and score <= 100)),
  candidate_id uuid references public.signal_candidates (id) on delete set null,
  created_at timestamptz not null default now()
);
create index detector_findings_run_idx on public.detector_findings (run_id);
create index detector_findings_district_date_idx on public.detector_findings (district_id, as_of_date desc);

-- ---------------------------------------------------------------------------
-- Evaluation (synthetic benchmark results; ground truth itself is NEVER stored in this database)
-- ---------------------------------------------------------------------------
create table public.evaluation_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('primary', 'held_out_replicates', 'null_calibration')),
  detector_version text not null,
  config_hash text not null check (config_hash ~ '^[0-9a-f]{64}$'),
  matching_rules_version text not null,
  dataset_ref text not null,
  dataset_hash text check (dataset_hash is null or dataset_hash ~ '^[0-9a-f]{64}$'),
  ground_truth_hash text check (ground_truth_hash is null or ground_truth_hash ~ '^[0-9a-f]{64}$'),
  n_datasets integer not null check (n_datasets >= 1),
  metrics jsonb not null,
  disclaimer text not null default 'Synthetic benchmark: validates implementation and calibration, not real-world epidemiological performance.',
  created_at timestamptz not null default now(),
  constraint evaluation_runs_unique_uk unique (kind, config_hash, matching_rules_version, dataset_ref)
);

create table public.evaluation_event_results (
  id uuid primary key default gen_random_uuid(),
  evaluation_run_id uuid not null references public.evaluation_runs (id) on delete cascade,
  event_id text not null,
  kind text not null check (kind in ('true_cluster', 'decoy_reporting_artifact')),
  evaluable boolean not null,
  detected boolean not null,
  late_detected boolean not null default false,
  credited_date date,
  delay_days integer,
  localization jsonb,
  decoy_alerted boolean,
  gate_reasons text[] not null default '{}',
  constraint evaluation_event_results_uk unique (evaluation_run_id, event_id)
);

-- ---------------------------------------------------------------------------
-- signal_candidates: episode identity + structured evidence
-- ---------------------------------------------------------------------------
alter table public.signal_candidates
  add column episode_key text check (episode_key is null or episode_key ~ '^[0-9a-f]{64}$'),
  add column first_run_id uuid references public.detector_runs (id) on delete set null,
  add column last_run_id uuid references public.detector_runs (id) on delete set null,
  add column first_detected_on date,
  add column last_seen_on date,
  add column score_components jsonb,
  add column evidence jsonb;

create unique index signal_candidates_episode_uk on public.signal_candidates (detection_method, episode_key) where episode_key is not null;

comment on column public.signal_candidates.signal_score is
  'Transparent ranking/priority score (0-100) built from documented components. NOT a probability, NOT the chance an event is real, NOT a diagnostic confidence.';
comment on column public.signal_candidates.confidence is
  'Evidence-sufficiency index (data quality x volume, 0-1). NOT a probability that the signal is real or that an outbreak exists.';

-- Guard rewrite (M2 guard extended): the detector may extend an UNREVIEWED candidate (window end, metrics,
-- evidence, widening block -> parent district) only through upsert_detected_signal(). Once a human has started
-- review, the detector can no longer change what the reviewer is looking at.
create or replace function public.signal_candidates_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  _detector boolean;
begin
  if tg_op = 'UPDATE' then
    _detector := coalesce(current_setting('jansanket.detector_write', true), '') = 'on' and old.origin = 'system_detector';

    if (new.syndrome, new.time_window_start, new.detection_method, new.created_at, new.origin, new.episode_key)
       is distinct from
       (old.syndrome, old.time_window_start, old.detection_method, old.created_at, old.origin, old.episode_key) then
      raise exception 'signal identity (region, syndrome, window, method) is immutable' using errcode = 'JS008';
    end if;

    if new.region_id is distinct from old.region_id then
      if not (_detector and old.status = 'candidate' and exists (
            select 1 from public.regions r
            where r.id = old.region_id and r.region_type = 'block' and r.parent_region_id = new.region_id)) then
        raise exception 'signal identity (region, syndrome, window, method) is immutable' using errcode = 'JS008';
      end if;
    end if;

    if new.time_window_end is distinct from old.time_window_end then
      if not (_detector and old.status = 'candidate' and new.time_window_end >= old.time_window_end) then
        raise exception 'signal identity (region, syndrome, window, method) is immutable' using errcode = 'JS008';
      end if;
    end if;

    if old.status <> 'candidate'
       and (new.observed_value, new.baseline_value, new.deviation, new.signal_score, new.sample_count, new.minimum_sample_count,
            new.confidence, new.explanation, new.score_components, new.evidence)
       is distinct from
           (old.observed_value, old.baseline_value, old.deviation, old.signal_score, old.sample_count, old.minimum_sample_count,
            old.confidence, old.explanation, old.score_components, old.evidence) then
      raise exception 'a signal under human review cannot have its evidence changed' using errcode = 'JS008';
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
revoke all on function public.signal_candidates_guard() from public, anon, authenticated;

-- Disclosure / wording invariants for detector-created candidates (privacy floor = suppression threshold k).
create function public.signal_candidates_detector_invariants()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _k integer;
  _rtype public.region_type;
begin
  -- Applies to rows written by the statistical detector (they always carry an episode_key; the only write path
  -- is upsert_detected_signal). Manually curated rows keep the M2 contract.
  if new.origin <> 'system_detector' or new.episode_key is null then
    return new;
  end if;
  select p.value_int into _k from public.privacy_settings p where p.key = 'min_aggregate_cell_size';
  _k := coalesce(_k, 5);
  if new.sample_count is null or new.sample_count < _k or new.minimum_sample_count < _k or new.observed_value < _k then
    raise exception 'detector signals must meet the evidence floor (>= % reports)', _k using errcode = 'JS009';
  end if;
  select r.region_type into _rtype from public.regions r where r.id = new.region_id;
  if _rtype is null or _rtype not in ('block', 'district') then
    raise exception 'detector signals must reference a block or district' using errcode = 'JS003';
  end if;
  if new.explanation is null
     or new.explanation not like 'Emerging signal requiring verification:%'
     or position('Human verification required.' in new.explanation) = 0 then
    raise exception 'detector explanation must state that the signal requires human verification' using errcode = 'JS009';
  end if;
  if new.signal_score is null or new.signal_score < 0 or new.signal_score > 100 then
    raise exception 'signal_score must be a 0-100 ranking score' using errcode = 'JS009';
  end if;
  if tg_op = 'INSERT' and new.status <> 'candidate' then
    raise exception 'detector signals start as candidates' using errcode = 'JS009';
  end if;
  return new;
end;
$$;
revoke all on function public.signal_candidates_detector_invariants() from public, anon, authenticated;

create trigger signal_candidates_invariants_trg
  before insert or update on public.signal_candidates
  for each row execute function public.signal_candidates_detector_invariants();

-- Findings never store a count below k.
create function public.detector_findings_privacy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _k integer;
begin
  select p.value_int into _k from public.privacy_settings p where p.key = 'min_aggregate_cell_size';
  if new.observed is not null and new.observed < coalesce(_k, 5) then
    raise exception 'findings must not store counts below the suppression threshold' using errcode = 'JS009';
  end if;
  return new;
end;
$$;
revoke all on function public.detector_findings_privacy() from public, anon, authenticated;
create trigger detector_findings_privacy_trg
  before insert or update on public.detector_findings
  for each row execute function public.detector_findings_privacy();

-- ---------------------------------------------------------------------------
-- Service-only functions
-- ---------------------------------------------------------------------------
-- Dense input for the detector: DEIDENTIFIED tier, block x India-local day x syndrome, per-source counts.
-- Carries no reporter identity and no synthetic marker.
create function public.detection_daily_features(_from date, _to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _out jsonb;
begin
  if _from is null or _to is null or _to < _from or _to - _from > 400 then
    raise exception 'invalid date range (max 400 days)' using errcode = '22023';
  end if;
  with by_source as (
    select d.region_id, d.observed_date, d.syndrome, d.source_type,
           count(*)::integer as n, sum(d.case_count)::integer as c,
           (count(*) filter (where d.severity = 'unknown'))::integer as u
    from public.deidentified_observations d
    where d.observed_date between _from and _to
    group by d.region_id, d.observed_date, d.syndrome, d.source_type
  ),
  cells as (
    select s.region_id, s.observed_date, s.syndrome,
           sum(s.n)::integer as reports, sum(s.c)::integer as cases, sum(s.u)::integer as unknown_severity,
           jsonb_object_agg(s.source_type, s.n) as by_source
    from by_source s
    group by s.region_id, s.observed_date, s.syndrome
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'region_id', c.region_id, 'date', c.observed_date, 'syndrome', c.syndrome, 'reports', c.reports,
           'cases', c.cases, 'unknown_severity', c.unknown_severity, 'by_source', c.by_source)
         order by c.observed_date, c.region_id, c.syndrome), '[]'::jsonb)
    into _out
  from cells c;
  return _out;
end;
$$;

-- Idempotent upsert of one detected episode. Inserts a new candidate, extends an unreviewed one, or (for a
-- candidate already under human review) records only that the detector saw it again.
create function public.upsert_detected_signal(_p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _old public.signal_candidates;
  _id uuid;
  _region uuid := (_p ->> 'region_id')::uuid;
  _action text;
begin
  perform set_config('jansanket.detector_write', 'on', true);

  select * into _old from public.signal_candidates s
   where s.detection_method = _p ->> 'method_code' and s.episode_key = _p ->> 'episode_key'
   for update;

  if not found then
    insert into public.signal_candidates (
      region_id, time_window_start, time_window_end, syndrome, observed_value, baseline_value, deviation, signal_score,
      sample_count, minimum_sample_count, detection_method, confidence, explanation, origin, episode_key,
      first_run_id, last_run_id, first_detected_on, last_seen_on, score_components, evidence)
    values (
      _region, (_p ->> 'window_start')::timestamptz, (_p ->> 'window_end')::timestamptz, (_p ->> 'syndrome')::public.syndrome_category,
      (_p ->> 'observed_value')::numeric, (_p ->> 'baseline_value')::numeric, (_p ->> 'deviation')::numeric, (_p ->> 'signal_score')::numeric,
      (_p ->> 'sample_count')::integer, (_p ->> 'minimum_sample_count')::integer, _p ->> 'method_code', (_p ->> 'confidence')::numeric,
      _p ->> 'explanation', 'system_detector', _p ->> 'episode_key',
      (_p ->> 'run_id')::uuid, (_p ->> 'run_id')::uuid, (_p ->> 'first_detected_on')::date, (_p ->> 'last_seen_on')::date,
      _p -> 'score_components', _p -> 'evidence')
    returning id into _id;
    _action := 'inserted';
  elsif _old.status = 'candidate' then
    -- Region may only WIDEN (block -> its district); never narrows.
    if _region is distinct from _old.region_id and not exists (
         select 1 from public.regions r where r.id = _old.region_id and r.region_type = 'block' and r.parent_region_id = _region) then
      _region := _old.region_id;
    end if;
    update public.signal_candidates s set
      region_id = _region,
      time_window_end = greatest(s.time_window_end, (_p ->> 'window_end')::timestamptz),
      observed_value = (_p ->> 'observed_value')::numeric,
      baseline_value = (_p ->> 'baseline_value')::numeric,
      deviation = (_p ->> 'deviation')::numeric,
      signal_score = (_p ->> 'signal_score')::numeric,
      sample_count = (_p ->> 'sample_count')::integer,
      minimum_sample_count = (_p ->> 'minimum_sample_count')::integer,
      confidence = (_p ->> 'confidence')::numeric,
      explanation = _p ->> 'explanation',
      score_components = _p -> 'score_components',
      evidence = _p -> 'evidence',
      last_run_id = (_p ->> 'run_id')::uuid,
      last_seen_on = greatest(s.last_seen_on, (_p ->> 'last_seen_on')::date)
    where s.id = _old.id
    returning s.id into _id;
    _action := 'updated';
  else
    update public.signal_candidates s set
      last_run_id = (_p ->> 'run_id')::uuid,
      last_seen_on = greatest(s.last_seen_on, (_p ->> 'last_seen_on')::date)
    where s.id = _old.id
    returning s.id into _id;
    _action := 'seen_under_review';
  end if;

  perform set_config('jansanket.detector_write', 'off', true);
  return jsonb_build_object('id', _id, 'action', _action);
end;
$$;

revoke all on function public.detection_daily_features(date, date) from public, anon, authenticated;
revoke all on function public.upsert_detected_signal(jsonb) from public, anon, authenticated;
grant execute on function public.detection_daily_features(date, date) to service_role;
grant execute on function public.upsert_detected_signal(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Privileges, RLS, audit
-- ---------------------------------------------------------------------------
revoke all on public.detector_runs, public.detector_findings, public.evaluation_runs, public.evaluation_event_results
  from anon, authenticated;
grant select on public.detector_runs, public.detector_findings, public.evaluation_runs, public.evaluation_event_results
  to authenticated;

alter table public.detector_runs enable row level security;
alter table public.detector_findings enable row level security;
alter table public.evaluation_runs enable row level security;
alter table public.evaluation_event_results enable row level security;

-- Run metadata (versions, config, counts) is non-sensitive: officers and admins may read it.
create policy detector_runs_select on public.detector_runs for select to authenticated
  using (public.has_role((select auth.uid()), 'admin') or public.has_role((select auth.uid()), 'officer'));

-- Findings explain why tests fired; visible to admins and to officers for districts in their scope.
create policy detector_findings_select on public.detector_findings for select to authenticated
  using (public.has_role((select auth.uid()), 'admin') or public.is_region_in_scope((select auth.uid()), 'officer', district_id));

-- Synthetic benchmark results: administrators only.
create policy evaluation_runs_select on public.evaluation_runs for select to authenticated
  using (public.has_role((select auth.uid()), 'admin'));
create policy evaluation_event_results_select on public.evaluation_event_results for select to authenticated
  using (public.has_role((select auth.uid()), 'admin'));

create trigger detector_runs_audit after insert or update on public.detector_runs
  for each row execute function public.audit_row_change();
create trigger evaluation_runs_audit after insert on public.evaluation_runs
  for each row execute function public.audit_row_change();
