// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { IDS, asAnon, asService, asUser, createDb, reportInsertSql, run, seedFixture, type Db } from "./harness";

let db: Db;
const sig: Record<string, string> = {};
const ev: Record<string, string> = {};
const rpt: Record<string, string> = {};

async function newSignal(region: string, day: string, syndrome = "acute_diarrhoeal_illness"): Promise<string> {
  const r = await run<{ id: string }>(db, `
    insert into public.signal_candidates (region_id, time_window_start, time_window_end, syndrome, observed_value)
    values ('${region}', '${day}T00:00:00Z', '${day}T23:00:00Z', '${syndrome}', 9) returning id`);
  return r.rows[0].id;
}

beforeAll(async () => {
  db = await createDb();
  await seedFixture(db);

  // Raw reports created the way real clients do it: as authenticated users under RLS.
  rpt.a1 = (await asUser(db, IDS.citizenA, () => run<{ id: string }>(db, reportInsertSql()))).rows[0].id;
  rpt.a2 = (await asUser(db, IDS.citizenA, () => run<{ id: string }>(db, reportInsertSql({ syndrome: `'fever'` })))).rows[0].id;
  rpt.b1 = (await asUser(db, IDS.citizenB, () => run<{ id: string }>(db, reportInsertSql({ region_id: `'${IDS.b2a}'` })))).rows[0].id;
  rpt.c1 = (await asUser(db, IDS.clinician, () =>
    run<{ id: string }>(db, reportInsertSql({ source_type: `'health_facility'`, report_type: `'aggregate_count'`, case_count: `3` })))).rows[0].id;

  // Pipeline data: 6 fever cases in b1a (above the demo threshold of 5), 2 diarrhoeal in b1b (suppressed).
  for (let i = 0; i < 6; i++) {
    await run(db, reportInsertSql({ source_type: `'imported_dataset'`, syndrome: `'fever'`, symptom_codes: `array['fever']`, synthetic_batch: `'rls-test'`, observed_at: `now() - interval '2 days'` }));
  }
  for (let i = 0; i < 2; i++) {
    await run(db, reportInsertSql({ source_type: `'imported_dataset'`, region_id: `'${IDS.b1b}'`, synthetic_batch: `'rls-test'`, observed_at: `now() - interval '2 days'` }));
  }
  await asService(db, async () => {
    await run(db, `select public.deidentify_pending_reports(1000)`);
    await run(db, `select public.refresh_report_aggregates((now() - interval '10 days')::date, (now() + interval '1 day')::date)`);
  });

  sig.d1 = await newSignal(IDS.b1a, "2026-09-10");
  sig.d2 = await newSignal(IDS.b2a, "2026-09-10");
  sig.t1 = await newSignal(IDS.b1a, "2026-09-11");
  sig.t2 = await newSignal(IDS.b1a, "2026-09-12");
  sig.t3 = await newSignal(IDS.b1a, "2026-09-13");
  sig.t4 = await newSignal(IDS.b1a, "2026-09-14");

  ev.trusted = (await run<{ id: string }>(db, `insert into public.evidence_items (title, publisher, source_type, citation, trust_level, verified_at)
    values ('Trusted guideline', 'Test Publisher', 'guideline', 'cit-trusted', 'trusted', now()) returning id`)).rows[0].id;
  ev.unreviewed = (await run<{ id: string }>(db, `insert into public.evidence_items (title, publisher, source_type, citation)
    values ('Unreviewed note', 'Test Publisher', 'other', 'cit-unreviewed') returning id`)).rows[0].id;
  await run(db, `insert into public.signal_evidence (signal_candidate_id, evidence_item_id) values ('${sig.d1}', '${ev.trusted}')`);
  const agg = (await run<{ id: string }>(db, `select id from public.report_aggregates where region_id = '${IDS.b1a}' limit 1`)).rows[0].id;
  await run(db, `insert into public.report_signal_links (signal_candidate_id, aggregate_id) values ('${sig.d1}', '${agg}')`);
}, 120_000);

