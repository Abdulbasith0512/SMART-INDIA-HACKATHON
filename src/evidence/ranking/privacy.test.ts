// @vitest-environment node
// M4.3 works only on SignalFacts, evidence metadata and M4.2 candidates. No raw or de-identified data, no personal
// identifiers, no provider or network call, no secret, and no browser path. Structural and runtime proof.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvidenceDb, Row } from "../ingest/ingest";
import { RETRIEVAL_CONFIG_DEV } from "../retrieval/config";
import { retrieveFromCorpus } from "../retrieval/retrieve";
import { makeFacts, viewFromPrepared } from "../retrieval/testkit";
import { rankForSignal, retrieveAndRank } from "./pipeline";
import { rankEvidence } from "./rank";

const ROOT = process.cwd();
const DIR = join(ROOT, "src", "evidence", "ranking");
// scenarios.ts reads the development corpus from disk for scripts and tests; it is not part of the ranking module graph.
const sources = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !/\.test\.ts$/.test(f) && f !== "scenarios.ts");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const code = (f: string) => strip(readFileSync(join(DIR, f), "utf8"));
const importsOf = (src: string): string[] => [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);

describe("ranking source: no sensitive data, no network, no secrets, no model", () => {
  it("has source files to check", () => expect(sources.length).toBeGreaterThanOrEqual(10));

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

  it("writes nothing", () => {
    for (const f of sources) expect(code(f), f).not.toMatch(/\.(insert|update|delete|upsert|rpc)\(/);
  });

  it("imports nothing from the detector, the LLM, generation, the fetcher, the database client or the UI", () => {
    for (const f of sources) for (const i of importsOf(code(f))) expect(i, `${f} imports ${i}`).not.toMatch(/detection|evaluation|llm|generation|net\/|supabase|react|components|pages|features|hooks|scenarios|testkit/);
  });

  it("has a pure RUNTIME dependency graph: ranking, retrieval, the hash helper and the static vocabulary only", () => {
    const runtimeImports = (src: string): string[] => [...src.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)].filter((m) => !m[1]).map((m) => m[2]);
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
    walk(join(DIR, "index.ts"));
    const rel = [...seen].map((f) => relative(ROOT, f).split("\\").join("/")).sort();
    for (const f of rel) expect(f, f).toMatch(/^src\/evidence\/(ranking|retrieval)\/[a-zA-Z0-9]+\.ts$|^src\/evidence\/(hash|vocab)\.ts$/);
    expect(rel.filter((f) => f.endsWith("testkit.ts") || f.endsWith("scenarios.ts"))).toEqual([]);
    expect(rel.some((f) => /ingest|net\/|llm|generation|detection|supabase/.test(f))).toBe(false);
  });
});

