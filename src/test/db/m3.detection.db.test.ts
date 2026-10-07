// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { IDS, asService, asUser, createDb, reportInsertSql, run, seedFixture, type Db } from "./harness";

let db: Db;
let runId = "";
const code = (o: { error?: { code?: string } }) => o.error?.code;
const HASH = "a".repeat(64);
const KEY = (n: number) => n.toString(16).padStart(64, "0");

const payload = (over: Record<string, unknown> = {}) => ({
  method_code: "windowed_gamma_poisson_v1",
  episode_key: KEY(1),
  region_id: IDS.b1a,
  syndrome: "fever",
  window_start: "2026-08-01T00:00:00+05:30",
  window_end: "2026-08-06T00:00:00+05:30",
  observed_value: 14, baseline_value: 3.2, deviation: 4.1, signal_score: 72.5,
  sample_count: 14, minimum_sample_count: 5, confidence: 0.6,
  explanation: "Emerging signal requiring verification: elevated fever observations in Block 1A over the last 5 days. 14 reports vs about 3.2 expected (x4.4). This is a statistical flag, not a confirmed outbreak or a diagnosis. Human verification required.",
  run_id: runId, first_detected_on: "2026-08-03", last_seen_on: "2026-08-05",
  score_components: { deviation: 0.9 }, evidence: { involved_blocks: [IDS.b1a] },
  ...over,
});
const upsert = (p: Record<string, unknown>) => asService(db, () => run<{ r: { id: string; action: string } }>(db, `select public.upsert_detected_signal($1::jsonb) as r`, [JSON.stringify(p)]));

beforeAll(async () => {
  db = await createDb();
  await seedFixture(db);
  runId = (await run<{ id: string }>(db, `
    insert into public.detector_runs (detector_name, detector_version, method_code, config, config_hash, mode, data_from, data_to, privacy_k_applied, evidence_floor)
    values ('jansanket-detector', 'windowed-gamma-poisson/1.0.0', 'windowed_gamma_poisson_v1', '{}'::jsonb, '${HASH}', 'replay', '2026-06-15', '2026-09-12', 5, 5) returning id`)).rows[0].id;
}, 120_000);

describe("feature function over the deidentified tier", () => {
  it("returns block x day x syndrome cells with per-source counts and no synthetic marker", async () => {
    for (let i = 0; i < 3; i++) await run(db, reportInsertSql({ observed_at: `'2026-08-02T06:00:00Z'`, syndrome: `'fever'`, symptom_codes: `array['fever']`, synthetic_batch: `'t'`, source_type: `'citizen'` }));
    await run(db, reportInsertSql({ observed_at: `'2026-08-02T06:00:00Z'`, syndrome: `'fever'`, symptom_codes: `array['fever']`, synthetic_batch: `'t'`, source_type: `'health_facility'`, report_type: `'aggregate_count'`, case_count: `4`, severity: `'unknown'` }));
    await asService(db, () => run(db, `select public.deidentify_pending_reports(1000)`));
    const r = await asService(db, () => run<{ f: Array<Record<string, unknown>> }>(db, `select public.detection_daily_features('2026-08-01', '2026-08-03') as f`));
    expect(r.error).toBeUndefined();
    const cell = r.rows[0].f.find((c) => c.syndrome === "fever" && c.date === "2026-08-02")!;
    expect(cell).toMatchObject({ region_id: IDS.b1a, reports: 4, cases: 7, unknown_severity: 1, by_source: { citizen: 3, health_facility: 1 } });
    expect(Object.keys(cell).sort()).toEqual(["by_source", "cases", "date", "region_id", "reports", "syndrome", "unknown_severity"]);
    expect(code(await asService(db, () => run(db, `select public.detection_daily_features('2020-01-01', '2026-01-01')`)))).toBe("22023");
  });

  it("is not callable by any client role", async () => {
    for (const uid of [IDS.citizenA, IDS.officer1, IDS.admin]) {
      expect(code(await asUser(db, uid, () => run(db, `select public.detection_daily_features('2026-08-01', '2026-08-03')`)))).toBe("42501");
      expect(code(await asUser(db, uid, () => run(db, `select public.upsert_detected_signal('{}'::jsonb)`)))).toBe("42501");
    }
  });
});

