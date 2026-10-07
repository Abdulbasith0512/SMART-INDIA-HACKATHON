-- JanSanket M2 (2/2): SECURITY — grants, RLS, audit triggers, scoped and service-only functions.
--
-- Access model (default deny; Supabase grants ALL to API roles by default, so we revoke first):
--   citizen    : create + read/delete OWN health reports; read regions/symptom vocabulary/trusted evidence.
--   clinician  : same as citizen, plus submit clinician/health_facility reports for regions inside their
--                role scope. NO access to other people's reports, aggregates or signals.
--   officer    : read signal candidates and aggregates for regions inside their role scope. NO raw reports.
--   admin      : manage reference data and role scopes; read all signals/aggregates. NO raw reports
--                (least privilege: administering the platform does not require reading health reports).
--   service    : the pipeline functions (deidentify / aggregate / retention) and signal creation.
-- A role row with NULL region_id grants no regional access.

-- ---------------------------------------------------------------------------
-- Generic audit trigger (records WHICH fields changed, never their values).
-- ---------------------------------------------------------------------------
create function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  _id text := coalesce(_row ->> 'id', _row ->> 'key', _row ->> 'code', _row ->> 'signal_candidate_id');
  _changed jsonb := '[]'::jsonb;
begin
  if tg_op = 'UPDATE' then
    select coalesce(jsonb_agg(n.key order by n.key), '[]'::jsonb) into _changed
    from jsonb_each(to_jsonb(new)) n
    where n.key <> 'updated_at' and n.value is distinct from (to_jsonb(old) -> n.key);
    if _changed = '[]'::jsonb then
      return new;
    end if;
  end if;

  perform public.write_audit(auth.uid(), tg_table_name || '.' || lower(tg_op), tg_table_name, _id,
    jsonb_build_object('changed_fields', _changed));
  return null;
end;
$$;
revoke all on function public.audit_row_change() from public, anon, authenticated;

create trigger regions_audit after insert or update on public.regions
  for each row execute function public.audit_row_change();
create trigger symptom_terms_audit after insert or update on public.symptom_terms
  for each row execute function public.audit_row_change();
create trigger privacy_settings_audit after insert or update on public.privacy_settings
  for each row execute function public.audit_row_change();
create trigger detection_methods_audit after insert or update on public.detection_methods
  for each row execute function public.audit_row_change();
create trigger evidence_items_audit after insert or update on public.evidence_items
  for each row execute function public.audit_row_change();
create trigger signal_candidates_audit after insert or update on public.signal_candidates
  for each row execute function public.audit_row_change();
create trigger signal_evidence_audit after insert or delete on public.signal_evidence
  for each row execute function public.audit_row_change();
-- M1 already audits user_roles grant/revoke; scope changes are updates.
create trigger user_roles_audit_update after update on public.user_roles
  for each row execute function public.audit_row_change();

create trigger privacy_settings_touch_trg before update on public.privacy_settings
  for each row execute function public.touch_updated_at_generic();

alter table public.evidence_items alter column created_by set default auth.uid();

-- ---------------------------------------------------------------------------
-- Privileges: revoke everything first, grant the minimum.
-- ---------------------------------------------------------------------------
revoke all on public.regions, public.symptom_terms, public.privacy_settings, public.detection_methods,
  public.health_reports, public.deidentified_observations, public.report_aggregates,
  public.signal_candidates, public.evidence_items, public.signal_evidence, public.report_signal_links
  from anon, authenticated;

grant select on public.regions to authenticated;
grant insert (name, name_local, region_type, parent_region_id, administrative_code, is_synthetic, active) on public.regions to authenticated;
grant update (name, name_local, administrative_code, active) on public.regions to authenticated;

grant select on public.symptom_terms to authenticated;
grant insert (code, syndrome_hint, label_en, label_hi, label_or, active) on public.symptom_terms to authenticated;
grant update (syndrome_hint, label_en, label_hi, label_or, active) on public.symptom_terms to authenticated;