describe("ranking at runtime: tripwires", () => {
  afterEach(() => vi.restoreAllMocks());

  it("makes no network call and needs no secret", () => {
    const calls: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((...a) => {
      calls.push(a);
      throw new Error("network call attempted");
    });
    for (const k of ["SUPABASE_SERVICE_ROLE_KEY", "GEMINI_API_KEY", "LLM_PROVIDER", "VITE_SUPABASE_ANON_KEY"]) vi.stubEnv(k, "");
    const r = retrieveAndRank({ facts: makeFacts(), view: viewFromPrepared(), retrievalConfig: RETRIEVAL_CONFIG_DEV });
    expect(r.facets.reduce((n, f) => n + f.selected.length, 0)).toBeGreaterThan(0);
    expect(calls).toEqual([]);
    vi.unstubAllEnvs();
  });

  it("refuses signal facts that carry anything beyond the allowed projection", () => {
    const view = viewFromPrepared();
    const retrieval = retrieveFromCorpus(view, makeFacts(), RETRIEVAL_CONFIG_DEV);
    for (const extra of [{ observed: 17 }, { patient_name: "A. Person" }, { phone: "+91 90000 00000" }, { latitude: 20.27 }, { reports: [{ id: "r1" }] }, { explanation: "free text" }]) {
      expect(() => rankEvidence({ facts: { ...makeFacts(), ...extra } as never, retrieval, view }), JSON.stringify(extra)).toThrow();
    }
  });

  it("the ranking output contains nothing from outside its three inputs (no counts, no signal text)", () => {
    const r = retrieveAndRank({ facts: makeFacts(), view: viewFromPrepared(), retrievalConfig: RETRIEVAL_CONFIG_DEV });
    const text = JSON.stringify(r);
    for (const leak of ["Emerging signal", "requiring verification", "p_value", "observed_value", "patient", "phone"]) expect(text, leak).not.toContain(leak);
  });

  it("the database path reads evidence tables, regions and the stored candidate only, with named columns, and writes nothing", async () => {
    const view = viewFromPrepared();
    const hview = viewFromPrepared(undefined, null, ["superseded", "historical"]);
    const merged = new Map([...view.items, ...hview.items].map((i) => [i.id, i]));
    const items: Row[] = [...merged.values()].map((i) => ({
      id: i.id, canonical_id: i.canonicalId, title: i.title, publisher: i.publisher, source_class: i.sourceClass, evidence_kind: i.evidenceKind, trust_level: i.trustLevel,
      status: i.status, topics: i.topics, syndromes: i.syndromes, geo_scope: i.geoScope, geo_region_id: i.geoRegionId, language: i.language, publication_date: i.publicationDate,
      valid_from: i.validFrom, valid_until: i.validUntil, is_synthetic: i.isSynthetic, supersedes_id: i.supersedesId, question_key: i.questionKey, position: i.position,
    }));
    const versions: Row[] = [...merged.values()].map((i) => ({ id: i.version!.id, evidence_item_id: i.id, content_hash: i.version!.contentHash, fetch_status: i.version!.fetchStatus, is_current: true }));
    const chunks: Row[] = [...merged.values()].flatMap((i) => [...view.items, ...hview.items].filter((x) => x.id === i.id).flatMap((x) => x.chunks).map((c) => ({ id: c.id, version_id: i.version!.id, ordinal: c.ordinal, kind: c.kind, text: c.text, chunk_hash: c.chunkHash, language: c.language })));
    const reads: Array<{ table: string; columns: readonly string[] | undefined }> = [];
    const facts = makeFacts();
    const tables: Record<string, Row[]> = {
      evidence_items: items, evidence_versions: versions, evidence_chunks: chunks, corpus_snapshots: [],
      signal_candidates: [{ id: facts.signal_id, syndrome: facts.syndrome, region_id: facts.region.id, time_window_start: "2025-08-31T18:30:00Z", time_window_end: "2025-09-07T18:30:00Z", score_components: { involvedBlocks: 1, blocksInDistrict: 4, persistence: 0.8 }, evidence: { involved_blocks: facts.involved_blocks } }],
      regions: [facts.region, ...facts.ancestors].map((r, i, a) => ({ id: r.id, name: r.name, region_type: r.level, parent_region_id: a[i + 1]?.id ?? null })),
    };
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
    const out = await rankForSignal(db, facts.signal_id, RETRIEVAL_CONFIG_DEV);
    expect(out).not.toBeNull();
    expect(new Set(reads.map((x) => x.table))).toEqual(new Set(["signal_candidates", "regions", "evidence_items", "evidence_versions", "evidence_chunks", "corpus_snapshots"]));
    for (const x of reads) {
      expect(x.columns, x.table).toBeDefined(); // never `select *`
      for (const banned of ["created_by", "verified_by", "reference_url", "citation", "notes", "licence", "explanation", "observed_value", "review_note"]) expect(x.columns, `${x.table}.${banned}`).not.toContain(banned);
    }
    expect(out!.retrieval.resultHash).toBe(retrieveFromCorpus(view, facts, RETRIEVAL_CONFIG_DEV).resultHash);
  });
});

describe("no client-side ranking path", () => {
  it("nothing in the browser build imports the evidence engine", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const ui = ["components", "pages", "features", "hooks", "lib"].flatMap((d) => walk(join(ROOT, "src", d))).filter((f) => /\.tsx?$/.test(f));
    ui.push(join(ROOT, "src", "App.tsx"), join(ROOT, "src", "main.tsx"));
    expect(ui.length).toBeGreaterThan(20);
    for (const f of ui) expect(importsOf(readFileSync(f, "utf8")).filter((i) => /evidence/.test(i)), relative(ROOT, f)).toEqual([]);
  });
});
