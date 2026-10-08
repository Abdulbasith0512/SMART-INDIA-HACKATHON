// @vitest-environment node
// M4.4 packages evidence selected by M4.2/M4.3 for one signal. It touches only officer-visible aggregate signal facts,
// approved evidence metadata and bounded stored excerpts: no raw or de-identified data, no personal identifiers, no
// provider or network call, no secret, no browser path. Structural and runtime proof.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonValue, type EvidenceDb, type Row } from "../ingest/ingest";
import { RETRIEVAL_CONFIG_DEV } from "../retrieval/config";
import { makeFacts, viewFromPrepared } from "../retrieval/testkit";
import { buildBundle } from "./build";
import { bundleHashOf } from "./canonical";
import { renderExtractive } from "./fallback";
import { loadCitationMetadata, persistBundle } from "./persist";
import { buildBundleForSignal } from "./pipeline";
import { devResolver, IDENTITY, referenceBundle } from "./testkit";

const ROOT = process.cwd();
const DIR = join(ROOT, "src", "evidence", "bundle");
const sources = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !/\.test\.ts$/.test(f) && f !== "testkit.ts");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const code = (f: string) => strip(readFileSync(join(DIR, f), "utf8"));
const importsOf = (src: string): string[] => [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
const runtimeImports = (src: string): string[] => [...src.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)].filter((m) => !m[1]).map((m) => m[2]);

/** Every file reachable through runtime (non-type) imports from the entry files. */
function runtimeGraph(entries: string[]): string[] {
  const seen = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const i of runtimeImports(strip(readFileSync(file, "utf8")))) {
      if (!i.startsWith(".")) continue;
      const target = ["", ".ts"].map((ext) => resolve(dirname(file), i + ext)).find((p) => existsSync(p) && p.endsWith(".ts"));
      if (target) walk(target);
    }
  };
  entries.forEach((e) => walk(join(DIR, e)));
  return [...seen].map((f) => relative(ROOT, f).split("\\").join("/")).sort();
}

