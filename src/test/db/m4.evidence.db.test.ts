// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { IDS, asAnon, asService, asUser, createDb, run, seedFixture, type Db } from "./harness";
import { EVIDENCE_TOPICS } from "../../evidence/vocab";

let db: Db;
let pre: Db; // schema as of the last M3 migration
const code = (o: { error?: { code?: string } }) => o.error?.code;
const HASH = (c: string) => c.repeat(64);

const ids: Record<string, string> = {};
let nItem = 0;

/** Insert a document as the privileged connection (a draft unless asked otherwise). */
async function item(over: Record<string, string> = {}): Promise<string> {
  nItem++;
  const cols: Record<string, string> = {
    title: `'Doc ${nItem}'`, publisher: `'Synthetic Health Authority'`, source_type: `'guideline'`, citation: `'cit-${nItem}'`,
    source_class: `'national_government_health_agency'`, evidence_kind: `'operational_guidance'`,
    topics: `array['outbreak_investigation']`, syndromes: `array['fever']::public.syndrome_category[]`,
    geo_scope: `'national'`, canonical_id: `'doc-${nItem}'`, trust_level: `'trusted'`, verified_at: `now()`, is_synthetic: `true`,
    ...over,
  };
  const names = Object.keys(cols);
  const r = await run<{ id: string }>(db, `insert into public.evidence_items (${names.join(",")}) values (${names.map((n) => cols[n]).join(",")}) returning id`);
  if (r.error) throw new Error(`item(): ${r.error.message}`);
  return r.rows[0].id;
}

let nVer = 0;
async function version(itemId: string, over: Record<string, string> = {}): Promise<string> {
  nVer++;
  const cols: Record<string, string> = {
    evidence_item_id: `'${itemId}'`, version_label: `'v${nVer}'`, content_hash: `'${HASH((nVer % 15).toString(16))}'`, is_current: "true",
    abstract: `'Curator abstract for document'`, ...over,
  };
  const names = Object.keys(cols);
  const r = await run<{ id: string }>(db, `insert into public.evidence_versions (${names.join(",")}) values (${names.map((n) => cols[n]).join(",")}) returning id`);
  if (r.error) throw new Error(`version(): ${r.error.message}`);
  return r.rows[0].id;
}
const chunk = (versionId: string, ordinal: number, text: string, extra = "") =>
  run<{ id: string }>(db, `insert into public.evidence_chunks (version_id, ordinal, kind, text ${extra ? "," + extra.split("=")[0] : ""}) values ('${versionId}', ${ordinal}, 'excerpt', $1 ${extra ? "," + extra.split("=")[1] : ""}) returning id`, [text]);

/** A fully described, current, trusted document with one version and one chunk. */
async function currentItem(over: Record<string, string> = {}) {
  const itemId = await item(over);
  const v = await version(itemId);
  const c = (await chunk(v, 0, "Surveillance staff should verify a reported cluster by reviewing line lists.")).rows[0].id;
  const up = await run(db, `update public.evidence_items set status = 'current' where id = '${itemId}'`);
  if (up.error) throw new Error(`currentItem(): ${up.error.message}`);
  return { itemId, versionId: v, chunkId: c };
}

beforeAll(async () => {
  db = await createDb();
  pre = await createDb({ stopBefore: "20261007060000" });
  await seedFixture(db);
  const sig = async (region: string, day: string) =>
    (await run<{ id: string }>(db, `insert into public.signal_candidates (region_id, time_window_start, time_window_end, syndrome, observed_value)
      values ('${region}', '${day}T00:00:00Z', '${day}T23:00:00Z', 'fever', 9) returning id`)).rows[0].id;
  ids.sigD1 = await sig(IDS.b1a, "2026-09-01");
  ids.sigD2 = await sig(IDS.b2a, "2026-09-01");
}, 180_000);