const code = (o: { error?: { code?: string } }) => o.error?.code;

describe("citizen", () => {
  it("can create a permitted report and read it back with its status", async () => {
    const r = await asUser(db, IDS.citizenA, () => run<{ processing_status: string }>(db, `select processing_status from public.health_reports where id = '${rpt.a1}'`));
    expect(r.rows[0].processing_status).toMatch(/received|deidentified/);
  });

  it("cannot read other citizens' reports", async () => {
    const mine = await asUser(db, IDS.citizenA, () => run(db, `select id from public.health_reports where id in ('${rpt.a1}','${rpt.a2}','${rpt.b1}','${rpt.c1}')`));
    expect(mine.rows.map((x) => (x as { id: string }).id).sort()).toEqual([rpt.a1, rpt.a2].sort());
    const theirs = await asUser(db, IDS.citizenB, () => run(db, `select id from public.health_reports where id = '${rpt.a1}'`));
    expect(theirs.rows).toHaveLength(0);
  });

  it("cannot set protected system fields (processing_status, privacy_level, synthetic_batch)", async () => {
    for (const o of [{ processing_status: `'deidentified'` }, { privacy_level: `'aggregated'` }, { synthetic_batch: `'x'` }]) {
      const r = await asUser(db, IDS.citizenA, () => run(db, reportInsertSql(o)));
      expect(code(r), JSON.stringify(o)).toBe("42501");
    }
  });

  it("cannot submit as another user, or as a clinician/facility/officer source", async () => {
    expect(code(await asUser(db, IDS.citizenA, () => run(db, reportInsertSql({ submitted_by: `'${IDS.citizenB}'` }))))).toBe("42501");
    for (const s of ["clinician", "health_facility", "public_health_officer", "imported_dataset", "system_generated"]) {
      expect(code(await asUser(db, IDS.citizenA, () => run(db, reportInsertSql({ source_type: `'${s}'` })))), s).toBe("42501");
    }
  });

  it("cannot modify a submitted report (no UPDATE privilege)", async () => {
    const r = await asUser(db, IDS.citizenA, () => run(db, `update public.health_reports set severity = 'severe' where id = '${rpt.a1}'`));
    expect(code(r)).toBe("42501");
  });

  it("cannot read population intelligence (aggregates, deidentified data, signals)", async () => {
    expect(code(await asUser(db, IDS.citizenA, () => run(db, `select * from public.report_aggregates`)))).toBe("42501");
    expect(code(await asUser(db, IDS.citizenA, () => run(db, `select * from public.deidentified_observations`)))).toBe("42501");
    expect((await asUser(db, IDS.citizenA, () => run(db, `select id from public.signal_candidates`))).rows).toHaveLength(0);
    expect(code(await asUser(db, IDS.citizenA, () => run(db, `select * from public.get_report_aggregates('${IDS.state}', current_date - 5, current_date)`)))).toBe("42501");
  });

  it("can withdraw (delete) their own report but not someone else's", async () => {
    const mine = await asUser(db, IDS.citizenB, () => run(db, reportInsertSql({ region_id: `'${IDS.b1b}'` })));
    const del = await asUser(db, IDS.citizenB, () => run(db, `delete from public.health_reports where id = '${mine.rows[0].id}'`));
    expect(del.affected).toBe(1);
    const other = await asUser(db, IDS.citizenB, () => run(db, `delete from public.health_reports where id = '${rpt.a1}'`));
    expect(other.affected).toBe(0);
  });

  it("reads only trusted evidence", async () => {
    const r = await asUser(db, IDS.citizenA, () => run<{ id: string }>(db, `select id from public.evidence_items`));
    expect(r.rows.map((x) => x.id)).toEqual([ev.trusted]);
  });
});