describe("bundle source: no sensitive data, no network, no secrets, no model", () => {
  it("has source files to check", () => expect(sources.length).toBeGreaterThanOrEqual(8));

  it("never references report, observation, aggregate, role, profile or audit data", () => {
    const banned = /health_reports|deidentified_observations|report_aggregates|detection_daily_features|detector_findings|detector_runs|user_roles|profiles|audit_log|raw_report|auth\.users/;
    for (const f of sources) expect(code(f), f).not.toMatch(banned);
  });

  it("makes no network, file-system, process or secret access", () => {
    const banned = /\bfetch\s*\(|XMLHttpRequest|WebSocket|node:(https?|net|dns|tls|dgram|child_process|fs|os)|\bprocess\.env\b|\bimport\.meta\.env\b|\brequire\s*\(|\beval\s*\(|new Function/;
    for (const f of sources) expect(code(f), f).not.toMatch(banned);
  });

  it("names no model provider and uses no embedding, vector or LLM machinery", () => {
    const banned = /openai|anthropic|gemini|generativelanguage|embedding|pgvector|\bvector\b|cosine|\bllm\b/i;
    for (const f of sources) expect(code(f), f).not.toMatch(banned);
  });

  it("imports nothing from the detector, an LLM, the fetcher, the database client or the UI", () => {
    for (const f of sources) for (const i of importsOf(code(f))) expect(i, `${f} imports ${i}`).not.toMatch(/detection|evaluation|llm|generation|net\/|supabase|react|components|pages|features|hooks|scenarios|testkit/);
  });

  it("has a pure RUNTIME dependency graph for building, hashing, reasoning and rendering (no database, no ingest)", () => {
    const rel = runtimeGraph(["build.ts", "canonical.ts", "reasons.ts", "fallback.ts"]);
    for (const f of rel) expect(f, f).toMatch(/^src\/evidence\/(bundle|ranking|retrieval)\/[a-zA-Z0-9]+\.ts$|^src\/evidence\/(hash|vocab)\.ts$/);
    expect(rel.some((f) => /persist|pipeline|ingest|net\/|llm|generation|detection|supabase|testkit|scenarios/.test(f))).toBe(false);
  });

  it("only persist.ts writes, and only to the bundle tables (never to evidence, signals, reports or users)", () => {
    for (const f of sources.filter((x) => x !== "persist.ts")) expect(code(f), f).not.toMatch(/\.(insert|update|delete|upsert|rpc)\(/);
    const allowed = new Set(["retrieval_runs", "evidence_bundles", "evidence_bundle_items", "generated_explanations", "explanation_citations", "signal_evidence"]);
    const written = [...code("persist.ts").matchAll(/\.(?:insert|update|delete)\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(written.length).toBeGreaterThanOrEqual(6);
    for (const t of written) expect(allowed.has(t), t).toBe(true);
    expect(code("persist.ts")).not.toMatch(/\.(upsert|rpc)\(/);
  });

  it("selects only named columns, never `select *`", () => {
    // every `.select(` call passes an explicit list of column names as its third argument
    for (const f of sources) {
      const src = code(f);
      const calls = src.match(/\.select\(/g) ?? [];
      const named = src.match(/\.select\(\s*"[a-z_]+"[^;\n]*?,\s*\[\s*"[a-z_]+"(?:\s*,\s*"[a-z_]+")*\s*\]/g) ?? [];
      expect(named.length, f).toBe(calls.length);
    }
    expect((code("persist.ts").match(/\.select\(/g) ?? []).length).toBeGreaterThanOrEqual(10);
  });

  it("keeps the bundle out of the browser build", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const ui = ["components", "pages", "features", "hooks", "lib"].flatMap((d) => walk(join(ROOT, "src", d))).filter((f) => /\.tsx?$/.test(f));
    ui.push(join(ROOT, "src", "App.tsx"), join(ROOT, "src", "main.tsx"));
    expect(ui.length).toBeGreaterThan(20);
    for (const f of ui) expect(importsOf(readFileSync(f, "utf8")).filter((i) => /evidence/.test(i)), relative(ROOT, f)).toEqual([]);
  });
});

describe("bundle at runtime: tripwires", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("builds and renders with no network call and no secret", () => {
    const calls: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((...a) => {
      calls.push(a);
      throw new Error("network call attempted");
    });
    for (const k of ["SUPABASE_SERVICE_ROLE_KEY", "GEMINI_API_KEY", "LLM_PROVIDER", "VITE_SUPABASE_ANON_KEY"]) vi.stubEnv(k, "");
    const b = referenceBundle();
    const r = renderExtractive(b, devResolver());
    expect(b.facets.reduce((n, f) => n + f.items.length, 0)).toBeGreaterThan(0);
    expect(r.fallback.points.length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });

  it("refuses signal facts that carry anything beyond the allowed projection", () => {
    const b = referenceBundle();
    expect(b.signal.candidate_id).toBe(makeFacts().signal_id);
    for (const extra of [{ observed: 17 }, { patient_name: "A. Person" }, { phone: "+91 90000 00000" }, { latitude: 20.27 }, { reports: [{ id: "r1" }] }, { explanation: "free text" }]) {
      expect(() => referenceBundle({ facts: { ...makeFacts(), ...extra } as never }), JSON.stringify(extra)).toThrow();
    }
  });

  it("the bundle holds no counts, statistics, personal fields or free text from the signal", () => {
    const b = referenceBundle();
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); }
    };
    walk(b);
    for (const k of keys) expect(k, k).not.toMatch(/^(observed|observed_value|expected|expected_value|p_value|case_count|patient|patient_name|phone|email|address|latitude|longitude|age|sex|gender|reports?|explanation|involved_blocks|persistence|blocks_in_district)$/);
    const text = JSON.stringify(b);
    for (const leak of ["p_value", "observed_value", "patient", "phone", "involvedBlocks", "blocksInDistrict", "involved_blocks"]) expect(text, leak).not.toContain(leak);
    expect(Object.keys(b.signal).sort()).toEqual(["candidate_id", "detector_version", "episode_key", "region", "syndrome", "window"]);
  });

  it("does not copy source titles, publishers, URLs or dates into selected items or citations (they are rendered from the database by id)", () => {
    const b = referenceBundle();
    const { excluded, ...cited } = b;
    const text = JSON.stringify(cited);
    expect(text).not.toMatch(/"(title|publisher|reference_url|citation|licence|publication_date|url)"/);
    expect(text).not.toMatch(/https?:\/\//);
    expect(JSON.stringify(excluded)).not.toMatch(/https?:\/\//);
    expect(excluded.length).toBeGreaterThan(0);
  });

  it("the only descriptive metadata in the bundle is the publisher inside M4.3's exclusion log, which explains publisher-diversity exclusions", () => {
    const b = referenceBundle();
    const found = new Set<string>();
    const walk = (v: unknown, path: string): void => {
      if (Array.isArray(v)) v.forEach((x) => walk(x, `${path}[]`));
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (/^(title|publisher|reference_url|citation|licence|publication_date|url)$/.test(k)) found.add(`${path}.${k}`);
          walk(x, `${path}.${k}`);
        }
      }
    };
    walk(b, "$");
    expect([...found].sort()).toEqual(["$.excluded[].candidate.publisher", "$.excluded[].detail.retained.publisher"]);
  });

  it("only the fallback renders metadata, and only what the resolver returns", () => {
    const b = referenceBundle();
    const seen: string[] = [];
    renderExtractive(b, (id) => {
      seen.push(id);
      return devResolver()(id);
    });
    const cited = new Set(b.citations.map((c) => c.evidence_version_id));
    expect(seen.length).toBeGreaterThan(0);
    for (const id of seen) expect(cited.has(id)).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ database path
/** A small in-memory database that records every read and write, for column and table discipline. */
function recordingDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const reads: Array<{ table: string; columns: readonly string[] | undefined }> = [];
  const writes: Array<{ op: string; table: string; columns: string[] }> = [];
  let n = 0;
  const unwrap = (v: unknown) => (v instanceof JsonValue ? v.value : v);
  const matches = (r: Row, match: Row) => Object.entries(match ?? {}).every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v));
  const db: EvidenceDb = {
    async select(table, match, columns) {
      reads.push({ table, columns });
      return (tables[table] ?? []).filter((r) => matches(r, match)).map((r) => ({ ...r }));
    },
    async insert(table, rows) {
      return rows.map((row) => {
        writes.push({ op: "insert", table, columns: Object.keys(row) });
        n += 1;
        const stored: Row = { id: `${table}-${n}`, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(), ...Object.fromEntries(Object.entries(row).map(([k, v]) => [k, unwrap(v)])) };
        (tables[table] ??= []).push(stored);
        return { ...stored };
      });
    },
    async update(table, match, patch) {
      writes.push({ op: "update", table, columns: Object.keys(patch) });
      const hit = (tables[table] ?? []).filter((r) => matches(r, match));
      for (const r of hit) Object.assign(r, Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, unwrap(v)])));
      return hit.length;
    },
    async delete(table, match) {
      writes.push({ op: "delete", table, columns: Object.keys(match) });
      const keep = (tables[table] ?? []).filter((r) => !matches(r, match));
      const removed = (tables[table] ?? []).length - keep.length;
      tables[table] = keep;
      return removed;
    },
  };
  return { db, reads, writes, tables };
}

describe("bundle database path", () => {
  const view = viewFromPrepared();
  const hview = viewFromPrepared(undefined, null, ["superseded", "historical"]);
  const facts = makeFacts();
  const evidenceTables = (): Record<string, Row[]> => {
    const merged = new Map([...view.items, ...hview.items].map((i) => [i.id, i]));
    const all = [...view.items, ...hview.items];
    return {
      evidence_items: [...merged.values()].map((i) => ({
        id: i.id, canonical_id: i.canonicalId, title: i.title, publisher: i.publisher, source_class: i.sourceClass, evidence_kind: i.evidenceKind, trust_level: i.trustLevel,
        status: i.status, topics: i.topics, syndromes: i.syndromes, geo_scope: i.geoScope, geo_region_id: i.geoRegionId, language: i.language, publication_date: i.publicationDate,
        valid_from: i.validFrom, valid_until: i.validUntil, is_synthetic: i.isSynthetic, supersedes_id: i.supersedesId, question_key: i.questionKey, position: i.position,
        source_type: "guideline", reference_url: null, citation: null, licence: "synthetic-test-data",
      })),
      evidence_versions: [...merged.values()].map((i) => ({ id: i.version!.id, evidence_item_id: i.id, content_hash: i.version!.contentHash, fetch_status: i.version!.fetchStatus, is_current: true })),
      evidence_chunks: [...merged.values()].flatMap((i) => all.filter((x) => x.id === i.id).flatMap((x) => x.chunks).map((c) => ({ id: c.id, version_id: i.version!.id, ordinal: c.ordinal, kind: c.kind, text: c.text, chunk_hash: c.chunkHash, language: c.language }))),
      corpus_snapshots: [],
      signal_candidates: [{ id: facts.signal_id, episode_key: IDENTITY.episodeKey, syndrome: facts.syndrome, region_id: facts.region.id, time_window_start: "2025-08-31T18:30:00Z", time_window_end: "2025-09-07T18:30:00Z", score_components: { involvedBlocks: 1, blocksInDistrict: 4, persistence: 0.8 }, evidence: { involved_blocks: facts.involved_blocks, detector_version: IDENTITY.detectorVersion } }],
      regions: [facts.region, ...facts.ancestors].map((r, i, a) => ({ id: r.id, name: r.name, region_type: r.level, parent_region_id: a[i + 1]?.id ?? null })),
    };
  };
  const BANNED_COLUMNS = ["created_by", "verified_by", "notes", "review_note", "observed_value", "explanation", "score_components_raw"];

  it("building a bundle reads evidence tables, regions and the stored candidate (named columns) and writes nothing", async () => {
    const { db, reads, writes } = recordingDb(evidenceTables());
    const b = await buildBundleForSignal(db, facts.signal_id, RETRIEVAL_CONFIG_DEV);
    expect(b).not.toBeNull();
    expect(writes).toEqual([]);
    expect(new Set(reads.map((x) => x.table))).toEqual(new Set(["signal_candidates", "regions", "evidence_items", "evidence_versions", "evidence_chunks", "corpus_snapshots"]));
    for (const x of reads) {
      expect(x.columns, x.table).toBeDefined();
      for (const banned of [...BANNED_COLUMNS, "reference_url", "citation", "licence"]) expect(x.columns, `${x.table}.${banned}`).not.toContain(banned);
    }
    const sc = reads.filter((x) => x.table === "signal_candidates").map((x) => [...x.columns!].sort());
    expect(sc).toContainEqual(["evidence", "id", "region_id", "score_components", "syndrome", "time_window_end", "time_window_start"].sort());
    expect(sc).toContainEqual(["episode_key", "evidence", "id"]);
    expect(JSON.stringify(b)).not.toContain("blocksInDistrict");
  });

  it("an unknown signal yields no bundle", async () => {
    const { db } = recordingDb(evidenceTables());
    expect(await buildBundleForSignal(db, "00000000-0000-0000-0000-000000000000", RETRIEVAL_CONFIG_DEV)).toBeNull();
  });

  it("resolving source metadata reads only the display columns of the cited documents", async () => {
    const { db, reads, writes } = recordingDb(evidenceTables());
    const b = referenceBundle();
    const m = await loadCitationMetadata(db, b.citations.map((c) => c.evidence_version_id));
    expect(m.size).toBe(new Set(b.citations.map((c) => c.evidence_version_id)).size);
    expect(writes).toEqual([]);
    const cols = reads.find((x) => x.table === "evidence_items")!.columns!;
    expect([...cols].sort()).toEqual(["citation", "id", "is_synthetic", "licence", "publication_date", "publisher", "reference_url", "source_type", "title"]);
    for (const banned of BANNED_COLUMNS) expect(cols).not.toContain(banned);
  });

  it("persisting writes only the bundle tables and only their own columns, and never touches evidence, signals, regions or users", async () => {
    const { db, writes } = recordingDb({});
    const b = referenceBundle();
    const out = await persistBundle(db, b, { resolveMetadata: devResolver(), now: () => "2026-01-01T00:00:00.000Z" });
    expect(out.created).toBe(true);
    const COLS: Record<string, string[]> = {
      retrieval_runs: ["as_of_date", "corpus_snapshot_id", "error", "finished_at", "queries", "query_vocab_version", "retrieval_config_hash", "retrieval_version", "signal_candidate_id", "started_at", "stats", "status"],
      evidence_bundles: ["bundle", "bundle_hash", "conflict_count", "gap_count", "item_count", "retrieval_run_id", "schema_version", "signal_candidate_id"],
      evidence_bundle_items: ["bundle_id", "chunk_id", "citation_id", "evidence_version_id", "facet", "rank", "score_components", "why"],
      generated_explanations: ["bundle_id", "citation_status", "input_hash", "language", "model", "model_version", "output", "params", "prompt_version", "provider", "status", "validation_report"],
      explanation_citations: ["anchor_verified", "bundle_item_id", "claim_index", "explanation_id", "quote", "support_check"],
      signal_evidence: ["evidence_item_id", "relevance_note", "signal_candidate_id"],
    };
    expect(new Set(writes.map((w) => w.table))).toEqual(new Set(Object.keys(COLS)));
    for (const w of writes) for (const c of w.columns) expect(COLS[w.table], `${w.op} ${w.table}.${c}`).toContain(c);
    expect(writes.filter((w) => w.op === "delete")).toEqual([]); // first write to an empty mirror deletes nothing
  });

  it("everything persisted is the bundle, the fallback and ids: no counts, no personal fields, no secrets", async () => {
    const { db, tables } = recordingDb({});
    await persistBundle(db, referenceBundle(), { resolveMetadata: devResolver() });
    const text = JSON.stringify(tables);
    for (const leak of ["p_value", "observed_value", "patient", "phone", "involvedBlocks", "blocksInDistrict", "service_role", "SUPABASE", "GEMINI", "api_key"]) expect(text, leak).not.toContain(leak);
    expect(tables.generated_explanations).toHaveLength(1);
    expect(tables.generated_explanations[0]).toMatchObject({ status: "fallback_extractive", provider: "extractive", model: "deterministic-fallback" });
  });

  it("refuses to persist a bundle that was altered after it was hashed, or one with no corpus snapshot", async () => {
    const { db, writes } = recordingDb({});
    const tampered = referenceBundle();
    tampered.facets[0].items[0].excerpt += " (edited)";
    await expect(persistBundle(db, tampered, { resolveMetadata: devResolver() })).rejects.toThrow(/bundle_hash does not match/);
    const noSnapshot = referenceBundle({ snapshot: null });
    await expect(persistBundle(db, noSnapshot, { resolveMetadata: devResolver() })).rejects.toThrow(/snapshot/);
    expect(writes).toEqual([]);
  });

  it("refuses to store a fallback that fails its own validation, even when the bundle is internally consistent", async () => {
    const { db, writes } = recordingDb({});
    const b = referenceBundle();
    b.gaps[0].message = "an outbreak is confirmed in this area";
    b.bundle_hash = bundleHashOf(b);
    await expect(persistBundle(db, b, { resolveMetadata: devResolver(), now: () => "2026-01-01T00:00:00.000Z" })).rejects.toThrow(/extractive fallback failed validation/);
    expect(writes.filter((w) => w.table === "generated_explanations" || w.table === "explanation_citations")).toEqual([]);
    expect(writes.filter((w) => w.table === "retrieval_runs" && w.op === "update").map((w) => w.columns.sort())).toContainEqual(["error", "finished_at", "status"]); // the run is marked failed
  });

  it("builds a bundle only from the three inputs it is given (facts, retrieval, ranking)", () => {
    const b = referenceBundle();
    expect(() => buildBundle({ facts: undefined as never, identity: IDENTITY, retrieval: undefined as never, ranking: undefined as never })).toThrow();
    expect(b.schema_version).toBe("evidence-bundle/1");
  });
});