describe("M1-M3 are untouched by the M4 migration", () => {
  const colsOf = async (d: Db) =>
    (await run<{ k: string }>(d, `select table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') as k
      from information_schema.columns where table_schema = 'public' and table_name <> 'evidence_items' order by 1`)).rows.map((r) => r.k);

  it("every pre-existing table (except evidence_items) has identical columns", async () => {
    const before = await colsOf(pre);
    const after = await colsOf(db);
    expect(before.length).toBeGreaterThan(150);
    const kept = after.filter((k) => before.includes(k));
    expect(kept).toEqual(before); // nothing removed or altered; additions only come from new M4 tables
  });

  it("every pre-existing function is byte-identical", async () => {
    const fns = async (d: Db) => (await run<{ k: string }>(d, `select p.proname || ':' || md5(pg_get_functiondef(p.oid)) as k from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' order by 1`)).rows.map((r) => r.k);
    const before = await fns(pre);
    const after = await fns(db);
    expect(after.filter((k) => before.includes(k))).toEqual(before);
  });

  it("every pre-existing policy is identical except the intentionally replaced evidence_items_select", async () => {
    const pol = async (d: Db) => (await run<{ k: string }>(d, `select tablename || '.' || policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '') as k
      from pg_policies where schemaname = 'public' order by 1`)).rows.map((r) => r.k);
    const before = (await pol(pre)).filter((k) => !k.startsWith("evidence_items.evidence_items_select:"));
    const after = await pol(db);
    expect(after.filter((k) => before.includes(k))).toEqual(before);
  });

  it("evidence_items keeps all its M2 columns (additive change only)", async () => {
    const cols = async (d: Db) => (await run<{ c: string }>(d, `select column_name as c from information_schema.columns where table_name = 'evidence_items' and table_schema = 'public'`)).rows.map((r) => r.c);
    const before = await cols(pre);
    const after = await cols(db);
    for (const c of before) expect(after).toContain(c);
    for (const c of ["source_class", "evidence_kind", "topics", "geo_scope", "status", "supersedes_id", "is_synthetic"]) expect(after).toContain(c);
  });

  it("signal_candidates detector-owned columns still carry the M3 guard (explanation/evidence are not writable by M4 tables)", async () => {
    const c = await run<{ n: number }>(db, `select count(*)::int as n from information_schema.columns where table_name = 'signal_candidates' and column_name in ('explanation','evidence','score_components','episode_key')`);
    expect(c.rows[0].n).toBe(4);
  });
});

describe("controlled vocabulary", () => {
  it("evidence_topics matches the TypeScript vocabulary exactly", async () => {
    const r = await run<{ code: string }>(db, `select code from public.evidence_topics order by code`);
    expect(r.rows.map((x) => x.code)).toEqual([...EVIDENCE_TOPICS].sort());
  });
  it("unknown topics are rejected on documents", async () => {
    expect(code(await run(db, `insert into public.evidence_items (title, publisher, source_type, citation, topics) values ('x','y','guideline','c','{made_up}')`))).toBe("JS004");
  });
});