grant select on public.privacy_settings to authenticated;
grant update (value_int) on public.privacy_settings to authenticated;

grant select on public.detection_methods to authenticated;
grant insert (code, description, active) on public.detection_methods to authenticated;
grant update (description, active) on public.detection_methods to authenticated;

-- health_reports: clients may NOT set processing_status, privacy_level or synthetic_batch (column grants).
grant select on public.health_reports to authenticated;
grant insert (client_submission_id, observed_at, submitted_by, source_type, region_id, report_type, syndrome,
              symptom_codes, severity, age_band, case_count, language, free_text)
  on public.health_reports to authenticated;
grant delete on public.health_reports to authenticated;

grant select on public.signal_candidates to authenticated;

grant select on public.evidence_items to authenticated;
grant insert (title, publisher, source_type, reference_url, citation, publication_date, language, content_hash,
              trust_level, verified_by, verified_at)
  on public.evidence_items to authenticated;
grant update (title, publisher, source_type, reference_url, citation, publication_date, language, content_hash,
              trust_level, verified_by, verified_at)
  on public.evidence_items to authenticated;

grant select on public.signal_evidence to authenticated;
grant select on public.report_signal_links to authenticated;

-- deidentified_observations and report_aggregates: NO client grants. Service role only (M2);
-- clients read aggregates through get_report_aggregates().

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.regions enable row level security;
alter table public.symptom_terms enable row level security;
alter table public.privacy_settings enable row level security;
alter table public.detection_methods enable row level security;
alter table public.health_reports enable row level security;
alter table public.deidentified_observations enable row level security;
alter table public.report_aggregates enable row level security;
alter table public.signal_candidates enable row level security;
alter table public.evidence_items enable row level security;
alter table public.signal_evidence enable row level security;
alter table public.report_signal_links enable row level security;

-- Helper grants (policies evaluate these as the calling user).
revoke all on function public.region_subtree(uuid) from public, anon;
revoke all on function public.is_region_in_scope(uuid, public.app_role, uuid) from public, anon;
grant execute on function public.region_subtree(uuid) to authenticated;
grant execute on function public.is_region_in_scope(uuid, public.app_role, uuid) to authenticated;

-- regions: non-sensitive reference data
create policy regions_select on public.regions for select to authenticated
  using (active or public.has_role((select auth.uid()), 'admin'));
create policy regions_insert_admin on public.regions for insert to authenticated
  with check (public.has_role((select auth.uid()), 'admin'));
create policy regions_update_admin on public.regions for update to authenticated
  using (public.has_role((select auth.uid()), 'admin'))
  with check (public.has_role((select auth.uid()), 'admin'));

-- symptom vocabulary
create policy symptom_terms_select on public.symptom_terms for select to authenticated
  using (active or public.has_role((select auth.uid()), 'admin'));
create policy symptom_terms_insert_admin on public.symptom_terms for insert to authenticated
  with check (public.has_role((select auth.uid()), 'admin'));
create policy symptom_terms_update_admin on public.symptom_terms for update to authenticated
  using (public.has_role((select auth.uid()), 'admin'))
  with check (public.has_role((select auth.uid()), 'admin'));

-- privacy settings and detection methods: operational metadata for officers/admins
create policy privacy_settings_select on public.privacy_settings for select to authenticated
  using (public.has_role((select auth.uid()), 'admin') or public.has_role((select auth.uid()), 'officer'));
create policy privacy_settings_update_admin on public.privacy_settings for update to authenticated
  using (public.has_role((select auth.uid()), 'admin'))
  with check (public.has_role((select auth.uid()), 'admin'));

create policy detection_methods_select on public.detection_methods for select to authenticated
  using (public.has_role((select auth.uid()), 'admin') or public.has_role((select auth.uid()), 'officer'));
create policy detection_methods_insert_admin on public.detection_methods for insert to authenticated
  with check (public.has_role((select auth.uid()), 'admin'));
