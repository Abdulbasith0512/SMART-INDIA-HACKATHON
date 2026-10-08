// @vitest-environment node
// M4.5 against the REAL migrated schema (PGlite): validated and rejected explanations in the existing M4.0 tables, the cache
// (same inputs are never generated twice), raw model output readable by administrators only, append-only behaviour, recovery
// from an interrupted write, re-validation of stored explanations, and row-level security. The bundle itself must be untouched.
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildBundleForSignal } from "@/evidence/bundle/pipeline";
import { persistBundle } from "@/evidence/bundle/persist";
import { ingestCorpus, type EvidenceDb } from "@/evidence/ingest/ingest";
import { buildCorpus } from "@/evidence/ingest/loader";
import { explainSignal } from "@/evidence/llm/pipeline";
import { buildReport, citationRows, explainStoredBundle, revalidateStoredExplanation, selectExplanation } from "@/evidence/llm/persist";
import { MOCK_SCENARIOS, MockProvider, type MockScenario } from "@/evidence/llm/mock";
import { PROMPT_HASH, PROMPT_VERSION } from "@/evidence/llm/prompt";
import type { ValidatedExplanation } from "@/evidence/llm/generate";
import { normaliseForAnchor } from "@/evidence/llm/normalize";
import { makeFacts } from "@/evidence/retrieval/testkit";
import { RETRIEVAL_CONFIG_DEV, RETRIEVAL_CONFIG_V1 } from "@/evidence/retrieval/config";
import { pgliteEvidenceDb } from "./evidenceDb";
import { DBR, freshEvidenceDb, insertSignal, type SignalSeed } from "./evidenceFixture";
import { asUser, IDS, run, type Db } from "./harness";

const ROOT = process.cwd();
const built = buildCorpus(join(ROOT, "data", "evidence", "corpus"), join(ROOT, "data", "evidence", "allowlist.json"), "jansanket-dev-corpus");
const SIGNAL = makeFacts().signal_id;
const NOW = () => "2026-01-01T00:00:00.000Z";
const RETRIEVED_AT = "2026-01-01T00:00:00.000Z";
const KHORDHA_OFFICER = "00000000-0000-0000-0000-000000000201";
const GANJAM_OFFICER = "00000000-0000-0000-0000-000000000202";
const code = (r: { error?: { code?: string } }) => r.error?.code;
const count = async (db: Db, sql: string): Promise<number> => Number((await db.query<{ n: string }>(`select count(*)::text n from ${sql}`)).rows[0].n);

let seq = 0;
const newSignal = async (db: Db, name: string, extra: Partial<SignalSeed> = {}): Promise<string> => {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  await insertSignal(db, { id, start: `2025-08-31T18:30:${String(seq).padStart(2, "0")}Z`, ...extra });
  void name;
  return id;
};

let A: Db;
let edb: EvidenceDb;
let bundleId: string;
let bundleHash: string;

/** A new signal with its own stored M4.4 bundle (so scenarios do not share idempotency keys). */
async function storedBundle(name: string): Promise<{ signalId: string; bundleId: string }> {
  const signalId = await newSignal(A, name);
  const b = (await buildBundleForSignal(edb, signalId, RETRIEVAL_CONFIG_DEV, undefined, { retrievedAt: RETRIEVED_AT }))!;
  const p = await persistBundle(edb, b, { now: NOW });
  return { signalId, bundleId: p.bundleId };
}

const rowsOf = async (id: string) => (await A.query<Record<string, unknown>>(`select * from public.generated_explanations where bundle_id = '${id}' order by created_at, id`)).rows;
const shape = async (id: string) => ({
  explanations: await count(A, `public.generated_explanations where bundle_id = '${id}'`),
  raw: await count(A, `public.generated_explanation_raw r join public.generated_explanations g on g.id = r.explanation_id where g.bundle_id = '${id}'`),
  citations: await count(A, `public.explanation_citations c join public.generated_explanations g on g.id = c.explanation_id where g.bundle_id = '${id}' and g.provider <> 'extractive'`), // model explanations only: the M4.4 fallback has its own citation rows
});

