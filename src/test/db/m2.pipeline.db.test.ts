// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { IDS, asService, createDb, reportInsertSql, run, seedFixture, type Db } from "./harness";

let db: Db;
const svc = <T,>(fn: () => Promise<T>) => asService(db, fn);

beforeAll(async () => {
  db = await createDb();
  await seedFixture(db);
}, 120_000);

const insertReport = async (o: Record<string, string> = {}) => (await run<{ id: string }>(db, reportInsertSql({ synthetic_batch: `'pipe-test'`, ...o }))).rows[0].id;

describe("RAW -> DEIDENTIFIED", () => {
  it("derives block-level, day-granularity rows with no submitter, free text or client id", async () => {
    // 19:00 UTC on 1 Jul is 00:30 IST on 2 Jul -> the derived date is the India-local date.
    const idLoc = await insertReport({ observed_at: `'2026-07-01T19:00:00Z'`, region_id: `'${IDS.l1a1}'`, free_text: `'loose stools since yesterday'`, severity: `'severe'` });
    const idBlock = await insertReport({ observed_at: `'2026-07-01T05:00:00Z'`, region_id: `'${IDS.b1a}'` });

    const n = await svc(() => run<{ n: number }>(db, `select public.deidentify_pending_reports(1000) as n`));
    expect(n.error).toBeUndefined();
    expect(n.rows[0].n).toBe(2);

    const d = await run<{ report_id: string; observed_date: string; region_id: string; is_synthetic: boolean; privacy_level: string; severity: string }>(db,
      `select report_id, observed_date::text, region_id, is_synthetic, privacy_level, severity from public.deidentified_observations order by observed_date`);
    const loc = d.rows.find((r) => r.report_id === idLoc)!;
    expect(loc.observed_date).toBe("2026-07-02");
    expect(loc.region_id).toBe(IDS.b1a); // locality coarsened to its block
    expect(loc.privacy_level).toBe("deidentified");
    expect(loc.is_synthetic).toBe(true);
    expect(loc.severity).toBe("severe");
    expect(d.rows.find((r) => r.report_id === idBlock)!.observed_date).toBe("2026-07-01");

    const cols = (await run<{ column_name: string }>(db, `select column_name from information_schema.columns where table_schema='public' and table_name='deidentified_observations'`)).rows.map((c) => c.column_name);
    for (const banned of ["submitted_by", "free_text", "client_submission_id", "created_by", "language"]) expect(cols).not.toContain(banned);
    expect(cols.some((c) => /observed_at|lat|lon|address|phone|email/i.test(c))).toBe(false);
  });

  it("moves processed reports to 'deidentified', is idempotent, and records the run in the audit log", async () => {
    const pending = await run(db, `select 1 from public.health_reports where processing_status = 'received'`);
    expect(pending.rows).toHaveLength(0);
    const again = await svc(() => run<{ n: number }>(db, `select public.deidentify_pending_reports(1000) as n`));
    expect(again.rows[0].n).toBe(0);
    const a = await run<{ metadata: { count: number } }>(db, `select metadata from public.audit_log where action = 'pipeline.deidentify'`);
    expect(a.rows[0].metadata.count).toBe(2);
  });

  it("does not process rejected reports and respects the batch limit", async () => {
    const rej = await insertReport();
    await run(db, `update public.health_reports set processing_status = 'rejected' where id = '${rej}'`);
    for (let i = 0; i < 3; i++) await insertReport();
    const first = await svc(() => run<{ n: number }>(db, `select public.deidentify_pending_reports(2) as n`));
    expect(first.rows[0].n).toBe(2);
    const rest = await svc(() => run<{ n: number }>(db, `select public.deidentify_pending_reports(10) as n`));
    expect(rest.rows[0].n).toBe(1);
    expect((await run(db, `select 1 from public.deidentified_observations where report_id = '${rej}'`)).rows).toHaveLength(0);
    expect((await svc(() => run(db, `select public.deidentify_pending_reports(0)`))).error?.code).toBe("22023");
  });

  it("unlinks (but keeps) the deidentified row when the raw report is withdrawn", async () => {
    const id = await insertReport({ region_id: `'${IDS.b1b}'` });
    await svc(() => run(db, `select public.deidentify_pending_reports(1000)`));
    const before = await run<{ id: string }>(db, `select id from public.deidentified_observations where report_id = '${id}'`);
    expect(before.rows).toHaveLength(1);
    await run(db, `delete from public.health_reports where id = '${id}'`);
    const after = await run<{ report_id: string | null }>(db, `select report_id from public.deidentified_observations where id = '${before.rows[0].id}'`);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].report_id).toBeNull();
  });
});

