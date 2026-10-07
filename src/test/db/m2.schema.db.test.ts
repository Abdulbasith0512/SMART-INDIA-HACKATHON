// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { IDS, createDb, reportInsertSql, run, seedFixture, type Db } from "./harness";

let db: Db;

beforeAll(async () => {
  db = await createDb();
  await seedFixture(db);
}, 120_000);

const M2_TABLES = [
  "regions", "symptom_terms", "privacy_settings", "detection_methods", "health_reports",
  "deidentified_observations", "report_aggregates", "signal_candidates", "evidence_items",
  "signal_evidence", "report_signal_links",
];

describe("keys and indexes", () => {
  it("every M2 table has a primary key", async () => {
    const r = await run<{ table_name: string }>(db, `
      select tc.table_name from information_schema.table_constraints tc
      where tc.table_schema = 'public' and tc.constraint_type = 'PRIMARY KEY' and tc.table_name = any($1)`, [M2_TABLES]);
    expect(r.rows.map((x) => x.table_name).sort()).toEqual([...M2_TABLES].sort());
  });

  it("foreign keys exist for the relationships the model depends on", async () => {
    const r = await run<{ t: string; c: string }>(db, `
      select tc.table_name t, kcu.column_name c
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu using (constraint_schema, constraint_name)
      where tc.table_schema = 'public' and tc.constraint_type = 'FOREIGN KEY'`);
    const have = new Set(r.rows.map((x) => `${x.t}.${x.c}`));
    for (const fk of [
      "regions.parent_region_id", "health_reports.region_id", "health_reports.submitted_by",
      "deidentified_observations.report_id", "deidentified_observations.region_id",
      "report_aggregates.region_id", "signal_candidates.region_id", "signal_candidates.detection_method",
      "signal_evidence.signal_candidate_id", "signal_evidence.evidence_item_id",
      "report_signal_links.signal_candidate_id", "report_signal_links.observation_id",
      "report_signal_links.aggregate_id", "user_roles.region_id",
    ]) {
      expect(have, `missing FK ${fk}`).toContain(fk);
    }
  });

  it("deliberate indexes exist (region, observed_at, source, status, signal windows)", async () => {
    const r = await run<{ indexname: string }>(db, `select indexname from pg_indexes where schemaname = 'public'`);
    const have = new Set(r.rows.map((x) => x.indexname));
    for (const ix of [
      "health_reports_region_observed_idx", "health_reports_observed_idx", "health_reports_source_idx",
      "health_reports_pending_idx", "signal_candidates_region_window_idx", "signal_candidates_status_idx",
      "signal_candidates_syndrome_window_idx", "regions_parent_idx", "report_aggregates_region_date_idx",
      "deidentified_obs_region_date_idx",
    ]) {
      expect(have, `missing index ${ix}`).toContain(ix);
    }
  });

  it("RLS is enabled on every new table", async () => {
    const r = await run<{ relname: string; relrowsecurity: boolean }>(db, `
      select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any($1)`, [M2_TABLES]);
    expect(r.rows).toHaveLength(M2_TABLES.length);
    expect(r.rows.filter((x) => !x.relrowsecurity).map((x) => x.relname)).toEqual([]);
  });
});