describe("anonymous (not signed in)", () => {
  it("cannot read or write anything", async () => {
    for (const sql of [
      reportInsertSql(), `select * from public.health_reports`, `select * from public.regions`,
      `select * from public.signal_candidates`, `select * from public.evidence_items`,
    ]) {
      expect(code(await asAnon(db, () => run(db, sql))), sql.slice(0, 40)).toBe("42501");
    }
  });
});

describe("clinician", () => {
  it("can submit facility/clinician reports inside their scope (district 1)", async () => {
    const ok = await asUser(db, IDS.clinician, () => run(db, reportInsertSql({ source_type: `'clinician'`, region_id: `'${IDS.b1b}'` })));
    expect(ok.error).toBeUndefined();
    const fac = await asUser(db, IDS.clinician, () => run(db, reportInsertSql({ source_type: `'health_facility'`, report_type: `'aggregate_count'`, case_count: `7`, region_id: `'${IDS.l1a1}'` })));
    expect(fac.error).toBeUndefined();
  });

  it("cannot submit outside their scope", async () => {
    const r = await asUser(db, IDS.clinician, () => run(db, reportInsertSql({ source_type: `'clinician'`, region_id: `'${IDS.b2a}'` })));
    expect(code(r)).toBe("42501");
  });

  it("can still submit as an ordinary citizen anywhere", async () => {
    const r = await asUser(db, IDS.clinician, () => run(db, reportInsertSql({ region_id: `'${IDS.b2a}'` })));
    expect(r.error).toBeUndefined();
  });

  it("has no automatic access to citizens' reports, aggregates or signals", async () => {
    const reports = await asUser(db, IDS.clinician, () => run(db, `select id from public.health_reports where id in ('${rpt.a1}','${rpt.a2}','${rpt.b1}')`));
    expect(reports.rows).toHaveLength(0);
    expect(code(await asUser(db, IDS.clinician, () => run(db, `select * from public.get_report_aggregates('${IDS.d1}', current_date - 5, current_date)`)))).toBe("42501");
    expect((await asUser(db, IDS.clinician, () => run(db, `select id from public.signal_candidates`))).rows).toHaveLength(0);
  });

  it("can read their own submissions", async () => {
    const r = await asUser(db, IDS.clinician, () => run(db, `select id from public.health_reports where id = '${rpt.c1}'`));
    expect(r.rows).toHaveLength(1);
  });
});