describe("DEIDENTIFIED -> AGGREGATED with small-cell suppression", () => {
  const day = (d: number) => `'2026-08-${String(d).padStart(2, "0")}T06:00:00Z'`;
  const cell = async (region: string, d: string, syndrome: string) =>
    (await run<{ case_count: number; report_count: number; suppressed: boolean; min_cell_size_applied: number; privacy_level: string }>(db,
      `select case_count, report_count, suppressed, min_cell_size_applied, privacy_level from public.report_aggregates where region_id = '${region}' and observed_date = '${d}' and syndrome = '${syndrome}'`)).rows[0];

  beforeAll(async () => {
    for (let i = 0; i < 5; i++) await insertReport({ observed_at: day(10), region_id: `'${IDS.b1a}'`, syndrome: `'fever'`, symptom_codes: `array['fever']` });
    for (let i = 0; i < 4; i++) await insertReport({ observed_at: day(10), region_id: `'${IDS.b1b}'`, syndrome: `'fever'`, symptom_codes: `array['fever']` });
    // one facility aggregate with 6 cases is a single report but six cases
    await insertReport({ observed_at: day(11), region_id: `'${IDS.b2a}'`, syndrome: `'jaundice'`, symptom_codes: `array['jaundice']`, source_type: `'health_facility'`, report_type: `'aggregate_count'`, case_count: `6` });
    await svc(() => run(db, `select public.deidentify_pending_reports(1000)`));
  }, 60_000);

  it("computes counts per block x day x syndrome and flags cells below the configured size", async () => {
    const n = await svc(() => run<{ n: number }>(db, `select public.refresh_report_aggregates('2026-08-01', '2026-08-31') as n`));
    expect(n.rows[0].n).toBe(3);
    expect(await cell(IDS.b1a, "2026-08-10", "fever")).toMatchObject({ case_count: 5, report_count: 5, suppressed: false, min_cell_size_applied: 5, privacy_level: "aggregated" });
    expect(await cell(IDS.b1b, "2026-08-10", "fever")).toMatchObject({ case_count: 4, suppressed: true });
    expect(await cell(IDS.b2a, "2026-08-11", "jaundice")).toMatchObject({ case_count: 6, report_count: 1, suppressed: false });
  });

  it("the suppression threshold is configuration, not a hard-coded guarantee", async () => {
    await run(db, `update public.privacy_settings set value_int = 7 where key = 'min_aggregate_cell_size'`);
    await svc(() => run(db, `select public.refresh_report_aggregates('2026-08-01', '2026-08-31')`));
    expect(await cell(IDS.b1a, "2026-08-10", "fever")).toMatchObject({ suppressed: true, min_cell_size_applied: 7 });
    expect(await cell(IDS.b2a, "2026-08-11", "jaundice")).toMatchObject({ suppressed: true });
    await run(db, `update public.privacy_settings set value_int = 3 where key = 'min_aggregate_cell_size'`);
    await svc(() => run(db, `select public.refresh_report_aggregates('2026-08-01', '2026-08-31')`));
    expect(await cell(IDS.b1b, "2026-08-10", "fever")).toMatchObject({ suppressed: false, min_cell_size_applied: 3 });
    await run(db, `update public.privacy_settings set value_int = 5 where key = 'min_aggregate_cell_size'`);
    await svc(() => run(db, `select public.refresh_report_aggregates('2026-08-01', '2026-08-31')`));
  });

  it("is idempotent and removes cells whose source rows disappeared", async () => {
    const snapshot = async () => (await run(db, `select region_id, observed_date::text, syndrome, case_count, suppressed from public.report_aggregates order by 1,2,3`)).rows;
    const a = await snapshot();
    await svc(() => run(db, `select public.refresh_report_aggregates('2026-08-01', '2026-08-31')`));
    expect(await snapshot()).toEqual(a);
    await run(db, `delete from public.deidentified_observations where region_id = '${IDS.b2a}' and observed_date = '2026-08-11'`);
    await svc(() => run(db, `select public.refresh_report_aggregates('2026-08-01', '2026-08-31')`));
    expect(await cell(IDS.b2a, "2026-08-11", "jaundice")).toBeUndefined();
  });

  it("rejects invalid ranges and records the run in the audit log", async () => {
    expect((await svc(() => run(db, `select public.refresh_report_aggregates('2026-08-31', '2026-08-01')`))).error?.code).toBe("22023");
    expect((await svc(() => run(db, `select public.refresh_report_aggregates('2025-01-01', '2026-08-01')`))).error?.code).toBe("22023");
    const a = await run(db, `select 1 from public.audit_log where action = 'pipeline.aggregate'`);
    expect(a.rows.length).toBeGreaterThanOrEqual(3);
  });

  it("aggregates carry no per-person fields", async () => {
    const cols = (await run<{ column_name: string }>(db, `select column_name from information_schema.columns where table_schema='public' and table_name='report_aggregates'`)).rows.map((c) => c.column_name).sort();
    expect(cols).toEqual(["case_count", "computed_at", "id", "min_cell_size_applied", "observed_date", "privacy_level", "region_id", "report_count", "suppressed", "syndrome"]);
  });
});