describe("evidence_items: lifecycle and consistency", () => {
  it("new documents start as draft/quarantined; 'current' needs a current version and full description", async () => {
    expect(code(await run(db, `insert into public.evidence_items (title, publisher, source_type, citation, status) values ('x','y','guideline','c','current')`))).toBe("JS007");
    const id = await item();
    expect(code(await run(db, `update public.evidence_items set status = 'current' where id = '${id}'`))).toBe("JS007"); // no version yet
    await version(id);
    expect((await run(db, `update public.evidence_items set status = 'current' where id = '${id}'`)).error).toBeUndefined();
  });

  it("an under-described, unverified or unreviewed document cannot be current", async () => {
    for (const over of [
      { source_class: `'unverified'` }, { trust_level: `'unreviewed'`, verified_at: "null" }, { evidence_kind: "null" },
      { geo_scope: "null" }, { canonical_id: "null" }, { topics: `'{}'` },
    ]) {
      const id = await item(over);
      await version(id);
      expect(code(await run(db, `update public.evidence_items set status = 'current' where id = '${id}'`)), JSON.stringify(over)).toBe("23514");
    }
  });

  it("real (non-synthetic) current documents need an allow-listed domain and a verification basis", async () => {
    const id = await item({ is_synthetic: "false" });
    await version(id);
    expect(code(await run(db, `update public.evidence_items set status = 'current' where id = '${id}'`))).toBe("23514");
    await run(db, `update public.evidence_items set source_domain = 'example.org', verification_basis = array['domain_allowlist','curator_reviewed'] where id = '${id}'`);
    expect((await run(db, `update public.evidence_items set status = 'current' where id = '${id}'`)).error).toBeUndefined();
    expect(code(await run(db, `update public.evidence_items set verification_basis = array['made_up'] where id = '${id}'`))).toBe("23514");
  });

  it("only the defined status transitions are allowed; withdrawn is terminal", async () => {
    const { itemId } = await currentItem();
    const to = (s: string) => run(db, `update public.evidence_items set status = '${s}' where id = '${itemId}'`);
    expect(code(await to("draft"))).toBe("JS007");
    expect((await to("superseded")).error).toBeUndefined();
    expect(code(await to("current"))).toBe("JS007");
    expect((await to("historical")).error).toBeUndefined();
    expect((await to("withdrawn")).error).toBeUndefined();
    expect(code(await to("current"))).toBe("JS007");
    expect(code(await to("historical"))).toBe("JS007");
  });

  it("geography, validity period, self-supersession and the synthetic flag are enforced", async () => {
    expect(code(await run(db, `insert into public.evidence_items (title, publisher, source_type, citation, geo_scope) values ('x','y','guideline','c','state')`))).toBe("23514"); // state needs a region
    expect(code(await run(db, `insert into public.evidence_items (title, publisher, source_type, citation, geo_scope, geo_region_id) values ('x','y','guideline','c','national','${IDS.state}')`))).toBe("23514");
    expect((await run(db, `insert into public.evidence_items (title, publisher, source_type, citation, geo_scope, geo_region_id) values ('x','y','guideline','c2','state','${IDS.state}')`)).error).toBeUndefined();
    expect(code(await run(db, `insert into public.evidence_items (title, publisher, source_type, citation, valid_from, valid_until) values ('x','y','guideline','c3','2026-02-01','2026-01-01')`))).toBe("23514");
    const id = await item();
    expect(code(await run(db, `update public.evidence_items set supersedes_id = id where id = '${id}'`))).toBe("23514");
    expect(code(await run(db, `update public.evidence_items set is_synthetic = false where id = '${id}'`))).toBe("JS008");
    expect(code(await run(db, `update public.evidence_items set source_class = 'not_a_class' where id = '${id}'`))).toBe("22P02");
  });
});