describe("officer: region boundaries and no raw access", () => {
  it("cannot read raw health reports — even for their own region", async () => {
    for (const uid of [IDS.officer1, IDS.officer2, IDS.officerNoScope]) {
      const r = await asUser(db, uid, () => run(db, `select id from public.health_reports`));
      expect(r.rows, uid).toHaveLength(0);
    }
  });

  it("sees signal candidates only inside their regional scope", async () => {
    const ids = async (uid: string) => (await asUser(db, uid, () => run<{ id: string }>(db, `select id from public.signal_candidates`))).rows.map((x) => x.id);
    const o1 = await ids(IDS.officer1);
    expect(o1).toContain(sig.d1);
    expect(o1).not.toContain(sig.d2);
    const o2 = await ids(IDS.officer2);
    expect(o2).toEqual([sig.d2]);
    expect(await ids(IDS.officerNoScope)).toHaveLength(0); // NULL scope grants nothing
  });

  it("reads aggregates only for regions inside scope; suppressed cells carry no counts", async () => {
    const own = await asUser(db, IDS.officer1, () =>
      run<{ region_id: string; syndrome: string; case_count: number | null; suppressed: boolean }>(db,
        `select * from public.get_report_aggregates('${IDS.d1}', (now() - interval '10 days')::date, (now() + interval '1 day')::date)`));
    expect(own.error).toBeUndefined();
    const fever = own.rows.find((r) => r.region_id === IDS.b1a && r.syndrome === "fever");
    expect(fever?.suppressed).toBe(false);
    expect(fever?.case_count).toBe(6);
    const small = own.rows.find((r) => r.region_id === IDS.b1b);
    expect(small?.suppressed).toBe(true);
    expect(small?.case_count).toBeNull();
    expect(own.rows.some((r) => r.region_id === IDS.b2a)).toBe(false);

    const out = await asUser(db, IDS.officer1, () => run(db, `select * from public.get_report_aggregates('${IDS.d2}', current_date - 5, current_date)`));
    expect(code(out)).toBe("42501");
    const wider = await asUser(db, IDS.officer1, () => run(db, `select * from public.get_report_aggregates('${IDS.state}', current_date - 5, current_date)`));
    expect(code(wider)).toBe("42501");
    const none = await asUser(db, IDS.officerNoScope, () => run(db, `select * from public.get_report_aggregates('${IDS.d1}', current_date - 5, current_date)`));
    expect(code(none)).toBe("42501");
  });

  it("cannot read the deidentified/aggregate tables directly", async () => {
    expect(code(await asUser(db, IDS.officer1, () => run(db, `select * from public.report_aggregates`)))).toBe("42501");
    expect(code(await asUser(db, IDS.officer1, () => run(db, `select * from public.deidentified_observations`)))).toBe("42501");
  });

  it("sees signal evidence and links only for signals in scope", async () => {
    const e1 = await asUser(db, IDS.officer1, () => run(db, `select * from public.signal_evidence`));
    const e2 = await asUser(db, IDS.officer2, () => run(db, `select * from public.signal_evidence`));
    expect(e1.rows).toHaveLength(1);
    expect(e2.rows).toHaveLength(0);
    const l1 = await asUser(db, IDS.officer1, () => run(db, `select * from public.report_signal_links`));
    const l2 = await asUser(db, IDS.officer2, () => run(db, `select * from public.report_signal_links`));
    expect(l1.rows).toHaveLength(1);
    expect(l2.rows).toHaveLength(0);
  });

  it("can read all evidence, but cannot write it", async () => {
    const r = await asUser(db, IDS.officer1, () => run(db, `select id from public.evidence_items`));
    expect(r.rows).toHaveLength(2);
    const w = await asUser(db, IDS.officer1, () => run(db, `insert into public.evidence_items (title, publisher, source_type, citation) values ('x','y','other','z')`));
    expect(code(w)).toBe("42501");
  });

  it("can submit public_health_officer observations only inside scope", async () => {
    const ok = await asUser(db, IDS.officer1, () => run(db, reportInsertSql({ source_type: `'public_health_officer'`, region_id: `'${IDS.b1b}'` })));
    expect(ok.error).toBeUndefined();
    const no = await asUser(db, IDS.officer1, () => run(db, reportInsertSql({ source_type: `'public_health_officer'`, region_id: `'${IDS.b2a}'` })));
    expect(code(no)).toBe("42501");
    const none = await asUser(db, IDS.officerNoScope, () => run(db, reportInsertSql({ source_type: `'public_health_officer'` })));
    expect(code(none)).toBe("42501");
  });
});