describe("upsert_detected_signal: idempotent episodes with invariants", () => {
  it("inserts a candidate, then extends it (idempotent by episode key)", async () => {
    const a = await upsert(payload());
    expect(a.error).toBeUndefined();
    expect(a.rows[0].r.action).toBe("inserted");
    const b = await upsert(payload({ window_end: "2026-08-08T00:00:00+05:30", observed_value: 20, sample_count: 20, signal_score: 80, last_seen_on: "2026-08-07" }));
    expect(b.rows[0].r).toMatchObject({ action: "updated", id: a.rows[0].r.id });
    const row = (await run<Record<string, unknown>>(db, `select *, last_seen_on::text as last_seen from public.signal_candidates where episode_key = '${KEY(1)}'`)).rows;
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ status: "candidate", origin: "system_detector", sample_count: 20, last_seen: "2026-08-07" });
    expect(new Date(row[0].time_window_end as string).toISOString()).toBe("2026-08-07T18:30:00.000Z");
    // window end never moves backwards
    await upsert(payload({ window_end: "2026-08-04T00:00:00+05:30" }));
    const after = (await run<{ e: string }>(db, `select time_window_end::text as e from public.signal_candidates where episode_key = '${KEY(1)}'`)).rows[0].e;
    expect(after.startsWith("2026-08-07")).toBe(true);
  });

  it("region may widen block -> parent district, but never narrows or jumps", async () => {
    await upsert(payload({ region_id: IDS.d1 }));
    const r1 = (await run<{ region_id: string }>(db, `select region_id from public.signal_candidates where episode_key = '${KEY(1)}'`)).rows[0].region_id;
    expect(r1).toBe(IDS.d1);
    await upsert(payload({ region_id: IDS.b1b })); // narrowing request ignored
    expect((await run<{ region_id: string }>(db, `select region_id from public.signal_candidates where episode_key = '${KEY(1)}'`)).rows[0].region_id).toBe(IDS.d1);
    await upsert(payload({ episode_key: KEY(2), region_id: IDS.b2a, syndrome: "jaundice" }));
    await upsert(payload({ episode_key: KEY(2), region_id: IDS.d1, syndrome: "jaundice" })); // not its parent
    expect((await run<{ region_id: string }>(db, `select region_id from public.signal_candidates where episode_key = '${KEY(2)}'`)).rows[0].region_id).toBe(IDS.b2a);
  });

  it("once a human starts review, the detector cannot change the evidence (only records it saw it again)", async () => {
    await upsert(payload({ episode_key: KEY(3), syndrome: "respiratory_illness" }));
    const id = (await run<{ id: string }>(db, `select id from public.signal_candidates where episode_key = '${KEY(3)}'`)).rows[0].id;
    await asUser(db, IDS.officer1, () => run(db, `select public.review_signal_candidate('${id}', 'under_review', 'in_progress')`));
    const r = await upsert(payload({ episode_key: KEY(3), syndrome: "respiratory_illness", observed_value: 99, sample_count: 99, signal_score: 99, last_seen_on: "2026-08-10", window_end: "2026-08-11T00:00:00+05:30" }));
    expect(r.rows[0].r.action).toBe("seen_under_review");
    const row = (await run<Record<string, unknown>>(db, `select *, last_seen_on::text as last_seen from public.signal_candidates where id = '${id}'`)).rows[0];
    expect(row).toMatchObject({ status: "under_review", sample_count: 14, last_seen: "2026-08-10" });
    expect(Number(row.signal_score)).toBe(72.5);
  });

  it("rejects sub-threshold evidence, unsafe wording, wrong region level and out-of-range scores", async () => {
    expect(code(await upsert(payload({ episode_key: KEY(10), sample_count: 4, observed_value: 4 })))).toBe("JS009");
    expect(code(await upsert(payload({ episode_key: KEY(11), minimum_sample_count: 3 })))).toBe("JS009");
    expect(code(await upsert(payload({ episode_key: KEY(12), explanation: "OUTBREAK CONFIRMED in Block 1A" })))).toBe("JS009");
    expect(code(await upsert(payload({ episode_key: KEY(13), explanation: "Emerging signal requiring verification: x." })))).toBe("JS009");
    expect(code(await upsert(payload({ episode_key: KEY(14), region_id: IDS.l1a1 })))).toBe("JS003");
    expect(code(await upsert(payload({ episode_key: KEY(15), signal_score: 140 })))).toBe("JS009");
  });

  it("the k floor follows privacy_settings", async () => {
    await run(db, `update public.privacy_settings set value_int = 20 where key = 'min_aggregate_cell_size'`);
    expect(code(await upsert(payload({ episode_key: KEY(16), minimum_sample_count: 20 })))).toBe("JS009"); // 14 < 20
    await run(db, `update public.privacy_settings set value_int = 5 where key = 'min_aggregate_cell_size'`);
  });

  it("direct writes cannot extend windows or bypass the guard; M2 manual signals still work", async () => {
    const id = (await run<{ id: string }>(db, `select id from public.signal_candidates where episode_key = '${KEY(2)}'`)).rows[0].id;
    expect(code(await asService(db, () => run(db, `update public.signal_candidates set time_window_end = time_window_end + interval '3 days' where id = '${id}'`)))).toBe("JS008");
    expect(code(await asService(db, () => run(db, `update public.signal_candidates set episode_key = '${KEY(99)}' where id = '${id}'`)))).toBe("JS008");
    const manual = await run(db, `insert into public.signal_candidates (region_id, time_window_start, time_window_end, syndrome, observed_value)
      values ('${IDS.b2a}', '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z', 'fever', 3)`);
    expect(manual.error).toBeUndefined();
  });

  it("score and confidence are documented as non-probabilities in the schema", async () => {
    const r = await run<{ c: string }>(db, `select col_description('public.signal_candidates'::regclass, a.attnum) as c from pg_attribute a
      where a.attrelid = 'public.signal_candidates'::regclass and a.attname in ('signal_score', 'confidence') order by a.attname`);
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) expect(row.c).toMatch(/NOT a probability/);
  });
});