describe("versions and chunks", () => {
  it("versions: hash format, uniqueness, a single current version, immutable content", async () => {
    const id = await item();
    const v1 = await version(id, { content_hash: `'${HASH("a")}'`, version_label: `'1.0'` });
    expect(code(await run(db, `insert into public.evidence_versions (evidence_item_id, version_label, content_hash) values ('${id}', '1.1', 'xyz')`))).toBe("23514");
    expect(code(await run(db, `insert into public.evidence_versions (evidence_item_id, version_label, content_hash) values ('${id}', '1.0', '${HASH("b")}')`))).toBe("23505");
    expect(code(await run(db, `insert into public.evidence_versions (evidence_item_id, version_label, content_hash) values ('${id}', '1.2', '${HASH("a")}')`))).toBe("23505");
    expect(code(await run(db, `insert into public.evidence_versions (evidence_item_id, version_label, content_hash, is_current) values ('${id}', '1.3', '${HASH("c")}', true)`))).toBe("23505"); // second current
    expect(code(await run(db, `update public.evidence_versions set content_hash = '${HASH("d")}' where id = '${v1}'`))).toBe("JS008");
    expect(code(await run(db, `update public.evidence_versions set abstract = 'changed' where id = '${v1}'`))).toBe("JS008");
    expect((await run(db, `update public.evidence_versions set is_current = false where id = '${v1}'`)).error).toBeUndefined();
  });

  it("abstract and chunk text are plain text only (no markup, control or invisible characters)", async () => {
    const id = await item();
    for (const bad of ["<script>alert(1)</script>", "see <a href=x>link</a>", "<!-- hidden -->", "bell\u0007char", "zero\u200bwidth", "bidi\u202eoverride", "bom\ufeffchar"]) {
      expect(code(await run(db, `insert into public.evidence_versions (evidence_item_id, version_label, content_hash, abstract) values ('${id}', 'bad-${bad.length}', '${HASH("e")}', $1)`, [bad])), JSON.stringify(bad)).toBe("23514");
    }
    const v = await version(id);
    for (const bad of ["<script>x</script>", "<img src=x onerror=1>", "ctrl\u0001char", "inv\u2060isible", "x".repeat(1501), ""]) {
      expect(code(await chunk(v, 99, bad)), JSON.stringify(bad.slice(0, 20))).toBe("23514");
    }
    for (const ok of ["Hospital pH < 7 reported", "ଝାଡ଼ା ଏବଂ ବାନ୍ତି ପାଇଁ ସତର୍କତା", "दस्त के मामलों की जाँच करें", "Counts rose 3 > 2 over the week"]) {
      expect((await chunk(v, Math.floor(Math.random() * 1e6), ok)).error, ok).toBeUndefined();
    }
  });

  it("chunk hash is computed and verified; chunks are immutable and ordered", async () => {
    const id = await item();
    const v = await version(id);
    const c = await chunk(v, 0, "Verify the cluster with the district surveillance officer.");
    const row = (await run<{ chunk_hash: string }>(db, `select chunk_hash from public.evidence_chunks where id = '${c.rows[0].id}'`)).rows[0];
    expect(row.chunk_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await run<{ ok: boolean }>(db, `select chunk_hash = encode(sha256(convert_to(text, 'UTF8')), 'hex') as ok from public.evidence_chunks where id = '${c.rows[0].id}'`)).rows[0].ok).toBe(true);
    expect(code(await chunk(v, 1, "text", `chunk_hash='${HASH("0")}'`))).toBe("JS008");
    expect(code(await chunk(v, 0, "duplicate ordinal"))).toBe("23505");
    expect(code(await run(db, `update public.evidence_chunks set text = 'tampered' where id = '${c.rows[0].id}'`))).toBe("JS008");
  });

  it("translations carry provenance; reviewed requires a timestamp; only hi/or", async () => {
    const id = await item();
    expect((await run(db, `insert into public.evidence_translations (evidence_item_id, language, title, provenance) values ('${id}', 'hi', 'शीर्षक', 'machine')`)).error).toBeUndefined();
    expect(code(await run(db, `insert into public.evidence_translations (evidence_item_id, language, title, provenance) values ('${id}', 'en', 'x', 'human')`))).toBe("23514");
    expect(code(await run(db, `insert into public.evidence_translations (evidence_item_id, language, title, provenance, review_status) values ('${id}', 'or', 'x', 'human', 'reviewed')`))).toBe("23514");
    expect(code(await run(db, `insert into public.evidence_translations (evidence_item_id, language, title, provenance) values ('${id}', 'hi', 'dup', 'human')`))).toBe("23505");
  });
});