describe("region hierarchy", () => {
  it("accepts the full chain and rejects a wrong parent level", async () => {
    for (const [type, parent] of [
      ["state", IDS.d1], // state under district
      ["district", IDS.country], // district under country
      ["block", IDS.state], // block under state
      ["locality", IDS.d1], // locality under district
    ] as const) {
      const r = await run(db, `insert into public.regions (name, region_type, parent_region_id) values ('X-${type}', '${type}', '${parent}')`);
      expect(r.error?.code, `${type} under wrong parent`).toBe("JS003");
    }
  });

  it("rejects a non-country region without a parent and a country with a parent", async () => {
    const a = await run(db, `insert into public.regions (name, region_type) values ('Orphan', 'district')`);
    expect(a.error).toBeTruthy();
    const b = await run(db, `insert into public.regions (name, region_type, parent_region_id) values ('Weird', 'country', '${IDS.country}')`);
    expect(b.error?.code).toBe("23514");
  });

  it("rejects duplicate names under one parent (case-insensitive) and duplicate administrative codes", async () => {
    const a = await run(db, `insert into public.regions (name, region_type, parent_region_id) values ('block 1a', 'block', '${IDS.d1}')`);
    expect(a.error?.code).toBe("23505");
    const b = await run(db, `insert into public.regions (name, region_type, parent_region_id, administrative_code) values ('Other', 'block', '${IDS.d1}', 'T-OD-1-A')`);
    expect(b.error?.code).toBe("23505");
  });

  it("region_type and parent are immutable; updated_at advances on edit", async () => {
    const a = await run(db, `update public.regions set region_type = 'district' where id = '${IDS.b1a}'`);
    expect(a.error?.code).toBe("JS008");
    const b = await run(db, `update public.regions set parent_region_id = '${IDS.d2}' where id = '${IDS.b1a}'`);
    expect(b.error?.code).toBe("JS008");

    const before = (await run<{ updated_at: string }>(db, `select updated_at from public.regions where id = '${IDS.b1b}'`)).rows[0].updated_at;
    await new Promise((r) => setTimeout(r, 25));
    await run(db, `update public.regions set name = 'Block 1B (renamed)' where id = '${IDS.b1b}'`);
    const after = (await run<{ updated_at: string }>(db, `select updated_at from public.regions where id = '${IDS.b1b}'`)).rows[0].updated_at;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it("region_subtree returns descendants-or-self; a referenced region cannot be deleted", async () => {
    const r = await run<{ id: string }>(db, `select id from public.region_subtree('${IDS.d1}')`);
    expect(r.rows.map((x) => x.id).sort()).toEqual([IDS.d1, IDS.b1a, IDS.b1b, IDS.l1a1, IDS.l1a2].sort());
    const del = await run(db, `delete from public.regions where id = '${IDS.state}'`);
    expect(["23001", "23503"]).toContain(del.error?.code); // ON DELETE RESTRICT
  });

  it("scoped roles need a real region; only clinician/officer may carry a scope", async () => {
    const a = await run(db, `update public.user_roles set region_id = '00000000-0000-0000-0000-00000000dead' where user_id = '${IDS.officer1}' and role = 'officer'`);
    expect(a.error?.code).toBe("23503");
    const b = await run(db, `update public.user_roles set region_id = '${IDS.d1}' where user_id = '${IDS.admin}' and role = 'admin'`);
    expect(b.error?.code).toBe("23514");
  });
});

describe("health_reports: constraints, vocabularies and data minimisation", () => {
  it("accepts a valid report and applies safe defaults", async () => {
    const r = await run<{ id: string }>(db, reportInsertSql());
    expect(r.error).toBeUndefined();
    const row = (await run<Record<string, unknown>>(db, `select * from public.health_reports where id = $1`, [r.rows[0].id])).rows[0];
    expect(row.processing_status).toBe("received");
    expect(row.privacy_level).toBe("raw");
    expect(row.report_type).toBe("individual_observation");
    expect(row.case_count).toBe(1);
    expect(row.created_at).toBeTruthy();
    expect(row.updated_at).toBeTruthy();
  });

  it("stores only an allow-listed set of columns (no GPS, address, phone, email, DOB, national id)", async () => {
    const cols = (await run<{ column_name: string }>(db, `
      select column_name from information_schema.columns where table_schema = 'public' and table_name = 'health_reports'`))
      .rows.map((c) => c.column_name).sort();
    expect(cols).toEqual([
      "age_band", "case_count", "client_submission_id", "created_at", "free_text", "id", "language",
      "observed_at", "privacy_level", "processing_status", "region_id", "report_type", "severity",
      "source_type", "submitted_by", "symptom_codes", "syndrome", "synthetic_batch", "updated_at",
    ]);
    const forbidden = /(lat|lon|lng|gps|geo|address|street|phone|mobile|email|aadhaar|aadhar|dob|birth|national_id|pincode|ssn)/i;
    expect(cols.filter((c) => forbidden.test(c))).toEqual([]);
  });

  it("no M2 table anywhere carries exact-location or direct-identifier columns", async () => {
    const r = await run<{ table_name: string; column_name: string }>(db, `
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and table_name = any($1)`, [M2_TABLES]);
    const forbidden = /(latitude|longitude|\blat\b|\blon\b|gps|address|phone|mobile|email|aadhaar|aadhar|dob|birth|pincode)/i;
    expect(r.rows.filter((c) => forbidden.test(c.column_name))).toEqual([]);
  });

  it("rejects invalid enum values (severity, source_type, age_band, syndrome)", async () => {
    for (const [col, val] of [["severity", "extreme"], ["source_type", "carrier_pigeon"], ["age_band", "age_100"], ["syndrome", "plague"]]) {
      const r = await run(db, reportInsertSql({ [col]: `'${val}'` }));
      expect(r.error?.code, col).toBe("22P02");
    }
  });

  it("rejects an unknown language and a non-raw privacy_level", async () => {
    expect((await run(db, reportInsertSql({ language: `'fr'` }))).error?.code).toBe("23514");
    expect((await run(db, reportInsertSql({ privacy_level: `'deidentified'` }))).error?.code).toBe("23514");
  });

  it("enforces required fields", async () => {
    expect((await run(db, `insert into public.health_reports (source_type, region_id, syndrome) values ('citizen', '${IDS.b1a}', 'fever')`)).error?.code).toBe("23502");
    expect((await run(db, `insert into public.health_reports (observed_at, region_id, syndrome) values (now(), '${IDS.b1a}', 'fever')`)).error?.code).toBe("23502");
    expect((await run(db, `insert into public.health_reports (observed_at, source_type, syndrome) values (now(), 'citizen', 'fever')`)).error?.code).toBe("23502");
  });

  it("validates the region: unknown, inactive and too-coarse regions are rejected; locality is accepted", async () => {
    expect((await run(db, reportInsertSql({ region_id: `'00000000-0000-0000-0000-00000000beef'` }))).error?.code).toBe("JS001");
    expect((await run(db, reportInsertSql({ region_id: `'${IDS.inactiveBlock}'` }))).error?.code).toBe("JS002");
    expect((await run(db, reportInsertSql({ region_id: `'${IDS.d1}'` }))).error?.code).toBe("JS003");
    expect((await run(db, reportInsertSql({ region_id: `'${IDS.country}'` }))).error?.code).toBe("JS003");
    expect((await run(db, reportInsertSql({ region_id: `'${IDS.l1a1}'` }))).error).toBeUndefined();
  });

  it("validates timestamps: no future observations; live sources cannot be older than 90 days", async () => {
    expect((await run(db, reportInsertSql({ observed_at: `now() + interval '2 hours'` }))).error?.code).toBe("JS005");
    expect((await run(db, reportInsertSql({ observed_at: `now() - interval '120 days'` }))).error?.code).toBe("JS005");
    // historical imports and tagged synthetic batches are allowed to be old
    expect((await run(db, reportInsertSql({ observed_at: `now() - interval '120 days'`, source_type: `'imported_dataset'` }))).error).toBeUndefined();
    expect((await run(db, reportInsertSql({ observed_at: `now() - interval '120 days'`, synthetic_batch: `'t-batch'` }))).error).toBeUndefined();
  });

  it("validates and normalises symptom codes (unknown rejected, deduped and sorted, max 10)", async () => {
    expect((await run(db, reportInsertSql({ symptom_codes: `array['diarrhoea','made_up']` }))).error?.code).toBe("JS004");
    const ok = await run<{ id: string }>(db, reportInsertSql({ symptom_codes: `array['vomiting','diarrhoea','vomiting']` }));
    const row = (await run<{ symptom_codes: string[] }>(db, `select symptom_codes from public.health_reports where id = $1`, [ok.rows[0].id])).rows[0];
    expect(row.symptom_codes).toEqual(["diarrhoea", "vomiting"]);
    const eleven = `array['diarrhoea','vomiting','dehydration_signs','abdominal_pain','fever','headache','body_ache','rash','jaundice','dark_urine','cough']`;
    expect((await run(db, reportInsertSql({ symptom_codes: eleven }))).error?.code).toBe("23514");
  });

  it("enforces case_count and report_type rules", async () => {
    expect((await run(db, reportInsertSql({ case_count: `3` }))).error?.code).toBe("23514"); // individual must be 1
    expect((await run(db, reportInsertSql({ case_count: `0`, report_type: `'aggregate_count'`, source_type: `'health_facility'` }))).error?.code).toBe("23514");
    expect((await run(db, reportInsertSql({ report_type: `'aggregate_count'`, source_type: `'citizen'`, case_count: `4` }))).error?.code).toBe("23514");
    expect((await run(db, reportInsertSql({ report_type: `'aggregate_count'`, source_type: `'health_facility'`, case_count: `4` }))).error).toBeUndefined();
  });

  it("blocks PII in free text (phone-like runs, national-id-like runs, e-mail) and normalises whitespace", async () => {
    for (const text of ["call 9876543210 please", "id 1234 5678 9012", "mail me a.b@example.org"]) {
      expect((await run(db, reportInsertSql({ free_text: `'${text}'` }))).error?.code, text).toBe("23514");
    }
    expect((await run(db, reportInsertSql({ free_text: `repeat('x', 501)` }))).error?.code).toBe("23514");
    const ok = await run<{ id: string }>(db, reportInsertSql({ free_text: `'  3 days of   loose stools, 12 times  '` }));
    expect(ok.error).toBeUndefined();
    const row = (await run<{ free_text: string }>(db, `select free_text from public.health_reports where id = $1`, [ok.rows[0].id])).rows[0];
    expect(row.free_text).toBe("3 days of loose stools, 12 times");
  });
});

describe("data integrity: duplicates and lifecycle", () => {
  it("treats a repeated (submitted_by, client_submission_id) as a duplicate", async () => {
    const sub = `'00000000-0000-0000-0000-0000000aaaa1'`;
    await run(db, `insert into auth.users (id, email) values (${sub}, 'dup@test.invalid')`);
    const cid = `'00000000-0000-0000-0000-0000000bbbb1'`;
    const first = await run(db, reportInsertSql({ submitted_by: sub, client_submission_id: cid }));
    expect(first.error).toBeUndefined();
    const second = await run(db, reportInsertSql({ submitted_by: sub, client_submission_id: cid }));
    expect(second.error?.code).toBe("23505");
  });

  it("report content is immutable; only lifecycle changes and privacy clearing are allowed", async () => {
    const id = (await run<{ id: string }>(db, reportInsertSql({ free_text: `'two days fever'` }))).rows[0].id;
    expect((await run(db, `update public.health_reports set severity = 'severe' where id = $1`, [id])).error?.code).toBe("JS008");
    expect((await run(db, `update public.health_reports set region_id = '${IDS.b1b}' where id = $1`, [id])).error?.code).toBe("JS008");
    expect((await run(db, `update public.health_reports set free_text = 'changed' where id = $1`, [id])).error?.code).toBe("JS008");
    expect((await run(db, `update public.health_reports set free_text = null where id = $1`, [id])).error).toBeUndefined();
  });

  it("processing_status follows received -> validated -> deidentified; no way back; rejected is terminal", async () => {
    const id = (await run<{ id: string }>(db, reportInsertSql())).rows[0].id;
    expect((await run(db, `update public.health_reports set processing_status = 'validated' where id = $1`, [id])).error).toBeUndefined();
    expect((await run(db, `update public.health_reports set processing_status = 'received' where id = $1`, [id])).error?.code).toBe("JS007");
    expect((await run(db, `update public.health_reports set processing_status = 'deidentified' where id = $1`, [id])).error).toBeUndefined();
    expect((await run(db, `update public.health_reports set processing_status = 'rejected' where id = $1`, [id])).error?.code).toBe("JS007");

    const id2 = (await run<{ id: string }>(db, reportInsertSql())).rows[0].id;
    await run(db, `update public.health_reports set processing_status = 'rejected' where id = $1`, [id2]);
    expect((await run(db, `update public.health_reports set processing_status = 'validated' where id = $1`, [id2])).error?.code).toBe("JS007");
    expect((await run(db, `update public.health_reports set processing_status = 'bogus' where id = $1`, [id2])).error?.code).toBe("22P02");
  });
});

describe("signal_candidates contract and lifecycle", () => {
  const insertSignal = (extra = "", cols = "") =>
    run<{ id: string }>(db, `
      insert into public.signal_candidates (region_id, time_window_start, time_window_end, syndrome, observed_value ${cols})
      values ('${IDS.b1a}', '2026-07-01T00:00:00Z', '2026-07-03T00:00:00Z', 'acute_diarrhoeal_illness', 12 ${extra}) returning id`);

  it("accepts a candidate with M3-populated fields left empty (M2 computes nothing)", async () => {
    const r = await insertSignal();
    expect(r.error).toBeUndefined();
    const row = (await run<Record<string, unknown>>(db, `select * from public.signal_candidates where id = $1`, [r.rows[0].id])).rows[0];
    expect(row.status).toBe("candidate");
    expect(row.verification_status).toBe("unverified");
    expect(row.baseline_value).toBeNull();
    expect(row.signal_score).toBeNull();
    expect(row.detection_method).toBe("unspecified");
    expect(row.origin).toBe("system_detector");
  });

  it("enforces window, value, confidence and uniqueness constraints", async () => {
    expect((await run(db, `insert into public.signal_candidates (region_id, time_window_start, time_window_end, syndrome, observed_value)
      values ('${IDS.b1a}', '2026-07-05T00:00:00Z', '2026-07-04T00:00:00Z', 'fever', 1)`)).error?.code).toBe("23514");
    expect((await run(db, `insert into public.signal_candidates (region_id, time_window_start, time_window_end, syndrome, observed_value)
      values ('${IDS.b1a}', '2026-07-05T00:00:00Z', '2026-07-06T00:00:00Z', 'fever', -1)`)).error?.code).toBe("23514");
    expect((await insertSignal(", 1.5", ", confidence")).error?.code).toBe("23514");
    expect((await insertSignal()).error?.code).toBe("23505"); // same region/syndrome/window/method
    expect((await run(db, `insert into public.signal_candidates (region_id, time_window_start, time_window_end, syndrome, observed_value, detection_method)
      values ('${IDS.b1a}', '2026-07-09T00:00:00Z', '2026-07-10T00:00:00Z', 'fever', 1, 'no_such_method')`)).error?.code).toBe("23503");
  });

  it("couples status and verification_status", async () => {
    expect((await insertSignal(", 'in_progress'", ", verification_status")).error?.code).toBe("23514"); // candidate must be unverified
    const mk = async (start: string) =>
      (await run<{ id: string }>(db, `insert into public.signal_candidates (region_id, time_window_start, time_window_end, syndrome, observed_value)
        values ('${IDS.b1b}', '${start}T00:00:00Z', '${start}T12:00:00Z', 'fever', 4) returning id`)).rows[0].id;
    const id = await mk("2026-08-01");
    expect((await run(db, `update public.signal_candidates set status = 'under_review', verification_status = 'in_progress' where id = $1`, [id])).error).toBeUndefined();
    // verified requires 'supported'
    expect((await run(db, `update public.signal_candidates set status = 'verified' where id = $1`, [id])).error?.code).toBe("23514");
    expect((await run(db, `update public.signal_candidates set status = 'verified', verification_status = 'supported' where id = $1`, [id])).error).toBeUndefined();
    expect((await run(db, `update public.signal_candidates set status = 'monitoring' where id = $1`, [id])).error).toBeUndefined();
    // resolved needs resolved_at
    expect((await run(db, `update public.signal_candidates set status = 'resolved' where id = $1`, [id])).error?.code).toBe("23514");
    expect((await run(db, `update public.signal_candidates set status = 'resolved', resolved_at = now() where id = $1`, [id])).error).toBeUndefined();
  });

  it("allows only the defined transitions; resolved/dismissed are terminal", async () => {
    const mk = async (start: string) =>
      (await run<{ id: string }>(db, `insert into public.signal_candidates (region_id, time_window_start, time_window_end, syndrome, observed_value)
        values ('${IDS.b2a}', '${start}T00:00:00Z', '${start}T12:00:00Z', 'jaundice', 3) returning id`)).rows[0].id;
    const a = await mk("2026-08-02");
    expect((await run(db, `update public.signal_candidates set status = 'verified', verification_status = 'supported' where id = $1`, [a])).error?.code).toBe("JS007"); // candidate -> verified
    expect((await run(db, `update public.signal_candidates set status = 'monitoring', verification_status = 'supported' where id = $1`, [a])).error?.code).toBe("JS007");
    expect((await run(db, `update public.signal_candidates set status = 'dismissed', resolved_at = now() where id = $1`, [a])).error).toBeUndefined();
    expect((await run(db, `update public.signal_candidates set status = 'under_review', resolved_at = null where id = $1`, [a])).error?.code).toBe("JS007"); // terminal
    expect((await run(db, `update public.signal_candidates set status = 'sleeping' where id = $1`, [a])).error?.code).toBe("22P02");
  });

  it("signal identity is immutable", async () => {
    const id = (await run<{ id: string }>(db, `insert into public.signal_candidates (region_id, time_window_start, time_window_end, syndrome, observed_value)
      values ('${IDS.b2a}', '2026-08-03T00:00:00Z', '2026-08-03T12:00:00Z', 'fever', 2) returning id`)).rows[0].id;
    expect((await run(db, `update public.signal_candidates set region_id = '${IDS.b1a}' where id = $1`, [id])).error?.code).toBe("JS008");
    expect((await run(db, `update public.signal_candidates set syndrome = 'jaundice' where id = $1`, [id])).error?.code).toBe("JS008");
  });
});

describe("evidence and links", () => {
  it("validates evidence_items (reference required, URL scheme, hash format, trust needs verification time)", async () => {
    const ins = (cols: string, vals: string) => run<{ id: string }>(db, `insert into public.evidence_items (title, publisher, source_type, ${cols}) values ('T','P','guideline', ${vals}) returning id`);
    expect((await run(db, `insert into public.evidence_items (title, publisher, source_type) values ('T','P','guideline')`)).error?.code).toBe("23514");
    expect((await ins("reference_url", `'ftp://nope'`)).error?.code).toBe("23514");
    expect((await ins("citation, content_hash", `'c', 'xyz'`)).error?.code).toBe("23514");
    expect((await ins("citation, trust_level", `'c', 'trusted'`)).error?.code).toBe("23514");
    expect((await ins("reference_url, citation, trust_level, verified_at", `'https://example.org/a', 'c', 'trusted', now()`)).error).toBeUndefined();
    expect((await ins("reference_url", `'HTTPS://EXAMPLE.org/a'`)).error?.code).toBe("23505"); // case-insensitive URL uniqueness
    const hash = "a".repeat(64);
    expect((await ins("citation, content_hash", `'c1', '${hash}'`)).error).toBeUndefined();
    expect((await ins("citation, content_hash", `'c2', '${hash}'`)).error?.code).toBe("23505");
  });

  it("signal_evidence is a many-to-many join with a composite key", async () => {
    const sig = (await run<{ id: string }>(db, `insert into public.signal_candidates (region_id, time_window_start, time_window_end, syndrome, observed_value)
      values ('${IDS.b1a}', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', 'fever', 5) returning id`)).rows[0].id;
    const ev = (await run<{ id: string }>(db, `insert into public.evidence_items (title, publisher, source_type, citation) values ('E','P','guideline','c-se') returning id`)).rows[0].id;
    expect((await run(db, `insert into public.signal_evidence (signal_candidate_id, evidence_item_id) values ($1, $2)`, [sig, ev])).error).toBeUndefined();
    expect((await run(db, `insert into public.signal_evidence (signal_candidate_id, evidence_item_id) values ($1, $2)`, [sig, ev])).error?.code).toBe("23505");
    expect(["23001", "23503"]).toContain((await run(db, `delete from public.evidence_items where id = $1`, [ev])).error?.code);
  });

  it("report_signal_links point at exactly one DEIDENTIFIED/AGGREGATE target and never at raw reports", async () => {
    const cols = (await run<{ column_name: string }>(db, `select column_name from information_schema.columns where table_schema='public' and table_name='report_signal_links'`)).rows.map((c) => c.column_name);
    expect(cols).not.toContain("report_id");
    expect(cols).not.toContain("health_report_id");
    const sig = (await run<{ id: string }>(db, `insert into public.signal_candidates (region_id, time_window_start, time_window_end, syndrome, observed_value)
      values ('${IDS.b1b}', '2026-09-03T00:00:00Z', '2026-09-04T00:00:00Z', 'fever', 5) returning id`)).rows[0].id;
    expect((await run(db, `insert into public.report_signal_links (signal_candidate_id) values ($1)`, [sig])).error?.code).toBe("23514");
    expect((await run(db, `insert into public.report_signal_links (signal_candidate_id, observation_id) values ($1, gen_random_uuid())`, [sig])).error?.code).toBe("23503");
  });
});

describe("audit of reference/state changes", () => {
  it("records which fields changed, never their values", async () => {
    await run(db, `update public.privacy_settings set value_int = 6 where key = 'min_aggregate_cell_size'`);
    await run(db, `update public.privacy_settings set value_int = 5 where key = 'min_aggregate_cell_size'`);
    const r = await run<{ action: string; metadata: { changed_fields: string[] } }>(db, `
      select action, metadata from public.audit_log where entity = 'privacy_settings' and action = 'privacy_settings.update' order by id`);
    expect(r.rows.length).toBeGreaterThanOrEqual(2);
    expect(r.rows[0].metadata.changed_fields).toEqual(["value_int"]);
    expect(JSON.stringify(r.rows)).not.toContain("min_aggregate_cell_size\":6");
  });

  it("audits region creation", async () => {
    const r = await run(db, `select 1 from public.audit_log where action = 'regions.insert' and entity_id = '${IDS.state}'`);
    expect(r.rows.length).toBe(1);
  });
});