describe("signal review (scoped, audited, lifecycle-checked)", () => {
  it("an in-scope officer can move a candidate to under_review; the change is audited", async () => {
    const r = await asUser(db, IDS.officer1, () =>
      run<{ status: string; verification_status: string; reviewed_by: string }>(db,
        `select status, verification_status, reviewed_by from public.review_signal_candidate('${sig.t1}', 'under_review', 'in_progress', 'checking with block office')`));
    expect(r.error).toBeUndefined();
    expect(r.rows[0]).toMatchObject({ status: "under_review", verification_status: "in_progress", reviewed_by: IDS.officer1 });
    const a = await run(db, `select 1 from public.audit_log where action = 'signal.reviewed' and entity_id = '${sig.t1}' and actor_id = '${IDS.officer1}'`);
    expect(a.rows).toHaveLength(1);
  });

  it("an out-of-scope officer, unscoped officer, clinician and citizen cannot review it", async () => {
    for (const uid of [IDS.officer2, IDS.officerNoScope, IDS.clinician, IDS.citizenA]) {
      const r = await asUser(db, uid, () => run(db, `select * from public.review_signal_candidate('${sig.t2}', 'under_review', 'in_progress')`));
      expect(code(r), uid).toBe("42501");
    }
    const missing = await asUser(db, IDS.officer1, () => run(db, `select * from public.review_signal_candidate('00000000-0000-0000-0000-00000000ffff', 'under_review', 'in_progress')`));
    expect(code(missing)).toBe("42501"); // indistinguishable from out-of-scope
  });

  it("rejects invalid transitions and inconsistent verification states", async () => {
    const skip = await asUser(db, IDS.officer1, () => run(db, `select * from public.review_signal_candidate('${sig.t3}', 'verified', 'supported')`));
    expect(code(skip)).toBe("JS007"); // candidate -> verified is not allowed
    await asUser(db, IDS.officer1, () => run(db, `select * from public.review_signal_candidate('${sig.t3}', 'under_review', 'in_progress')`));
    const bad = await asUser(db, IDS.officer1, () => run(db, `select * from public.review_signal_candidate('${sig.t3}', 'verified', 'unverified')`));
    expect(code(bad)).toBe("23514");
  });

  it("walks the full lifecycle and sets resolved_at only for terminal states", async () => {
    const step = (status: string, ver: string) => asUser(db, IDS.officer1, () => run<{ resolved_at: string | null }>(db, `select resolved_at from public.review_signal_candidate('${sig.t4}', '${status}', '${ver}')`));
    expect((await step("under_review", "in_progress")).rows[0].resolved_at).toBeNull();
    expect((await step("verified", "supported")).rows[0].resolved_at).toBeNull();
    expect((await step("monitoring", "supported")).rows[0].resolved_at).toBeNull();
    expect((await step("resolved", "supported")).rows[0].resolved_at).not.toBeNull();
    expect(code(await step("monitoring", "supported"))).toBe("JS007"); // terminal
  });

  it("clients cannot UPDATE or INSERT signals directly", async () => {
    expect(code(await asUser(db, IDS.officer1, () => run(db, `update public.signal_candidates set status = 'dismissed' where id = '${sig.d1}'`)))).toBe("42501");
    expect(code(await asUser(db, IDS.admin, () => run(db, `insert into public.signal_candidates (region_id, time_window_start, time_window_end, syndrome, observed_value) values ('${IDS.b1a}', now(), now() + interval '1 day', 'fever', 1)`)))).toBe("42501");
  });
});