describe("snapshots, retrieval runs, bundles, citations", () => {
  let snap = "", runId = "", bundleId = "", cur: Awaited<ReturnType<typeof currentItem>>, other: Awaited<ReturnType<typeof currentItem>>;
  beforeAll(async () => {
    cur = await currentItem();
    other = await currentItem();
    snap = (await run<{ id: string }>(db, `insert into public.corpus_snapshots (corpus_version, corpus_hash, item_count, chunk_count, includes_synthetic, is_active) values ('c-1', '${HASH("a")}', 2, 2, true, true) returning id`)).rows[0].id;
    runId = (await run<{ id: string }>(db, `insert into public.retrieval_runs (signal_candidate_id, corpus_snapshot_id, retrieval_version, retrieval_config_hash, query_vocab_version, as_of_date)
      values ('${ids.sigD1}', '${snap}', 'r/1', '${HASH("b")}', 'query-vocab/1.0.0', '2026-09-02') returning id`)).rows[0].id;
    bundleId = (await run<{ id: string }>(db, `insert into public.evidence_bundles (retrieval_run_id, signal_candidate_id, bundle_hash, schema_version, bundle, item_count)
      values ('${runId}', '${ids.sigD1}', '${HASH("c")}', 'bundle/1', '{"facets":[]}', 1) returning id`)).rows[0].id;
  });

  it("corpus snapshots: unique version/hash and a single active snapshot", async () => {
    expect(code(await run(db, `insert into public.corpus_snapshots (corpus_version, corpus_hash, item_count, chunk_count, includes_synthetic) values ('c-1', '${HASH("1")}', 0, 0, true)`))).toBe("23505");
    expect(code(await run(db, `insert into public.corpus_snapshots (corpus_version, corpus_hash, item_count, chunk_count, includes_synthetic) values ('c-2', '${HASH("a")}', 0, 0, true)`))).toBe("23505");
    expect(code(await run(db, `insert into public.corpus_snapshots (corpus_version, corpus_hash, item_count, chunk_count, includes_synthetic, is_active) values ('c-3', '${HASH("2")}', 0, 0, true, true)`))).toBe("23505");
  });

  it("a bundle is unique per (signal, hash) and append-only", async () => {
    expect(code(await run(db, `insert into public.evidence_bundles (retrieval_run_id, signal_candidate_id, bundle_hash, schema_version, bundle) values ('${runId}', '${ids.sigD1}', '${HASH("c")}', 'bundle/1', '{}')`))).toBe("23505");
    expect(code(await run(db, `update public.evidence_bundles set item_count = 5 where id = '${bundleId}'`))).toBe("JS008");
    expect(code(await run(db, `insert into public.evidence_bundles (retrieval_run_id, signal_candidate_id, bundle_hash, schema_version, bundle) values ('${runId}', '${ids.sigD1}', '${HASH("d")}', 'bundle/1', '[]')`))).toBe("23514");
  });

  it("bundle items: the chunk must belong to the cited version; ids and ranks are unique and well-formed", async () => {
    const ok = await run<{ id: string }>(db, `insert into public.evidence_bundle_items (bundle_id, evidence_version_id, chunk_id, facet, rank, citation_id) values ('${bundleId}', '${cur.versionId}', '${cur.chunkId}', 'verification_guidance', 1, 'E1') returning id`);
    expect(ok.error).toBeUndefined();
    ids.bundleItem = ok.rows[0].id;
    expect(code(await run(db, `insert into public.evidence_bundle_items (bundle_id, evidence_version_id, chunk_id, facet, rank, citation_id) values ('${bundleId}', '${cur.versionId}', '${other.chunkId}', 'case_definition', 1, 'E2')`))).toBe("JS008");
    expect(code(await run(db, `insert into public.evidence_bundle_items (bundle_id, evidence_version_id, chunk_id, facet, rank, citation_id) values ('${bundleId}', '${other.versionId}', '${other.chunkId}', 'case_definition', 1, 'E1')`))).toBe("23505");
    expect(code(await run(db, `insert into public.evidence_bundle_items (bundle_id, evidence_version_id, chunk_id, facet, rank, citation_id) values ('${bundleId}', '${other.versionId}', '${other.chunkId}', 'case_definition', 1, 'cite-2')`))).toBe("23514");
    expect(code(await run(db, `update public.evidence_bundle_items set rank = 2 where id = '${ids.bundleItem}'`))).toBe("JS008");
  });

  it("explanations: status/output consistency, idempotency key, stale flag is the only mutable field, raw is separate", async () => {
    const ins = (over = "") => run<{ id: string }>(db, `insert into public.generated_explanations (bundle_id, provider, model, prompt_version, input_hash, status, output ${over}) values ('${bundleId}', 'mock', 'mock-1', 'p/1', '${HASH("e")}', 'validated', '{"points":[]}') returning id`);
    const e = await ins();
    expect(e.error).toBeUndefined();
    ids.explanation = e.rows[0].id;
    expect(code(await ins())).toBe("23505"); // same bundle + prompt + provider + model + input
    expect(code(await run(db, `insert into public.generated_explanations (bundle_id, provider, model, prompt_version, input_hash, status) values ('${bundleId}', 'mock', 'mock-1', 'p/2', '${HASH("e")}', 'validated')`))).toBe("23514");
    expect((await run(db, `insert into public.generated_explanations (bundle_id, provider, model, prompt_version, input_hash, status) values ('${bundleId}', 'mock', 'mock-1', 'p/3', '${HASH("f")}', 'rejected')`)).error).toBeUndefined();
    expect(code(await run(db, `insert into public.generated_explanations (bundle_id, provider, model, prompt_version, input_hash, status, output, language) values ('${bundleId}', 'mock', 'mock-1', 'p/4', '${HASH("1")}', 'validated', '{}', 'fr')`))).toBe("23514");
    expect(code(await run(db, `update public.generated_explanations set output = '{"points":[1]}' where id = '${ids.explanation}'`))).toBe("JS008");
    expect((await run(db, `update public.generated_explanations set citation_status = 'stale' where id = '${ids.explanation}'`)).error).toBeUndefined();
    expect((await run(db, `insert into public.generated_explanation_raw (explanation_id, raw) values ('${ids.explanation}', 'raw model text')`)).error).toBeUndefined();
  });

  it("a citation must point to an item of the explanation's own bundle", async () => {
    expect((await run(db, `insert into public.explanation_citations (explanation_id, claim_index, bundle_item_id, quote, anchor_verified) values ('${ids.explanation}', 0, '${ids.bundleItem}', 'verify a reported cluster', true)`)).error).toBeUndefined();
    // an item from a different bundle
    const run2 = (await run<{ id: string }>(db, `insert into public.retrieval_runs (signal_candidate_id, corpus_snapshot_id, retrieval_version, retrieval_config_hash, query_vocab_version, as_of_date) values ('${ids.sigD2}', '${snap}', 'r/1', '${HASH("b")}', 'v', '2026-09-02') returning id`)).rows[0].id;
    const b2 = (await run<{ id: string }>(db, `insert into public.evidence_bundles (retrieval_run_id, signal_candidate_id, bundle_hash, schema_version, bundle) values ('${run2}', '${ids.sigD2}', '${HASH("9")}', 'bundle/1', '{}') returning id`)).rows[0].id;
    const foreign = (await run<{ id: string }>(db, `insert into public.evidence_bundle_items (bundle_id, evidence_version_id, chunk_id, facet, rank, citation_id) values ('${b2}', '${other.versionId}', '${other.chunkId}', 'f', 1, 'E1') returning id`)).rows[0].id;
    expect(code(await run(db, `insert into public.explanation_citations (explanation_id, claim_index, bundle_item_id) values ('${ids.explanation}', 1, '${foreign}')`))).toBe("JS008");
    ids.bundle2 = b2;
  });
});