create policy detection_methods_update_admin on public.detection_methods for update to authenticated
  using (public.has_role((select auth.uid()), 'admin'))
  with check (public.has_role((select auth.uid()), 'admin'));

-- health_reports (RAW): own rows only. Nobody else — not officers, not admins — reads raw reports.
create policy health_reports_select_own on public.health_reports for select to authenticated
  using (submitted_by = (select auth.uid()));

create policy health_reports_insert_own on public.health_reports for insert to authenticated
  with check (
    submitted_by = (select auth.uid())
    and synthetic_batch is null
    and processing_status = 'received'
    and privacy_level = 'raw'
    and (
      (source_type = 'citizen' and report_type = 'individual_observation'
         and public.has_role((select auth.uid()), 'citizen'))
      or (source_type in ('clinician', 'health_facility')
         and public.is_region_in_scope((select auth.uid()), 'clinician', region_id))
      or (source_type = 'public_health_officer' and report_type = 'individual_observation'
         and public.is_region_in_scope((select auth.uid()), 'officer', region_id))
    )
  );

-- Withdrawal: submitters can delete their own report (derived deidentified rows are unlinked, not kept linked).
create policy health_reports_delete_own on public.health_reports for delete to authenticated
  using (submitted_by = (select auth.uid()));

-- deidentified_observations / report_aggregates: RLS on, intentionally NO policies (service role only).

-- signal_candidates: admins everywhere, officers inside their scope. No direct writes.
create policy signal_candidates_select on public.signal_candidates for select to authenticated
  using (
    public.has_role((select auth.uid()), 'admin')
    or public.is_region_in_scope((select auth.uid()), 'officer', region_id)
  );

-- evidence: trusted items are public reference; the rest is for staff. Admin curates.
create policy evidence_items_select on public.evidence_items for select to authenticated
  using (
    trust_level = 'trusted'
    or public.has_role((select auth.uid()), 'admin')
    or public.has_role((select auth.uid()), 'officer')
    or public.has_role((select auth.uid()), 'clinician')
  );
create policy evidence_items_insert_admin on public.evidence_items for insert to authenticated
  with check (public.has_role((select auth.uid()), 'admin'));
create policy evidence_items_update_admin on public.evidence_items for update to authenticated
  using (public.has_role((select auth.uid()), 'admin'))
  with check (public.has_role((select auth.uid()), 'admin'));

-- signal_evidence / report_signal_links: visible exactly when the parent signal is visible (the subquery is itself RLS-filtered).
create policy signal_evidence_select on public.signal_evidence for select to authenticated
  using (exists (select 1 from public.signal_candidates s where s.id = signal_candidate_id));
create policy report_signal_links_select on public.report_signal_links for select to authenticated
  using (exists (select 1 from public.signal_candidates s where s.id = signal_candidate_id));

-- ---------------------------------------------------------------------------
-- Scoped, audited operations for signed-in users
-- ---------------------------------------------------------------------------
create function public.review_signal_candidate(
  _signal_id uuid,
  _new_status public.signal_status,
  _verification public.verification_status,
  _note text default null
)
returns public.signal_candidates
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _old public.signal_candidates;
  _new public.signal_candidates;
begin
  select * into _old from public.signal_candidates s where s.id = _signal_id for update;
  -- Same error for "missing" and "out of scope": do not let callers probe for signal ids.
  if _uid is null or not found or not (
       public.has_role(_uid, 'admin') or public.is_region_in_scope(_uid, 'officer', _old.region_id)) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.signal_candidates s
     set status = _new_status,
         verification_status = _verification,
         review_note = _note,
         reviewed_by = _uid,
         reviewed_at = now(),
         resolved_at = case when _new_status in ('resolved', 'dismissed') then now() else null end
   where s.id = _signal_id
   returning * into _new;

  perform public.write_audit(_uid, 'signal.reviewed', 'signal_candidates', _signal_id::text,
    jsonb_build_object('from_status', _old.status, 'to_status', _new.status, 'verification_status', _new.verification_status));
  return _new;