describe("retention", () => {
  it("clears old free text and unlinks old submitters, leaving recent data and the observation itself", async () => {
    await run(db, `insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000c0001', 'ret@test.invalid')`);
    const submitter = `'00000000-0000-0000-0000-0000000c0001'`;
    const old = (await run<{ id: string }>(db, reportInsertSql({ created_at: `now() - interval '40 days'`, free_text: `'old note'`, submitted_by: submitter }))).rows[0].id;
    const ancient = (await run<{ id: string }>(db, reportInsertSql({ created_at: `now() - interval '400 days'`, free_text: `'ancient note'`, submitted_by: submitter }))).rows[0].id;
    const fresh = (await run<{ id: string }>(db, reportInsertSql({ free_text: `'fresh note'`, submitted_by: submitter }))).rows[0].id;

    const r = await svc(() => run<{ r: { free_text_cleared: number; submitter_unlinked: number } }>(db, `select public.apply_report_retention() as r`));
    expect(r.error).toBeUndefined();
    expect(r.rows[0].r.free_text_cleared).toBe(2);
    expect(r.rows[0].r.submitter_unlinked).toBe(1);

    const rows = (await run<{ id: string; free_text: string | null; submitted_by: string | null; syndrome: string }>(db,
      `select id, free_text, submitted_by, syndrome from public.health_reports where id in ('${old}','${ancient}','${fresh}')`)).rows;
    const by = Object.fromEntries(rows.map((x) => [x.id, x]));
    expect(by[old].free_text).toBeNull();
    expect(by[old].submitted_by).toBe(submitter.replace(/'/g, ""));
    expect(by[ancient].free_text).toBeNull();
    expect(by[ancient].submitted_by).toBeNull();
    expect(by[fresh].free_text).toBe("fresh note");
    expect(by[fresh].syndrome).toBe("acute_diarrhoeal_illness"); // the observation itself is retained
  });

  it("deleting a user unlinks (does not delete) their reports", async () => {
    await run(db, `insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000c0002', 'gone@test.invalid')`);
    const id = (await run<{ id: string }>(db, reportInsertSql({ submitted_by: `'00000000-0000-0000-0000-0000000c0002'` }))).rows[0].id;
    await run(db, `delete from auth.users where id = '00000000-0000-0000-0000-0000000c0002'`);
    const r = await run<{ submitted_by: string | null }>(db, `select submitted_by from public.health_reports where id = '${id}'`);
    expect(r.rows[0].submitted_by).toBeNull();
  });
});

describe("report -> signal traceability without raw exposure", () => {
  it("links resolve to aggregates/observations and cascade when those are removed", async () => {
    await insertReport({ observed_at: `'2026-08-20T06:00:00Z'`, region_id: `'${IDS.b2a}'`, syndrome: `'fever'`, symptom_codes: `array['fever']` });
    await svc(() => run(db, `select public.deidentify_pending_reports(1000)`));
    await svc(() => run(db, `select public.refresh_report_aggregates('2026-08-15', '2026-08-25')`));
    const sig = (await run<{ id: string }>(db, `insert into public.signal_candidates (region_id, time_window_start, time_window_end, syndrome, observed_value)
      values ('${IDS.b2a}', '2026-08-20T00:00:00Z', '2026-08-21T00:00:00Z', 'fever', 1) returning id`)).rows[0].id;
    const obs = (await run<{ id: string }>(db, `select id from public.deidentified_observations where region_id = '${IDS.b2a}' and observed_date = '2026-08-20'`)).rows[0].id;
    const agg = (await run<{ id: string }>(db, `select id from public.report_aggregates where region_id = '${IDS.b2a}' and observed_date = '2026-08-20'`)).rows[0].id;
    expect((await run(db, `insert into public.report_signal_links (signal_candidate_id, observation_id) values ('${sig}', '${obs}')`)).error).toBeUndefined();
    expect((await run(db, `insert into public.report_signal_links (signal_candidate_id, aggregate_id) values ('${sig}', '${agg}')`)).error).toBeUndefined();
    expect((await run(db, `insert into public.report_signal_links (signal_candidate_id, aggregate_id) values ('${sig}', '${agg}')`)).error?.code).toBe("23505");
    await run(db, `delete from public.deidentified_observations where id = '${obs}'`);
    expect((await run(db, `select 1 from public.report_signal_links where signal_candidate_id = '${sig}'`)).rows).toHaveLength(1);
  });
});