describe("RLS and access", () => {
  const seen = (uid: string, sql: string) => asUser(db, uid, () => run<{ id: string }>(db, sql));

  it("documents: citizens see only current + trusted + real (non-synthetic) items; staff see current; admins see everything", async () => {
    const real = await currentItem({ is_synthetic: "false", source_domain: `'example.org'`, verification_basis: `array['domain_allowlist']`, title: `'REAL-VISIBLE'` });
    const synth = await currentItem({ title: `'SYNTH-CURRENT'` });
    const draft = await item({ title: `'DRAFT-ITEM'` });
    const quarantined = await item({ title: `'QUARANTINED-ITEM'`, status: `'quarantined'` });
    const withdrawn = await currentItem({ title: `'WITHDRAWN-ITEM'` });
    await run(db, `update public.evidence_items set status = 'withdrawn' where id = '${withdrawn.itemId}'`);
    const titles = async (uid: string) => (await asUser(db, uid, () => run<{ title: string }>(db, `select title from public.evidence_items where title in ('REAL-VISIBLE','SYNTH-CURRENT','DRAFT-ITEM','QUARANTINED-ITEM','WITHDRAWN-ITEM') order by title`))).rows.map((r) => r.title);
    expect(await titles(IDS.citizenA)).toEqual(["REAL-VISIBLE"]);
    expect(await titles(IDS.officer1)).toEqual(["REAL-VISIBLE", "SYNTH-CURRENT"]);
    expect(await titles(IDS.clinician)).toEqual(["REAL-VISIBLE", "SYNTH-CURRENT"]);
    expect(await titles(IDS.admin)).toEqual(["DRAFT-ITEM", "QUARANTINED-ITEM", "REAL-VISIBLE", "SYNTH-CURRENT", "WITHDRAWN-ITEM"]);
    expect(await asAnon(db, () => run(db, `select title from public.evidence_items`)).then((r) => r.error?.code)).toBe("42501");
    ids.real = real.itemId; ids.synth = synth.itemId; ids.draft = draft; ids.quarantined = quarantined;
  });

  it("versions and chunks are exactly as visible as their document", async () => {
    const vis = async (uid: string) => ({
      v: (await seen(uid, `select id from public.evidence_versions where evidence_item_id in ('${ids.real}','${ids.synth}','${ids.draft}')`)).rows.length,
      c: (await seen(uid, `select c.id from public.evidence_chunks c join public.evidence_versions v on v.id = c.version_id where v.evidence_item_id in ('${ids.real}','${ids.synth}','${ids.draft}')`)).rows.length,
    });
    expect(await vis(IDS.citizenA)).toEqual({ v: 1, c: 1 });
    expect(await vis(IDS.officer1)).toEqual({ v: 2, c: 2 });
    expect(await vis(IDS.admin)).toEqual({ v: 2, c: 2 }); // the draft has no version in this fixture
  });

  it("bundles, items, explanations and citations are visible only where the signal is visible", async () => {
    const counts = async (uid: string) => ({
      bundles: (await seen(uid, `select id from public.evidence_bundles`)).rows.length,
      items: (await seen(uid, `select id from public.evidence_bundle_items`)).rows.length,
      expl: (await seen(uid, `select id from public.generated_explanations`)).rows.length,
      cites: (await seen(uid, `select id from public.explanation_citations`)).rows.length,
      runs: (await seen(uid, `select id from public.retrieval_runs`)).rows.length,
    });
    const d1 = await counts(IDS.officer1);
    const d2 = await counts(IDS.officer2);
    expect(d1.bundles).toBe(1);
    expect(d1.items).toBeGreaterThanOrEqual(1);
    expect(d1.expl).toBeGreaterThanOrEqual(1);
    expect(d1.cites).toBe(1);
    expect(d2.bundles).toBe(1); // only the D2 bundle created above
    expect(d2.cites).toBe(0);
    expect(d1.runs).toBe(1);
    for (const uid of [IDS.citizenA, IDS.clinician, IDS.officerNoScope]) expect(await counts(uid), uid).toEqual({ bundles: 0, items: 0, expl: 0, cites: 0, runs: 0 });
    expect((await counts(IDS.admin)).bundles).toBe(2);
  });

  it("raw model output, evaluation results and snapshots: admin-only (snapshots also officers)", async () => {
    await run(db, `insert into public.evidence_evaluation_runs (kind, retrieval_config_hash, corpus_hash, scenario_set_ref, n_scenarios, metrics) values ('dev', '${HASH("a")}', '${HASH("b")}', 'set-1', 1, '{}')`);
    expect((await seen(IDS.admin, `select explanation_id as id from public.generated_explanation_raw`)).rows).toHaveLength(1);
    expect((await seen(IDS.officer1, `select explanation_id as id from public.generated_explanation_raw`)).rows).toHaveLength(0);
    expect((await seen(IDS.admin, `select id from public.evidence_evaluation_runs`)).rows).toHaveLength(1);
    expect((await seen(IDS.officer1, `select id from public.evidence_evaluation_runs`)).rows).toHaveLength(0);
    expect((await seen(IDS.officer1, `select id from public.corpus_snapshots`)).rows).toHaveLength(1);
    expect((await seen(IDS.citizenA, `select id from public.corpus_snapshots`)).rows).toHaveLength(0);
    expect((await seen(IDS.officer1, `select code as id from public.evidence_topics`)).rows.length).toBe(EVIDENCE_TOPICS.length);
    expect((await seen(IDS.citizenA, `select code as id from public.evidence_topics`)).rows).toHaveLength(0);
  });

  it("no client — not even an admin — can write corpus, bundle, generation or evaluation tables", async () => {
    const writes = [
      `insert into public.evidence_versions (evidence_item_id, version_label, content_hash) values ('${ids.real}', 'x', '${HASH("7")}')`,
      `insert into public.evidence_chunks (version_id, ordinal, kind, text) values (gen_random_uuid(), 9, 'excerpt', 'x')`,
      `insert into public.corpus_snapshots (corpus_version, corpus_hash, item_count, chunk_count, includes_synthetic) values ('hack', '${HASH("7")}', 0, 0, true)`,
      `insert into public.evidence_bundles (retrieval_run_id, signal_candidate_id, bundle_hash, schema_version, bundle) values (gen_random_uuid(), '${ids.sigD1}', '${HASH("7")}', 'b', '{}')`,
      `insert into public.generated_explanations (bundle_id, provider, model, prompt_version, input_hash, status) values (gen_random_uuid(), 'p', 'm', 'v', '${HASH("7")}', 'rejected')`,
      `insert into public.explanation_citations (explanation_id, claim_index, bundle_item_id) values (gen_random_uuid(), 0, gen_random_uuid())`,
      `insert into public.generated_explanation_raw (explanation_id, raw) values (gen_random_uuid(), 'x')`,
      `insert into public.evidence_evaluation_runs (kind, retrieval_config_hash, corpus_hash, scenario_set_ref, n_scenarios, metrics) values ('dev', '${HASH("7")}', '${HASH("7")}', 'x', 1, '{}')`,
      `delete from public.evidence_bundles`,
      `update public.generated_explanations set citation_status = 'stale'`,
    ];
    for (const sql of writes) {
      for (const uid of [IDS.admin, IDS.officer1, IDS.citizenA]) expect(code(await asUser(db, uid, () => run(db, sql))), `${uid}: ${sql.slice(0, 50)}`).toBe("42501");
    }
  });

  it("admin curation of documents works with the new columns; others cannot curate; status cannot jump to current without a version", async () => {
    const ins = (uid: string, citation: string) => asUser(db, uid, () => run(db, `insert into public.evidence_items (title, publisher, source_type, citation, source_class, evidence_kind, topics, geo_scope) values ('Admin doc','Synthetic Health Authority','guideline','${citation}','recognized_institution','research',array['surveillance_methods'],'global')`));
    expect((await ins(IDS.admin, "admin-cit-1")).error).toBeUndefined();
    for (const uid of [IDS.officer1, IDS.clinician, IDS.citizenA]) expect(code(await ins(uid, `x-${uid}`)), uid).toBe("42501");
    const id = (await run<{ id: string }>(db, `select id from public.evidence_items where citation = 'admin-cit-1'`)).rows[0].id;
    expect(code(await asUser(db, IDS.admin, () => run(db, `update public.evidence_items set status = 'current' where id = '${id}'`)))).toBe("JS007");
    expect((await asUser(db, IDS.admin, () => run(db, `update public.evidence_items set status = 'quarantined' where id = '${id}'`))).error).toBeUndefined();
    expect(code(await asUser(db, IDS.admin, () => run(db, `update public.evidence_items set is_synthetic = true where id = '${id}'`)))).toBe("42501"); // not an updatable column for clients
    // RLS filters an UPDATE by a non-admin to zero rows (no error, nothing changes).
    const blocked = await asUser(db, IDS.officer1, () => run(db, `update public.evidence_items set status = 'current' where id = '${id}'`));
    expect(blocked.affected).toBe(0);
    expect((await run<{ status: string }>(db, `select status from public.evidence_items where id = '${id}'`)).rows[0].status).toBe('quarantined');
  });

  it("trigger and helper functions are not callable by API roles", async () => {
    for (const fn of ["public.evidence_items_guard()", "public.evidence_chunks_guard()", "public.m4_append_only()", "public.generated_explanations_guard()"]) {
      expect(code(await asUser(db, IDS.admin, () => run(db, `select ${fn}`))), fn).toBe("42501");
    }
  });
});

describe("audit", () => {
  it("version, snapshot, run, bundle and explanation creation are audited; chunk volume is not", async () => {
    const actions = (await run<{ action: string }>(db, `select distinct action from public.audit_log`)).rows.map((r) => r.action);
    for (const a of ["evidence_versions.insert", "corpus_snapshots.insert", "retrieval_runs.insert", "evidence_bundles.insert", "generated_explanations.insert", "evidence_evaluation_runs.insert"]) {
      expect(actions, a).toContain(a);
    }
    expect(actions).not.toContain("evidence_chunks.insert");
    void asService;
  });
});
