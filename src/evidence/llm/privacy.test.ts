// @vitest-environment node
// What the generation layer may touch, and what may touch it. Structural proof (source scans, import graphs) and runtime proof
// (a canary key, a fetch tripwire).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOCK_SCENARIOS, MockProvider } from "./mock";
import { buildPrompt } from "./prompt";
import { passagesFor, runScenario, TEST_NONCE } from "./testkit";
import { referenceBundle } from "../bundle/testkit";

const ROOT = process.cwd();
const DIR = join(ROOT, "src", "evidence", "llm");
const sources = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !/\.test\.ts$/.test(f) && f !== "testkit.ts");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const code = (f: string) => strip(readFileSync(join(DIR, f), "utf8"));
const importsOf = (src: string): string[] => [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
const runtimeImports = (src: string): string[] => [...src.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)].filter((m) => !m[1]).map((m) => m[2]);
const walkDir = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walkDir(join(d, n)) : [join(d, n)]));

function runtimeGraph(entries: string[]): string[] {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const i of runtimeImports(strip(readFileSync(file, "utf8")))) {
      if (!i.startsWith(".")) continue;
      const target = ["", ".ts"].map((ext) => resolve(dirname(file), i + ext)).find((p) => existsSync(p) && p.endsWith(".ts"));
      if (target) visit(target);
    }
  };
  entries.forEach((e) => visit(join(DIR, e)));
  return [...seen].map((f) => relative(ROOT, f).split("\\").join("/")).sort();
}