describe("admin: least privilege", () => {
  it("cannot read raw health reports", async () => {
    const r = await asUser(db, IDS.admin, () => run(db, `select id from public.health_reports`));
    expect(r.rows).toHaveLength(0);
  });

  it("can read all signals and aggregates (through the audited function)", async () => {
    const s = await asUser(db, IDS.admin, () => run(db, `select id from public.signal_candidates`));
    expect(s.rows.length).toBeGreaterThanOrEqual(6);
    const a = await asUser(db, IDS.admin, () => run(db, `select * from public.get_report_aggregates('${IDS.state}', (now() - interval '10 days')::date, (now() + interval '1 day')::date)`));
    expect(a.error).toBeUndefined();
    expect(a.rows.length).toBeGreaterThan(0);
    expect(code(await asUser(db, IDS.admin, () => run(db, `select * from public.get_report_aggregates('${IDS.state}', current_date - 400, current_date)`)))).toBe("22023");
  });

  it("cannot read the deidentified/aggregate tables directly, and cannot submit as clinician/facility", async () => {
    expect(code(await asUser(db, IDS.admin, () => run(db, `select * from public.deidentified_observations`)))).toBe("42501");
    expect(code(await asUser(db, IDS.admin, () => run(db, reportInsertSql({ source_type: `'health_facility'`, report_type: `'aggregate_count'`, case_count: `2` }))))).toBe("42501");
  });

  it("manages reference data: regions, evidence, privacy settings — and it is audited", async () => {
    const newRegion = await asUser(db, IDS.admin, () => run(db, `insert into public.regions (name, region_type, parent_region_id) values ('Block 1C', 'block', '${IDS.d1}')`));
    expect(newRegion.error).toBeUndefined();
    expect((await asUser(db, IDS.admin, () => run(db, `update public.regions set name = 'Block 1C (edited)' where name = 'Block 1C'`))).affected).toBe(1);
    expect(code(await asUser(db, IDS.admin, () => run(db, `update public.regions set region_type = 'locality' where name like 'Block 1C%'`)))).toBe("42501"); // no column grant
    const e = await asUser(db, IDS.admin, () => run(db, `insert into public.evidence_items (title, publisher, source_type, citation) values ('Admin note','Pub','other','cit-admin') returning created_by`));
    expect(e.error).toBeUndefined();
    expect((e.rows[0] as { created_by: string }).created_by).toBe(IDS.admin);
    const ps = await asUser(db, IDS.admin, () => run(db, `update public.privacy_settings set value_int = 7 where key = 'min_aggregate_cell_size'`));
    expect(ps.affected).toBe(1);
    await run(db, `update public.privacy_settings set value_int = 5 where key = 'min_aggregate_cell_size'`);
    const audited = await run(db, `select 1 from public.audit_log where actor_id = '${IDS.admin}' and action in ('regions.insert','regions.update','evidence_items.insert','privacy_settings.update')`);
    expect(audited.rows.length).toBeGreaterThanOrEqual(4);
  });

  it("can set a clinician/officer region scope — not their own, not on the wrong role, not to a locality", async () => {
    const set = (caller: string, target: string, role: string, region: string | null) =>
      asUser(db, caller, () => run(db, `select public.admin_set_user_region_scope('${target}', '${role}', ${region ? `'${region}'` : "null"})`));
    expect((await set(IDS.admin, IDS.clinician, "clinician", IDS.b1a)).error).toBeUndefined();
    expect((await run<{ region_id: string }>(db, `select region_id from public.user_roles where user_id = '${IDS.clinician}' and role = 'clinician'`)).rows[0].region_id).toBe(IDS.b1a);
    expect((await set(IDS.admin, IDS.clinician, "clinician", IDS.d1)).error).toBeUndefined(); // restore
    expect(code(await set(IDS.admin, IDS.admin, "admin", IDS.d1))).toBe("42501");
    expect(code(await set(IDS.admin, IDS.clinician, "citizen", IDS.d1))).toBe("22023");
    expect(code(await set(IDS.admin, IDS.clinician, "clinician", IDS.l1a1))).toBe("22023");
    expect(code(await set(IDS.admin, IDS.citizenA, "officer", IDS.d1))).toBe("P0002");
    for (const uid of [IDS.citizenA, IDS.clinician, IDS.officer1]) {
      expect(code(await set(uid, IDS.officer2, "officer", IDS.state)), uid).toBe("42501");
    }
    const audit = await run(db, `select 1 from public.audit_log where action = 'role.scope_changed' and actor_id = '${IDS.admin}'`);
    expect(audit.rows.length).toBeGreaterThanOrEqual(2);
  });
});

