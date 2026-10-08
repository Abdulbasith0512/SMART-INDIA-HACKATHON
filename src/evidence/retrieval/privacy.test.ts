// @vitest-environment node
// Retrieval receives only officer-visible aggregate signal facts, reads only evidence tables, makes no network
// call, needs no secret, and is not reachable from the browser. These tests prove it structurally (source and
// module graph) and at runtime (tripwires).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvidenceDb, Row } from "../ingest/ingest";
import { RETRIEVAL_CONFIG_DEV } from "./config";
import { retrieveCandidates, retrieveFromCorpus } from "./retrieve";
import { loadSignalFacts } from "./signal";
import { makeFacts, REGION, uid, viewFromPrepared } from "./testkit";

const ROOT = process.cwd();
const DIR = join(ROOT, "src", "evidence", "retrieval");
const sources = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !/\.test\.ts$/.test(f) && f !== "testkit.ts");
const text = (f: string) => readFileSync(join(DIR, f), "utf8");
/** Source with comments removed, so documentation can mention forbidden things without tripping the checks. */
const code = (f: string) => text(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const importsOf = (src: string): string[] => [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);

describe("retrieval source: no sensitive data, no network, no secrets", () => {
  it("has source files to check", () => expect(sources.length).toBeGreaterThanOrEqual(9));

  it("never references report, observation, aggregate, role, profile or audit data", () => {
    const banned = /health_reports|deidentified_observations|report_aggregates|detection_daily_features|detector_findings|detector_runs|user_roles|profiles|audit_log|raw_report|auth\.users/;
    for (const f of sources) expect(code(f), f).not.toMatch(banned);
  });

  it("reads only the evidence tables, the corpus snapshot table, regions and signal_candidates", () => {
    const allowed = new Set(["evidence_items", "evidence_versions", "evidence_chunks", "corpus_snapshots", "regions", "signal_candidates"]);
    const used = new Set<string>();
    for (const f of sources) {
      for (const m of code(f).matchAll(/\.select\(\s*["']([a-z_]+)["']/g)) used.add(m[1]);
      for (const m of code(f).matchAll(/inBatches\(\s*db\s*,\s*["']([a-z_]+)["']/g)) used.add(m[1]);
    }
    expect([...used].sort()).toEqual([...allowed].sort());
    for (const f of sources) expect(code(f), f).not.toMatch(/\.(insert|update|delete|upsert|rpc)\(/);
  });

  it("makes no network, file-system, process or secret access", () => {
    const banned = /\bfetch\s*\(|XMLHttpRequest|WebSocket|node:(https?|net|dns|tls|dgram|child_process|fs|os)|\bprocess\.env\b|\bimport\.meta\.env\b|\brequire\s*\(|\beval\s*\(|new Function/;
    for (const f of sources) expect(code(f), f).not.toMatch(banned);
  });

  it("names no model provider and uses no embedding or vector machinery", () => {
    const banned = /openai|anthropic|gemini|generativelanguage|embedding|pgvector|\bvector\b|cosine/i;
    for (const f of sources) expect(code(f), f).not.toMatch(banned);
  });

  it("imports nothing from the detector, the LLM, generation, the fetcher, the database client or the UI", () => {
    for (const f of sources) {
      for (const i of importsOf(code(f))) expect(i, `${f} imports ${i}`).not.toMatch(/detection|evaluation|llm|generation|net\/|supabase|react|components|pages|features|hooks/);
    }
  });

  it("has a pure RUNTIME dependency graph: only retrieval modules, the hash helper and the static vocabulary", () => {
    // Type-only imports are erased at compile time, so they add nothing at runtime and are ignored here.
    const runtimeImports = (src: string): string[] => [...src.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)].filter((m) => !m[1]).map((m) => m[2]);
    const seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const i of runtimeImports(readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"))) {
        if (!i.startsWith(".")) continue;
        const target = ["", ".ts"].map((ext) => resolve(dirname(file), i + ext)).find((p) => existsSync(p) && p.endsWith(".ts"));
        if (target) walk(target);
      }
    };
    walk(join(DIR, "index.ts"));
    const rel = [...seen].map((f) => relative(ROOT, f).split("\\").join("/")).sort();
    for (const f of rel) expect(f, f).toMatch(/^src\/evidence\/retrieval\/[a-zA-Z0-9]+\.ts$|^src\/evidence\/(hash|vocab)\.ts$/);
    expect(rel).toEqual(expect.arrayContaining(["src/evidence/hash.ts", "src/evidence/retrieval/bm25.ts", "src/evidence/vocab.ts"]));
    expect(rel.some((f) => /ingest|net\/|llm|generation|detection|supabase/.test(f))).toBe(false);
  });
});

describe("retrieval at runtime: tripwires", () => {
  afterEach(() => vi.restoreAllMocks());

  it("makes no network call and needs no secret", async () => {
    const calls: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((...a) => {
      calls.push(a);
      throw new Error("network call attempted");
    });
    for (const k of ["SUPABASE_SERVICE_ROLE_KEY", "GEMINI_API_KEY", "LLM_PROVIDER", "VITE_SUPABASE_ANON_KEY"]) vi.stubEnv(k, "");
    const r = retrieveFromCorpus(viewFromPrepared(), makeFacts(), RETRIEVAL_CONFIG_DEV);
    expect(r.facets.reduce((n, f) => n + f.candidates.length, 0)).toBeGreaterThan(0);
    expect(calls).toEqual([]);
    vi.unstubAllEnvs();
  });

  it("reads evidence tables only, with named columns, and writes nothing", async () => {
    const view = viewFromPrepared();
    const reads: Array<{ table: string; columns: readonly string[] | undefined }> = [];
    // A minimal fake database that serves the corpus view back as rows.
    const items: Row[] = view.items.map((i) => ({
      id: i.id, canonical_id: i.canonicalId, title: i.title, publisher: i.publisher, source_class: i.sourceClass, evidence_kind: i.evidenceKind, trust_level: i.trustLevel,
      status: i.status, topics: i.topics, syndromes: i.syndromes, geo_scope: i.geoScope, geo_region_id: i.geoRegionId, language: i.language, publication_date: i.publicationDate,
      valid_from: i.validFrom, valid_until: i.validUntil, is_synthetic: i.isSynthetic, supersedes_id: i.supersedesId,
    }));
    const versions: Row[] = view.items.map((i) => ({ id: i.version!.id, evidence_item_id: i.id, content_hash: i.version!.contentHash, fetch_status: i.version!.fetchStatus, is_current: true }));
    const chunks: Row[] = view.items.flatMap((i) => i.chunks.map((c) => ({ id: c.id, version_id: i.version!.id, ordinal: c.ordinal, kind: c.kind, text: c.text, chunk_hash: c.chunkHash, language: c.language })));
    const tables: Record<string, Row[]> = { evidence_items: items, evidence_versions: versions, evidence_chunks: chunks, corpus_snapshots: [] };
    const db: EvidenceDb = {
      async select(table, match, columns) {
        reads.push({ table, columns });
        return (tables[table] ?? []).filter((r) => Object.entries(match ?? {}).every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v)));
      },
      async insert() {
        throw new Error("write attempted");
      },
      async update() {
        throw new Error("write attempted");
      },
    };
    const r = await retrieveCandidates(db, makeFacts(), RETRIEVAL_CONFIG_DEV);
    expect(r.facets.reduce((n, f) => n + f.candidates.length, 0)).toBeGreaterThan(0);
    expect(new Set(reads.map((x) => x.table))).toEqual(new Set(["evidence_items", "evidence_versions", "evidence_chunks", "corpus_snapshots"]));
    for (const x of reads) {
      expect(x.columns, x.table).toBeDefined(); // never `select *`
      for (const banned of ["created_by", "verified_by", "reference_url", "citation", "notes", "licence"]) expect(x.columns, `${x.table}.${banned}`).not.toContain(banned);
    }
    // identical to the pure path
    expect(r.resultHash).toBe(retrieveFromCorpus(view, makeFacts(), RETRIEVAL_CONFIG_DEV).resultHash);
  });

  it("loading a signal asks for no report, observation or free-text columns", async () => {
    const asked: string[] = [];
    const db: EvidenceDb = {
      async select(table, _m, columns) {
        asked.push(`${table}:${(columns ?? ["*"]).join(",")}`);
        return [];
      },
      async insert() {
        throw new Error("write attempted");
      },
      async update() {
        throw new Error("write attempted");
      },
    };
    expect(await loadSignalFacts(db, uid("signal:none"))).toBeNull();
    expect(asked).toEqual(["signal_candidates:id,syndrome,region_id,time_window_start,time_window_end,score_components,evidence"]);
    expect(REGION.state).toBeTruthy();
  });
});

describe("no client-side retrieval path", () => {
  it("nothing in the browser build imports the retrieval engine", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const ui = ["components", "pages", "features", "hooks", "lib"].flatMap((d) => walk(join(ROOT, "src", d))).filter((f) => /\.tsx?$/.test(f));
    ui.push(join(ROOT, "src", "App.tsx"), join(ROOT, "src", "main.tsx"));
    expect(ui.length).toBeGreaterThan(20);
    for (const f of ui) expect(importsOf(readFileSync(f, "utf8")).filter((i) => /evidence/.test(i)), relative(ROOT, f)).toEqual([]);
  });
});