describe("the generation layer reads no environment and names the provider in one place only", () => {
  it("has source files to check", () => expect(sources.length).toBeGreaterThanOrEqual(14));

  it("never reads process.env or import.meta.env (configuration is handed in), and mentions no VITE_ variable", () => {
    for (const f of sources) {
      expect(code(f), f).not.toMatch(/\bprocess\.env\b|\bimport\.meta\.env\b|\bprocess\.argv\b/);
      expect(code(f), f).not.toMatch(/VITE_/);
    }
  });

  it("calls fetch, and names the provider endpoint, only in the Gemini adapter", () => {
    for (const f of sources.filter((x) => x !== "gemini.ts")) {
      expect(code(f), f).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|generativelanguage\.googleapis\.com/);
    }
    expect(code("gemini.ts")).toMatch(/generativelanguage\.googleapis\.com/);
    expect(code("gemini.ts")).toMatch(/fetch\(/);
  });

  it("uses no file system, process, network module, SDK, embedding or vector machinery", () => {
    for (const f of sources) {
      expect(code(f), f).not.toMatch(/node:(https?|net|dns|tls|dgram|child_process|fs|os)\b|\brequire\s*\(|\beval\s*\(|new Function/);
      expect(code(f), f).not.toMatch(/@google\/(generative-ai|genai)|from\s+["'](openai|@anthropic-ai|langchain)|\bembedding(s)?\b|pgvector|\bvector\b|cosine/i);
    }
  });

  it("names no sensitive table: reports, observations, aggregates, roles, profiles, audit", () => {
    for (const f of sources) expect(code(f), f).not.toMatch(/health_reports|deidentified_observations|report_aggregates|detection_daily_features|detector_findings|detector_runs|user_roles|profiles|audit_log|raw_report|auth\.users|signal_candidates/);
  });

  it("imports nothing from the detector, evaluation, the SSRF fetcher, the database client or the UI", () => {
    for (const f of sources) for (const i of importsOf(code(f))) expect(i, `${f} imports ${i}`).not.toMatch(/detection|evaluation|\/net\/|supabase|react|components|pages|features|hooks/);
  });
});

describe("the pure core has no database and no ingestion in its runtime graph", () => {
  it("prompt, parse, validate, render, generate, mock and config depend only on llm, bundle, ranking, retrieval, hash and vocab", () => {
    const graph = runtimeGraph(["generate.ts", "validate.ts", "render.ts", "prompt.ts", "forbidden.ts", "support.ts", "schema.ts", "mock.ts", "config.ts", "gemini.ts"]);
    for (const f of graph) expect(f, f).toMatch(/^src\/evidence\/(llm|bundle|ranking|retrieval)\/[a-zA-Z0-9]+\.ts$|^src\/evidence\/(hash|vocab)\.ts$/);
    expect(graph.some((f) => /persist|pipeline|ingest|\/net\/|supabase|testkit|detection/.test(f.replace("src/evidence/llm/persist.ts", "")))).toBe(false);
    expect(graph).not.toContain("src/evidence/llm/persist.ts");
    expect(graph).not.toContain("src/evidence/bundle/persist.ts");
  });
});

describe("what the database layer writes and reads", () => {
  it("writes only the three generation tables, only by insert, and only named columns", () => {
    const src = code("persist.ts");
    const written = [...src.matchAll(/\.(insert|update|delete|upsert|rpc)\(\s*"([a-z_]+)"/g)];
    expect(written.map((m) => m[1])).not.toEqual([]);
    for (const m of written) {
      expect(m[1], `${m[1]} ${m[2]}`).toBe("insert");
      expect(["generated_explanations", "generated_explanation_raw", "explanation_citations"]).toContain(m[2]);
    }
    for (const f of sources.filter((x) => x !== "persist.ts")) expect(code(f), f).not.toMatch(/\.(insert|update|delete|upsert|rpc)\(/);
  });

  it("selects only named columns, never `select *`", () => {
    for (const f of sources) {
      const src = code(f);
      const calls = src.match(/\.select\(/g) ?? [];
      const named = src.match(/\.select\(\s*"[a-z_]+"[^;\n]*?,\s*\[\s*"[a-z_]+"(?:\s*,\s*"[a-z_]+")*\s*\]/g) ?? [];
      expect(named.length, f).toBe(calls.length);
    }
  });
});

describe("nothing reachable from the browser can see a key or the model layer", () => {
  const ui = ["components", "pages", "features", "hooks", "lib"].flatMap((d) => walkDir(join(ROOT, "src", d))).filter((f) => /\.tsx?$/.test(f));
  ui.push(join(ROOT, "src", "App.tsx"), join(ROOT, "src", "main.tsx"));

  it("no browser file imports the evidence engine or mentions a provider key or model setting", () => {
    expect(ui.length).toBeGreaterThan(20);
    for (const f of ui) {
      const text = readFileSync(f, "utf8");
      expect(importsOf(text).filter((i) => /evidence/.test(i)), relative(ROOT, f)).toEqual([]);
      expect(text, relative(ROOT, f)).not.toMatch(/GEMINI|LLM_MODEL|LLM_PROVIDER|generativelanguage/);
    }
  });

  it("no VITE_-prefixed variable carries a provider key or model setting, anywhere in the repository's own files", () => {
    const files = [...walkDir(join(ROOT, "src")), ...walkDir(join(ROOT, "scripts")), join(ROOT, ".env.example"), join(ROOT, "index.html"), join(ROOT, "package.json")]
      .filter((f) => existsSync(f) && /\.(ts|tsx|mjs|js|json|html|example)$|\.env/.test(f) && !/^src\/evidence\/llm\/.+\.test\.ts$/.test(relative(ROOT, f).split("\\").join("/")) && !f.includes(`${join("src", "legacy")}`));
    for (const f of files) expect(readFileSync(f, "utf8"), relative(ROOT, f)).not.toMatch(/VITE_[A-Z_]*(GEMINI|LLM|API_KEY|SECRET)/);
  });

  it("the bundler configuration does not forward server environment variables to the browser", () => {
    for (const name of ["vite.config.ts", "vite.config.js", "vite.config.mjs"]) {
      const p = join(ROOT, name);
      if (existsSync(p)) expect(readFileSync(p, "utf8")).not.toMatch(/GEMINI|LLM_|process\.env/);
    }
  });

  it("documents the server-only variables in .env.example without any VITE_ prefix", () => {
    const text = readFileSync(join(ROOT, ".env.example"), "utf8");
    for (const name of ["LLM_PROVIDER", "LLM_MODEL", "GEMINI_API_KEY"]) expect(text).toMatch(new RegExp(`^${name}=`, "m"));
    expect(text).not.toMatch(/VITE_(LLM|GEMINI)/);
  });
});

describe("at runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const CANARY = "CANARY-SECRET-KEY-9f8e7d6c5b4a";

  it("selecting the mock (or no provider) makes no network call, whatever the scenario", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network call attempted");
    });
    for (const s of MOCK_SCENARIOS) await runScenario({ scenario: s });
    await runScenario(null);
    expect(spy).not.toHaveBeenCalled();
  });

  it("a key present in the environment never reaches a prompt, a request, a result or a report", async () => {
    vi.stubEnv("GEMINI_API_KEY", CANARY);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", CANARY);
    vi.stubEnv("LLM_PROVIDER", "mock");
    const provider = new MockProvider({ scenario: ["unsupported_number", "valid"] });
    const r = await runScenario(provider);
    expect(JSON.stringify({ calls: provider.calls, r })).not.toContain(CANARY);
  });

  it("the request holds only the signal facts, the engine's gaps and the passages: no ids, hashes, titles, URLs or counts", () => {
    const bundle = referenceBundle();
    const p = buildPrompt({ bundle, passages: passagesFor(bundle), nonce: TEST_NONCE });
    const outside = `${p.system}\n${p.user.slice(0, p.user.indexOf("DATA_START"))}\n${p.user.slice(p.user.indexOf("DATA_END"))}`;
    expect(outside).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{40,}/);
    expect(outside).not.toMatch(/https?:\/\//);
    for (const leak of ["observed", "p_value", "patient", "phone", "latitude", "service_role", "episode", "detector_version"]) expect(outside, leak).not.toContain(leak);
    // numbers outside the passages: only the window dates, the citation ids and the limits in the task text
    const nums = [...new Set((outside.split(TEST_NONCE).join("").match(/\d+/g) ?? []))];
    expect(nums.every((n) => n.length <= 4)).toBe(true);
  });
});