end;
$$;
revoke all on function public.review_signal_candidate(uuid, public.signal_status, public.verification_status, text) from public, anon;
grant execute on function public.review_signal_candidate(uuid, public.signal_status, public.verification_status, text) to authenticated;

create function public.admin_set_user_region_scope(_target uuid, _role public.app_role, _region_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _caller uuid := auth.uid();
begin
  if _caller is null or not public.has_role(_caller, 'admin') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if _target = _caller then
    raise exception 'admins cannot change their own role scope' using errcode = '42501';
  end if;
  if _role not in ('clinician', 'officer') then
    raise exception 'only clinician and officer roles carry a region scope' using errcode = '22023';
  end if;
  if _region_id is not null and not exists (
       select 1 from public.regions r
       where r.id = _region_id and r.active and r.region_type in ('country', 'state', 'district', 'block')) then
    raise exception 'scope region must be an active country/state/district/block' using errcode = '22023';
  end if;

  update public.user_roles ur set region_id = _region_id where ur.user_id = _target and ur.role = _role;
  if not found then
    raise exception 'target does not hold that role' using errcode = 'P0002';
  end if;

  perform public.write_audit(_caller, 'role.scope_changed', 'user_roles', _target::text,
    jsonb_build_object('role', _role, 'region_id', _region_id));
end;
$$;
revoke all on function public.admin_set_user_region_scope(uuid, public.app_role, uuid) from public, anon;
grant execute on function public.admin_set_user_region_scope(uuid, public.app_role, uuid) to authenticated;

-- Officer/admin read path for aggregates. Suppressed cells have NULL counts.
create function public.get_report_aggregates(_region_id uuid, _from date, _to date)
returns table (
  region_id uuid,
  observed_date date,
  syndrome public.syndrome_category,
  report_count integer,
  case_count integer,
  suppressed boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
begin
  if _uid is null or not (
       public.has_role(_uid, 'admin') or public.is_region_in_scope(_uid, 'officer', _region_id)) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if _from is null or _to is null or _to < _from or _to - _from > 366 then
    raise exception 'invalid date range (max 366 days)' using errcode = '22023';
  end if;

  return query
    select a.region_id, a.observed_date, a.syndrome,
           case when a.suppressed then null else a.report_count end,
           case when a.suppressed then null else a.case_count end,
           a.suppressed
    from public.report_aggregates a
    where a.region_id in (select s.id from public.region_subtree(_region_id) s)
      and a.observed_date between _from and _to
    order by a.observed_date, a.region_id, a.syndrome;
end;
$$;
revoke all on function public.get_report_aggregates(uuid, date, date) from public, anon;
grant execute on function public.get_report_aggregates(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Service-only pipeline: RAW -> DEIDENTIFIED -> AGGREGATED (deterministic SQL, no ML, no LLM)
-- ---------------------------------------------------------------------------
create function public.deidentify_pending_reports(_limit integer default 5000)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  _n integer;
begin
  if _limit < 1 or _limit > 100000 then
    raise exception 'invalid limit' using errcode = '22023';
  end if;

  with batch as (
    select r.id
    from public.health_reports r
    where r.processing_status in ('received', 'validated')
    order by r.created_at, r.id
    limit _limit
    for update skip locked
  ),
  ins as (
    insert into public.deidentified_observations
      (report_id, observed_date, region_id, source_type, report_type, syndrome, symptom_codes, severity, age_band, case_count, is_synthetic)
    select r.id,
           (r.observed_at at time zone 'Asia/Kolkata')::date,            -- day granularity, India local date
           case when g.region_type = 'block' then g.id else g.parent_region_id end, -- coarsen locality -> block
           r.source_type, r.report_type, r.syndrome, r.symptom_codes, r.severity, r.age_band, r.case_count,
           r.synthetic_batch is not null
    from batch b
    join public.health_reports r on r.id = b.id
    join public.regions g on g.id = r.region_id
    on conflict (report_id) do nothing
    returning 1
  ),
  upd as (
    update public.health_reports h
       set processing_status = 'deidentified'
     where h.id in (select id from batch)
    returning 1
  )
  select count(*) into _n from upd;

  if _n > 0 then
    perform public.write_audit(auth.uid(), 'pipeline.deidentify', 'health_reports', null, jsonb_build_object('count', _n));
  end if;
  return _n;
end;
$$;

create function public.refresh_report_aggregates(_from date, _to date)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  _k integer;
  _n integer;
begin
  if _from is null or _to is null or _to < _from or _to - _from > 366 then
    raise exception 'invalid date range (max 366 days)' using errcode = '22023';
  end if;
  select p.value_int into _k from public.privacy_settings p where p.key = 'min_aggregate_cell_size';
  _k := coalesce(_k, 5);

  with src as (
    select d.region_id, d.observed_date, d.syndrome, count(*)::integer as rc, sum(d.case_count)::integer as cc
    from public.deidentified_observations d
    where d.observed_date between _from and _to
    group by d.region_id, d.observed_date, d.syndrome
  ),
  up as (
    insert into public.report_aggregates (region_id, observed_date, syndrome, report_count, case_count, suppressed, min_cell_size_applied, computed_at)
    select s.region_id, s.observed_date, s.syndrome, s.rc, s.cc, s.cc < _k, _k, now() from src s
    on conflict (region_id, observed_date, syndrome) do update
      set report_count = excluded.report_count, case_count = excluded.case_count, suppressed = excluded.suppressed,
          min_cell_size_applied = excluded.min_cell_size_applied, computed_at = excluded.computed_at
    returning 1
  ),
  del as (
    delete from public.report_aggregates a
    where a.observed_date between _from and _to
      and not exists (select 1 from src s where s.region_id = a.region_id and s.observed_date = a.observed_date and s.syndrome = a.syndrome)
    returning 1
  )
  select count(*) into _n from up;

  perform public.write_audit(auth.uid(), 'pipeline.aggregate', 'report_aggregates', null,
    jsonb_build_object('from', _from, 'to', _to, 'cells', _n, 'min_cell_size', _k));
  return _n;
end;
$$;

create function public.apply_report_retention()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _text_days integer;
  _id_days integer;
  _text_n integer;
  _id_n integer;
begin
  select p.value_int into _text_days from public.privacy_settings p where p.key = 'raw_free_text_retention_days';
  select p.value_int into _id_days from public.privacy_settings p where p.key = 'raw_identity_retention_days';
  _text_days := coalesce(_text_days, 30);
  _id_days := coalesce(_id_days, 365);

  update public.health_reports h set free_text = null
   where h.free_text is not null and h.created_at < now() - make_interval(days => _text_days);
  get diagnostics _text_n = row_count;

  update public.health_reports h set submitted_by = null
   where h.submitted_by is not null and h.created_at < now() - make_interval(days => _id_days);
  get diagnostics _id_n = row_count;

  perform public.write_audit(auth.uid(), 'pipeline.retention', 'health_reports', null,
    jsonb_build_object('free_text_cleared', _text_n, 'submitter_unlinked', _id_n));
  return jsonb_build_object('free_text_cleared', _text_n, 'submitter_unlinked', _id_n);
end;
$$;

revoke all on function public.deidentify_pending_reports(integer) from public, anon, authenticated;
revoke all on function public.refresh_report_aggregates(date, date) from public, anon, authenticated;
revoke all on function public.apply_report_retention() from public, anon, authenticated;
grant execute on function public.deidentify_pending_reports(integer) to service_role;
grant execute on function public.refresh_report_aggregates(date, date) to service_role;
grant execute on function public.apply_report_retention() to service_role;