describe("reference data and settings", () => {
  it("regions: signed-in users read active regions; inactive ones are admin-only; citizens cannot write", async () => {
    const citizen = await asUser(db, IDS.citizenA, () => run<{ id: string }>(db, `select id from public.regions`));
    expect(citizen.rows.map((r) => r.id)).not.toContain(IDS.inactiveBlock);
    expect(citizen.rows.map((r) => r.id)).toContain(IDS.b1a);
    const admin = await asUser(db, IDS.admin, () => run<{ id: string }>(db, `select id from public.regions`));
    expect(admin.rows.map((r) => r.id)).toContain(IDS.inactiveBlock);
    expect(code(await asUser(db, IDS.citizenA, () => run(db, `insert into public.regions (name, region_type, parent_region_id) values ('Hack', 'block', '${IDS.d1}')`)))).toBe("42501");
    expect((await asUser(db, IDS.citizenA, () => run(db, `update public.regions set name = 'Hacked' where id = '${IDS.b1a}'`))).affected).toBe(0);
  });

  it("privacy settings are visible to staff only and writable by admins only", async () => {
    expect((await asUser(db, IDS.citizenA, () => run(db, `select * from public.privacy_settings`))).rows).toHaveLength(0);
    expect((await asUser(db, IDS.officer1, () => run(db, `select * from public.privacy_settings`))).rows.length).toBeGreaterThan(0);
    expect((await asUser(db, IDS.officer1, () => run(db, `update public.privacy_settings set value_int = 1`))).affected).toBe(0);
    expect((await asUser(db, IDS.citizenA, () => run(db, `update public.privacy_settings set value_int = 1`))).affected).toBe(0);
  });

  it("users cannot change their own region scope or roles", async () => {
    expect(code(await asUser(db, IDS.officer1, () => run(db, `update public.user_roles set region_id = '${IDS.state}' where user_id = '${IDS.officer1}' and role = 'officer'`)))).toBe("42501");
    expect(code(await asUser(db, IDS.citizenA, () => run(db, `insert into public.user_roles (user_id, role) values ('${IDS.citizenA}', 'officer')`)))).toBe("42501");
  });
});

describe("service-only pipeline functions", () => {
  it("are not callable by API roles", async () => {
    for (const sql of [
      `select public.deidentify_pending_reports(10)`,
      `select public.refresh_report_aggregates(current_date - 1, current_date)`,
      `select public.apply_report_retention()`,
    ]) {
      for (const uid of [IDS.citizenA, IDS.officer1, IDS.admin]) {
        expect(code(await asUser(db, uid, () => run(db, sql))), `${uid} ${sql}`).toBe("42501");
      }
      expect(code(await asAnon(db, () => run(db, sql)))).toBe("42501");
    }
  });

  it("trigger and audit helper functions are not callable by API roles", async () => {
    for (const fn of ["public.audit_row_change()", "public.health_reports_guard()", "public.write_audit(null, 'x', 'y', null, '{}'::jsonb)"]) {
      expect(code(await asUser(db, IDS.admin, () => run(db, `select ${fn}`))), fn).toBe("42501");
    }
  });
});

describe("role/scope probing is limited to the caller", () => {
  it("a signed-in user can test only their own roles and scopes", async () => {
    const q = (uid: string, sql: string) => asUser(db, uid, () => run<{ v: boolean }>(db, sql));
    // own: true
    expect((await q(IDS.officer1, `select public.has_role('${IDS.officer1}', 'officer') as v`)).rows[0].v).toBe(true);
    expect((await q(IDS.officer1, `select public.is_region_in_scope('${IDS.officer1}', 'officer', '${IDS.b1a}') as v`)).rows[0].v).toBe(true);
    // someone else: always false, even though the answer would be true
    expect((await q(IDS.citizenA, `select public.has_role('${IDS.admin}', 'admin') as v`)).rows[0].v).toBe(false);
    expect((await q(IDS.citizenA, `select public.has_role('${IDS.officer1}', 'officer') as v`)).rows[0].v).toBe(false);
    expect((await q(IDS.citizenA, `select public.is_region_in_scope('${IDS.officer1}', 'officer', '${IDS.b1a}') as v`)).rows[0].v).toBe(false);
    // even an admin cannot use it to read other people's scopes
    expect((await q(IDS.admin, `select public.is_region_in_scope('${IDS.officer1}', 'officer', '${IDS.b1a}') as v`)).rows[0].v).toBe(false);
  });

  it("internal (service/owner) evaluation still works", async () => {
    const r = await run<{ v: boolean }>(db, `select public.has_role('${IDS.admin}', 'admin') as v`);
    expect(r.rows[0].v).toBe(true);
  });
});