beforeAll(async () => {
  A = await freshEvidenceDb();
  edb = pgliteEvidenceDb(A);
  const r = await ingestCorpus(edb, built.prepared, { corpusName: "jansanket-dev-corpus", now: NOW, activate: true });
  if (!r.ok) throw new Error(r.errors.join("; "));
  await A.exec(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${KHORDHA_OFFICER}', 'khordha@test.invalid', '{"display_name":"Khordha officer"}'),
      ('${GANJAM_OFFICER}', 'ganjam@test.invalid', '{"display_name":"Ganjam officer"}');
    insert into public.user_roles (user_id, role, region_id) values
      ('${KHORDHA_OFFICER}', 'officer', '${DBR.khordha}'),
      ('${GANJAM_OFFICER}', 'officer', '${DBR.ganjam}');`);
  await insertSignal(A, { id: SIGNAL });
  const b = (await buildBundleForSignal(edb, SIGNAL, RETRIEVAL_CONFIG_DEV, undefined, { retrievedAt: RETRIEVED_AT }))!;
  bundleHash = b.bundle_hash;
  bundleId = (await persistBundle(edb, b, { now: NOW })).bundleId;
}, 300_000);

describe("a validated explanation is stored in the existing tables", () => {
  let provider: MockProvider;
  let outcome: Awaited<ReturnType<typeof explainStoredBundle>>;
  beforeAll(async () => {
    provider = new MockProvider();
    outcome = await explainStoredBundle(edb, bundleId, provider, { generate: { now: () => 0 } });
  });

  it("creates one validated row alongside the M4.4 fallback, with provider, model, versions, parameters and hashes", async () => {
    expect(outcome).toMatchObject({ cached: false, status: "validated", providerCalls: 1 });
    const rows = await rowsOf(bundleId);
    expect(rows.map((r) => [r.provider, r.status]).sort()).toEqual([["extractive", "fallback_extractive"], ["mock", "validated"]]);
    const v = rows.find((r) => r.provider === "mock")!;
    expect(v).toMatchObject({ model: "mock-1", model_version: "mock-model-1", prompt_version: PROMPT_VERSION, language: "en", citation_status: "verified" });
    expect(v.input_hash).toBe(outcome.generation!.input_hash);
    expect(v.params).toEqual({ temperature: 0, max_output_tokens: 2048, output_schema: "grounded-output/1", max_attempts: 2 });
    const out = v.output as ValidatedExplanation;
    expect(out).toMatchObject({ schema: "grounded-explanation/1", status: "validated", bundle_hash: bundleHash, prompt_hash: PROMPT_HASH, provider: "mock", model: "mock-1" });
    expect(out.text.startsWith("Evidence relevant to this emerging signal suggests…\n")).toBe(true);
  });

  it("records a validation report with the decision, attempts, metrics and hashes, and no model text", async () => {
    const v = (await rowsOf(bundleId)).find((r) => r.provider === "mock")!;
    const report = v.validation_report as Record<string, unknown> & { attempts: Array<Record<string, unknown>>; metrics: Record<string, unknown> };
    expect(report).toMatchObject({ schema: "m4.5-validation/1", decision: "validated", deterministic_validators: true, bundle_hash: bundleHash, prompt_version: PROMPT_VERSION, prompt_hash: PROMPT_HASH, input_hash: v.input_hash, output_hash: outcome.generation!.output_hash });
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]).toMatchObject({ outcome: "accepted", parse: "ok" });
    expect(report.metrics).toMatchObject({ claim_count: 4, validated_claim_count: 4, rejected_claim_count: 0, fallback_used: false });
    const raw = outcome.generation!.attempts[0].raw!;
    expect(JSON.stringify(report)).not.toContain(raw.slice(0, 60));
    expect(JSON.stringify(report)).not.toContain((v.output as ValidatedExplanation).points[0].text);
    expect((report.render_checks as Array<{ ok: boolean }>).every((c) => c.ok)).toBe(true);
  });

  it("stores the raw model answer separately, once per explanation", async () => {
    const v = (await rowsOf(bundleId)).find((r) => r.provider === "mock")!;
    const raw = (await A.query<{ raw: string }>(`select raw from public.generated_explanation_raw where explanation_id = '${v.id}'`)).rows;
    expect(raw).toHaveLength(1);
    const parsed = JSON.parse(raw[0].raw) as { attempts: Array<{ attempt: number; raw: string; truncated: boolean }> };
    expect(parsed.attempts).toEqual([{ attempt: 1, raw: outcome.generation!.attempts[0].raw, truncated: false }]);
    expect(JSON.stringify(v)).not.toContain(parsed.attempts[0].raw.slice(0, 80));
  });

  it("stores one citation row per (statement, cited passage), bound to the right bundle item, with the verbatim anchor", async () => {
    const v = (await rowsOf(bundleId)).find((r) => r.provider === "mock")!;
    const out = v.output as ValidatedExplanation;
    const rows = (await A.query<{ claim_index: number; citation_id: string; quote: string; anchor_verified: boolean; text: string; support_check: Record<string, unknown> }>(
      `select c.claim_index, i.citation_id, c.quote, c.anchor_verified, ch.text, c.support_check
         from public.explanation_citations c join public.evidence_bundle_items i on i.id = c.bundle_item_id join public.evidence_chunks ch on ch.id = i.chunk_id
        where c.explanation_id = '${v.id}' order by c.claim_index, i.citation_id`,
    )).rows;
    const expected = citationRows(out);
    expect(rows.map((r) => [Number(r.claim_index), r.citation_id])).toEqual(expected.map((e) => [e.claim_index, e.citation_id]).sort((a, b) => (a[0] as number) - (b[0] as number) || String(a[1]).localeCompare(String(b[1]), "en", { numeric: true })).sort((a, b) => (a[0] as number) - (b[0] as number) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
    for (const r of rows) {
      expect(r.anchor_verified).toBe(true);
      expect(normaliseForAnchor(r.text)).toContain(normaliseForAnchor(r.quote)); // the quote really is inside the stored chunk
      expect(r.support_check).toMatchObject({ method: "normalised_verbatim_substring" });
    }
    expect(rows.length).toBe(out.points.reduce((n, p) => n + p.citations.length, 0));
  });

  it("leaves the M4.4 bundle exactly as it was", async () => {
    const b = (await buildBundleForSignal(edb, SIGNAL, RETRIEVAL_CONFIG_DEV, undefined, { retrievedAt: "2030-01-01T00:00:00.000Z" }))!;
    expect(b.bundle_hash).toBe(bundleHash);
    expect(await count(A, `public.evidence_bundles where signal_candidate_id = '${SIGNAL}'`)).toBe(1);
    expect(await count(A, `public.generated_explanations where bundle_id = '${bundleId}' and provider = 'extractive'`)).toBe(1);
  });

  it("is what an officer is shown, in preference to the fallback", async () => {
    const shown = await selectExplanation(edb, bundleId);
    expect(shown).toMatchObject({ kind: "validated", provider: "mock", model: "mock-1" });
  });
});

describe("the cache: identical inputs are never generated twice", () => {
  it("serves the stored result with no provider call and writes nothing", async () => {
    const before = await shape(bundleId);
    const provider = new MockProvider();
    const attempted: string[] = [];
    const counting: EvidenceDb = { ...edb, insert: async (t, rows) => { attempted.push(t); return edb.insert(t, rows); } };
    const again = await explainStoredBundle(counting, bundleId, provider);
    expect(again).toMatchObject({ cached: true, status: "validated", providerCalls: 0, generation: null });
    expect(provider.calls).toHaveLength(0);
    expect(attempted).toEqual([]); // not a single insert is even attempted on a cache hit
    expect(await shape(bundleId)).toEqual(before);
  });

  it("a different model (or provider) is a different key and is generated and stored separately", async () => {
    const before = (await shape(bundleId)).explanations;
    const other = new MockProvider({ model: "mock-2" });
    const r = await explainStoredBundle(edb, bundleId, other);
    expect(r).toMatchObject({ cached: false, status: "validated" });
    expect(other.calls).toHaveLength(1);
    expect((await shape(bundleId)).explanations).toBe(before + 1);
  });

  it("caches a rejection too, so a bundle is not asked again with the same inputs", async () => {
    const s = await storedBundle("cache-rejected");
    const first = await explainStoredBundle(edb, s.bundleId, new MockProvider({ scenario: "diagnosis" }));
    expect(first).toMatchObject({ cached: false, status: "rejected", providerCalls: 2 });
    const second = new MockProvider({ scenario: "valid" });
    const again = await explainStoredBundle(edb, s.bundleId, second);
    expect(again).toMatchObject({ cached: true, status: "rejected", providerCalls: 0 });
    expect(second.calls).toHaveLength(0);
  });

  it("explains a signal's latest stored bundle through the signal id", async () => {
    const r = await explainSignal(edb, SIGNAL, new MockProvider());
    expect(r).toMatchObject({ bundleId, cached: true });
    expect(await explainSignal(edb, "00000000-0000-4000-8000-00000000ffff", new MockProvider())).toBeNull();
  });
});

describe("a rejected generation is recorded and the fallback stands", () => {
  let s: { signalId: string; bundleId: string };
  let outcome: Awaited<ReturnType<typeof explainStoredBundle>>;
  beforeAll(async () => {
    s = await storedBundle("rejected");
    outcome = await explainStoredBundle(edb, s.bundleId, new MockProvider({ scenario: "unsupported_number" }));
  });

  it("stores a rejected row with no output, a report of why, and the raw answers (admin-only table)", async () => {
    expect(outcome).toMatchObject({ status: "rejected", cached: false, providerCalls: 2 });
    const rejected = (await rowsOf(s.bundleId)).find((r) => r.status === "rejected")!;
    expect(rejected).toMatchObject({ provider: "mock", model: "mock-1", output: null });
    const report = rejected.validation_report as { decision: string; attempts: Array<{ outcome: string; categories: Record<string, number> }>; metrics: Record<string, unknown> };
    expect(report.decision).toBe("rejected");
    expect(report.attempts.map((a) => a.outcome)).toEqual(["rejected", "rejected"]);
    expect(report.attempts[0].categories).toMatchObject({ unsupported_number: 1 });
    expect(report.metrics).toMatchObject({ validated_claim_count: 0, rejected_claim_count: 1, unsupported_claim_count: 1, fallback_used: true, attempts: 2 });
    const raw = JSON.parse((await A.query<{ raw: string }>(`select raw from public.generated_explanation_raw where explanation_id = '${rejected.id}'`)).rows[0].raw);
    expect(raw.attempts).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain("87 percent");
  });

  it("creates no citation rows, and the officer is shown the M4.4 extractive fallback", async () => {
    expect((await shape(s.bundleId)).citations).toBe(0);
    expect(await selectExplanation(edb, s.bundleId)).toMatchObject({ kind: "fallback_extractive", provider: "extractive" });
  });

  it("every violating scenario is stored as rejected (or not stored at all for an outage), never as validated", async () => {
    const sb = await storedBundle("scenarios");
    const outageOnly = new Set<MockScenario>(["timeout", "unavailable", "blocked"]);
    const acceptable = new Set<MockScenario>(["valid", "conflicting_evidence", "missing_evidence", "mixed_one_bad", "prompt_injection"]);
    for (const scenario of MOCK_SCENARIOS) {
      const r = await explainStoredBundle(edb, sb.bundleId, new MockProvider({ scenario, model: `mock-${scenario}` }));
      if (acceptable.has(scenario)) expect(r.status, scenario).toBe("validated");
      else if (outageOnly.has(scenario)) expect([r.status, r.explanationId], scenario).toEqual(["unavailable", null]);
      else expect([r.status, r.explanationId !== null], scenario).toEqual(["rejected", true]);
    }
    const rows = await rowsOf(sb.bundleId);
    expect(rows.filter((r) => r.status === "validated" && !acceptable.has(String(r.model).replace("mock-", "") as MockScenario) && r.provider === "mock")).toEqual([]);
    for (const r of rows.filter((x) => x.status === "rejected")) expect(r.output).toBeNull();
  }, 120_000);
});

describe("an outage, no provider, or nothing to summarise stores nothing", () => {
  it("does not store an outage, so it never occupies the idempotency key", async () => {
    const s = await storedBundle("outage");
    const out = await explainStoredBundle(edb, s.bundleId, new MockProvider({ scenario: "timeout" }));
    expect(out).toMatchObject({ status: "unavailable", explanationId: null, providerCalls: 2 });
    expect((await shape(s.bundleId)).explanations).toBe(1); // only the M4.4 fallback
    const later = await explainStoredBundle(edb, s.bundleId, new MockProvider());
    expect(later).toMatchObject({ status: "validated", cached: false });
  });

  it("no provider: no call, nothing stored, the fallback is what exists", async () => {
    const s = await storedBundle("no-provider");
    expect(await explainStoredBundle(edb, s.bundleId, null)).toMatchObject({ status: "unavailable", explanationId: null, providerCalls: 0 });
    expect(await selectExplanation(edb, s.bundleId)).toMatchObject({ kind: "fallback_extractive" });
  });

  it("an empty bundle is not sent to a model", async () => {
    const signalId = await newSignal(A, "empty");
    const empty = (await buildBundleForSignal(edb, signalId, RETRIEVAL_CONFIG_V1, undefined, { retrievedAt: RETRIEVED_AT }))!;
    expect(empty.citations).toEqual([]);
    const p = await persistBundle(edb, empty, { now: NOW });
    const provider = new MockProvider();
    expect(await explainStoredBundle(edb, p.bundleId, provider)).toMatchObject({ status: "skipped", explanationId: null });
    expect(provider.calls).toHaveLength(0);
    expect((await selectExplanation(edb, p.bundleId))!.kind).toBe("fallback_extractive");
  });
});

describe("a bundle that does not verify is never explained", () => {
  const withoutTriggers = async (table: string, fn: () => Promise<void>) => {
    await A.exec(`alter table public.${table} disable trigger user`);
    try {
      await fn();
    } finally {
      await A.exec(`alter table public.${table} enable trigger user`);
    }
  };
  it("refuses a bundle whose stored JSON no longer matches its hash, and writes nothing", async () => {
    const s = await storedBundle("tampered");
    await withoutTriggers("evidence_bundles", async () => {
      await A.query(`update public.evidence_bundles set bundle = jsonb_set(bundle, '{facets,0,items,0,excerpt}', '"tampered"') where id = $1`, [s.bundleId]);
    });
    const provider = new MockProvider();
    await expect(explainStoredBundle(edb, s.bundleId, provider)).rejects.toThrow(/failed verification/);
    expect(provider.calls).toHaveLength(0);
    expect((await shape(s.bundleId)).explanations).toBe(1);
  });

  it("refuses an unknown bundle id", async () => {
    await expect(explainStoredBundle(edb, "00000000-0000-0000-0000-00000000dead", new MockProvider())).rejects.toThrow(/not found/);
  });
});

describe("append-only", () => {
  it("allows no edit to a stored explanation except the stale flag, and none to its citations", async () => {
    const v = (await rowsOf(bundleId)).find((r) => r.provider === "mock" && r.model === "mock-1")!;
    for (const sql of [
      `update public.generated_explanations set output = '{}'::jsonb where id = '${v.id}'`,
      `update public.generated_explanations set validation_report = '{}'::jsonb where id = '${v.id}'`,
      `update public.generated_explanations set status = 'rejected' where id = '${v.id}'`,
      `update public.generated_explanations set model = 'other' where id = '${v.id}'`,
      `update public.explanation_citations set quote = 'edited' where explanation_id = '${v.id}'`,
      `update public.explanation_citations set anchor_verified = false where explanation_id = '${v.id}'`,
    ]) expect(code(await run(A, sql)), sql).toBe("JS008");
    expect((await run(A, `update public.generated_explanations set citation_status = 'stale' where id = '${v.id}'`)).error).toBeUndefined();
    expect((await run(A, `update public.generated_explanations set citation_status = 'verified' where id = '${v.id}'`)).error).toBeUndefined();
  });
});

describe("recovery from an interrupted write", () => {
  const failing = (inner: EvidenceDb, table: string, nth: number): EvidenceDb => {
    let n = 0;
    return {
      ...inner,
      insert: async (t, rows) => {
        if (t === table && ++n === nth) throw new Error(`simulated outage inserting into ${table}`);
        return inner.insert(t, rows);
      },
    };
  };

  it("completes missing citation rows on the next call, without calling the provider again", async () => {
    const s = await storedBundle("recover-citations");
    await expect(explainStoredBundle(failing(edb, "explanation_citations", 2), s.bundleId, new MockProvider())).rejects.toThrow(/simulated outage/);
    const partial = await shape(s.bundleId);
    expect(partial.explanations).toBe(2);
    const full = await explainStoredBundle(edb, s.bundleId, new MockProvider());
    expect(full).toMatchObject({ cached: true, providerCalls: 0 });
    const done = await shape(s.bundleId);
    expect(done.citations).toBeGreaterThan(partial.citations);
    const v = (await rowsOf(s.bundleId)).find((r) => r.provider === "mock")!;
    expect(done.citations).toBe(citationRows(v.output as ValidatedExplanation).length);
    expect(await revalidateStoredExplanation(edb, v.id as string)).toMatchObject({ ok: true });
  });

  it("two simultaneous calls converge on one stored row", async () => {
    const s = await storedBundle("concurrent");
    const results = await Promise.allSettled([explainStoredBundle(edb, s.bundleId, new MockProvider()), explainStoredBundle(edb, s.bundleId, new MockProvider())]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]); // the loser of the race converges on the winner's row
    await explainStoredBundle(edb, s.bundleId, new MockProvider());
    expect((await shape(s.bundleId)).explanations).toBe(2); // fallback + exactly one model row
    const v = (await rowsOf(s.bundleId)).find((r) => r.provider === "mock")!;
    expect((await shape(s.bundleId)).citations).toBe(citationRows(v.output as ValidatedExplanation).length);
  });
});

describe("a stored explanation can be re-validated against the database as it is now", () => {
  const withoutTriggers = async (table: string, fn: () => Promise<void>) => {
    await A.exec(`alter table public.${table} disable trigger user`);
    try {
      await fn();
    } finally {
      await A.exec(`alter table public.${table} enable trigger user`);
    }
  };
  let s: { signalId: string; bundleId: string };
  let id: string;
  beforeAll(async () => {
    s = await storedBundle("revalidate");
    id = (await explainStoredBundle(edb, s.bundleId, new MockProvider()))!.explanationId!;
  });

  it("passes when nothing changed", async () => {
    expect(await revalidateStoredExplanation(edb, id)).toEqual({ ok: true, problems: [], stale: [] });
  });

  it("detects a changed output, a missing citation row and an edited quote", async () => {
    const v = (await rowsOf(s.bundleId)).find((r) => r.id === id)!;
    const out = v.output as ValidatedExplanation;
    await withoutTriggers("generated_explanations", async () => {
      await A.query(`update public.generated_explanations set output = jsonb_set(output, '{points,0,text}', to_jsonb($1::text)) where id = $2`, ["The outbreak is confirmed in this district.", id]);
    });
    const tampered = await revalidateStoredExplanation(edb, id);
    expect(tampered.ok).toBe(false);
    expect(tampered.problems.join("|")).toMatch(/output_hash/);
    expect(tampered.problems.join("|")).toMatch(/no longer pass the validators/);
    await withoutTriggers("generated_explanations", async () => {
      await A.query(`update public.generated_explanations set output = $1::jsonb where id = $2`, [JSON.stringify(out), id]);
    });
    expect((await revalidateStoredExplanation(edb, id)).ok).toBe(true);

    await withoutTriggers("explanation_citations", async () => {
      await A.query(`update public.explanation_citations set quote = 'edited quote text here' where explanation_id = $1 and claim_index = 0`, [id]);
    });
    expect((await revalidateStoredExplanation(edb, id)).problems.join("|")).toMatch(/stored quote differs/);
    await withoutTriggers("explanation_citations", async () => {
      await A.query(`delete from public.explanation_citations where explanation_id = $1 and claim_index = 0`, [id]);
    });
    expect((await revalidateStoredExplanation(edb, id)).problems.join("|")).toMatch(/no citation row|expected \d+ citation rows/);
  });

  it("reports a rejected or unknown explanation as not validated", async () => {
    const rej = await storedBundle("revalidate-rejected");
    await explainStoredBundle(edb, rej.bundleId, new MockProvider({ scenario: "diagnosis" }));
    const rejectedId = (await rowsOf(rej.bundleId)).find((r) => r.status === "rejected")!.id as string;
    expect((await revalidateStoredExplanation(edb, rejectedId)).problems.join()).toMatch(/not validated/);
    expect((await revalidateStoredExplanation(edb, "00000000-0000-0000-0000-00000000dead")).problems).toEqual(["explanation not found"]);
  });

  it("reports (without failing) that source details changed since the explanation was written", async () => {
    const t = await storedBundle("stale-metadata");
    const eid = (await explainStoredBundle(edb, t.bundleId, new MockProvider()))!.explanationId!;
    expect((await revalidateStoredExplanation(edb, eid)).stale).toEqual([]);
    const v = (await rowsOf(t.bundleId)).find((r) => r.id === eid)!;
    const cited = (v.output as ValidatedExplanation).points[0].citations[0];
    const item = (await A.query<{ evidence_item_id: string }>(`select v.evidence_item_id from public.evidence_bundle_items i join public.evidence_versions v on v.id = i.evidence_version_id where i.bundle_id = '${t.bundleId}' and i.citation_id = '${cited}'`)).rows[0];
    await A.query(`update public.evidence_items set title = title || ' (retitled)' where id = $1`, [item.evidence_item_id]);
    const r = await revalidateStoredExplanation(edb, eid);
    expect(r.ok).toBe(true);
    expect(r.stale.join()).toMatch(/source details/);
  });
});

describe("row-level security", () => {
  const seen = (uid: string, sql: string) => asUser(A, uid, () => run<{ n: string }>(A, sql));
  let validatedId: string;
  beforeAll(async () => {
    validatedId = (await rowsOf(bundleId)).find((r) => r.provider === "mock" && r.model === "mock-1")!.id as string;
  });
  const counts = async (uid: string) => ({
    explanations: Number((await seen(uid, `select count(*)::text n from public.generated_explanations where bundle_id = '${bundleId}'`)).rows[0].n),
    citations: Number((await seen(uid, `select count(*)::text n from public.explanation_citations where explanation_id = '${validatedId}'`)).rows[0].n),
    raw: Number((await seen(uid, `select count(*)::text n from public.generated_explanation_raw`)).rows[0].n),
  });

  it("an administrator sees explanations, citations and the raw model output", async () => {
    const c = await counts(IDS.admin);
    expect(c.explanations).toBeGreaterThanOrEqual(2);
    expect(c.citations).toBeGreaterThan(0);
    expect(c.raw).toBeGreaterThan(0);
  });

  it("the officer whose district contains the signal sees explanations and citations, but NEVER the raw model output", async () => {
    const c = await counts(KHORDHA_OFFICER);
    const admin = await counts(IDS.admin);
    expect(c.explanations).toBe(admin.explanations);
    expect(c.citations).toBe(admin.citations);
    expect(c.raw).toBe(0);
  });

  it("every other reader sees none of it", async () => {
    for (const uid of [GANJAM_OFFICER, IDS.officer1, IDS.officer2, IDS.officerNoScope, IDS.clinician, IDS.citizenA, IDS.citizenB]) expect(await counts(uid), uid).toEqual({ explanations: 0, citations: 0, raw: 0 });
  });

  it("no client - officer, administrator or citizen - can write an explanation, a citation or raw output", async () => {
    const stmts = [
      `insert into public.generated_explanations (bundle_id, provider, model, prompt_version, input_hash, status) values ('${bundleId}', 'x', 'y', 'z', '${"9".repeat(64)}', 'rejected')`,
      `insert into public.generated_explanation_raw (explanation_id, raw) values ('${validatedId}', 'forged')`,
      `insert into public.explanation_citations (explanation_id, claim_index, bundle_item_id) select '${validatedId}', 99, id from public.evidence_bundle_items limit 1`,
      `update public.generated_explanations set citation_status = 'stale'`,
      `delete from public.generated_explanations`,
      `delete from public.generated_explanation_raw`,
    ];
    for (const uid of [KHORDHA_OFFICER, IDS.admin, IDS.citizenA]) {
      for (const sql of stmts) {
        const r = await asUser(A, uid, () => run(A, sql));
        expect(r.error !== undefined || r.affected === 0, `${uid}: ${sql.slice(0, 70)}`).toBe(true);
      }
    }
    expect((await rowsOf(bundleId)).length).toBeGreaterThanOrEqual(2);
  });
});

describe("nothing personal is stored", () => {
  it("holds no report, observation or credential text in any generation table", async () => {
    const text = JSON.stringify([
      (await A.query("select * from public.generated_explanations")).rows,
      (await A.query("select * from public.generated_explanation_raw")).rows,
      (await A.query("select * from public.explanation_citations")).rows,
    ]);
    for (const leak of ["observed_value", "p_value", "patient", "phone", "latitude", "service_role", "SUPABASE", "GEMINI", "api_key", "Human verification required"]) expect(text, leak).not.toContain(leak);
  });

  it("buildReport carries no raw output", () => {
    const report = buildReport({ status: "rejected", attempts: [{ attempt: 1, raw: "SECRET RAW TEXT", raw_sha256: "a", raw_length: 15, request_sha256: "b", outcome: "rejected", provider_error: null, finish_reason: null, model_version: null, usage: null, parse: "ok", schema_issues: [], rejection: null, categories: {}, counts: null, dropped: [], withheld: [], latency_ms: 1 }] } as never, "h");
    expect(JSON.stringify(report)).not.toContain("SECRET RAW TEXT");
  });
});