describe("provenance / findings / evaluation access", () => {
  beforeAll(async () => {
    await run(db, `insert into public.detector_findings (run_id, as_of_date, district_id, block_ids, scope, syndrome, window_days, observed, expected, p_value, ratio, decision, failed_gates)
      values ('${runId}', '2026-08-05', '${IDS.d1}', array['${IDS.b1a}']::uuid[], 'block', 'fever', 5, 14, 3.2, 1e-6, 4.4, 'candidate', '{}'),
             ('${runId}', '2026-08-05', '${IDS.d2}', array['${IDS.b2a}']::uuid[], 'block', 'fever', 3, null, 0.4, 2e-5, 9, 'watch', '{evidence}')`);
    await run(db, `insert into public.evaluation_runs (kind, detector_version, config_hash, matching_rules_version, dataset_ref, n_datasets, metrics)
      values ('primary', 'windowed-gamma-poisson/1.0.0', '${HASH}', 'match/1.0.0', 'm2-odisha-v1', 1, '{"recall": 0.75}')`);
  });

  it("findings never store a count below the suppression threshold", async () => {
    const r = await run(db, `insert into public.detector_findings (run_id, as_of_date, district_id, block_ids, scope, syndrome, window_days, observed, expected, p_value, decision)
      values ('${runId}', '2026-08-05', '${IDS.d1}', array['${IDS.b1a}']::uuid[], 'block', 'fever', 3, 3, 0.4, 1e-5, 'watch')`);
    expect(code(r)).toBe("JS009");
    const bad = await run(db, `insert into public.detector_findings (run_id, as_of_date, district_id, block_ids, scope, syndrome, window_days, observed, expected, p_value, decision, failed_gates)
      values ('${runId}', '2026-08-05', '${IDS.d1}', array['${IDS.b1a}']::uuid[], 'block', 'fever', 3, 8, 0.4, 1e-5, 'gated', '{made_up}')`);
    expect(code(bad)).toBe("23514");
  });

  it("officers read findings only for districts in scope; citizens and clinicians read none", async () => {
    const seen = async (uid: string) => (await asUser(db, uid, () => run<{ district_id: string }>(db, `select district_id from public.detector_findings`))).rows.map((r) => r.district_id);
    expect(await seen(IDS.officer1)).toEqual([IDS.d1]);
    expect(await seen(IDS.officer2)).toEqual([IDS.d2]);
    expect(await seen(IDS.officerNoScope)).toEqual([]);
    expect(await seen(IDS.citizenA)).toEqual([]);
    expect(await seen(IDS.clinician)).toEqual([]);
    expect((await seen(IDS.admin)).sort()).toEqual([IDS.d1, IDS.d2].sort());
  });

  it("run metadata is readable by officers/admins; evaluation results by admins only", async () => {
    expect((await asUser(db, IDS.officer2, () => run(db, `select id from public.detector_runs`))).rows).toHaveLength(1);
    expect((await asUser(db, IDS.citizenA, () => run(db, `select id from public.detector_runs`))).rows).toHaveLength(0);
    expect((await asUser(db, IDS.admin, () => run(db, `select id from public.evaluation_runs`))).rows).toHaveLength(1);
    expect((await asUser(db, IDS.officer1, () => run(db, `select id from public.evaluation_runs`))).rows).toHaveLength(0);
  });

  it("clients cannot write provenance, findings or evaluations", async () => {
    for (const sql of [
      `insert into public.detector_runs (detector_name, detector_version, method_code, config, config_hash, mode, data_from, data_to, privacy_k_applied, evidence_floor) values ('x','y','manual','{}','${HASH}','replay','2026-01-01','2026-01-02',5,5)`,
      `delete from public.detector_findings`,
      `update public.evaluation_runs set metrics = '{}'`,
    ]) {
      expect(code(await asUser(db, IDS.admin, () => run(db, sql))), sql.slice(0, 30)).toBe("42501");
    }
  });

  it("detector runs are audited", async () => {
    const r = await run(db, `select 1 from public.audit_log where action = 'detector_runs.insert' and entity_id = '${runId}'`);
    expect(r.rows).toHaveLength(1);
  });
});
