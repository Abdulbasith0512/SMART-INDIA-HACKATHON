// @vitest-environment node
// Separation of concerns:  STATISTICAL ENGINE -> signals;  EVIDENCE ENGINE -> evidence;  LLM -> summaries.
// Nothing may silently cross these boundaries.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const f = join(dir, n);
    return statSync(f).isDirectory() ? walk(f) : [f];
  });
const importsOf = (file: string): string[] => [...readFileSync(file, "utf8").matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
const sources = (dir: string) => walk(join(ROOT, dir)).filter((f) => /\.tsx?$/.test(f));

describe("evidence engine / statistical engine isolation", () => {
  it("nothing in src/detection imports the evidence engine", () => {
    const offenders = sources("src/detection").filter((f) => importsOf(f).some((i) => /evidence/i.test(i))).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("evidence code (outside its own evaluation harness) imports neither the detector, the M3 evaluation, nor the synthetic generator", () => {
    const files = sources("src/evidence").filter((f) => !/\.test\.tsx?$/.test(f) && !f.includes(`${join("src", "evidence", "evaluation")}`));
    const offenders = files.filter((f) => importsOf(f).some((i) => /detection|\/evaluation\/|synthetic/.test(i) && !i.includes("evidence/evaluation"))).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("only the quarantined LLM directory and its approved consumers may reference it", () => {
    const allowedConsumers = [join("src", "evidence", "generation"), join("src", "evidence", "llm"), join("scripts", "explain-signal.ts"), join("scripts", "eval-evidence.ts"), join("scripts", "verify-m4.ts"), join("scripts", "verify-m4-5.ts"), join("scripts", "smoke-gemini.ts")];
    const files = [...sources("src"), ...walk(join(ROOT, "scripts")).filter((f) => /\.tsx?$/.test(f))].filter((f) => !f.includes(join("src", "legacy")));
    const offenders = files
      .filter((f) => importsOf(f).some((i) => /evidence\/llm|\.\/llm|\.\.\/llm/.test(i)))
      .map((f) => relative(ROOT, f))
      .filter((f) => !allowedConsumers.some((a) => f.startsWith(a)) && !/\.test\.tsx?$/.test(f));
    expect(offenders).toEqual([]);
  });

  it("browser-reachable code never imports the evidence engine (fetcher, ingestion and corpus tooling are server/CLI only)", () => {
    const ui = ["components", "pages", "features", "hooks", "lib"].flatMap((d) => sources(join("src", d)));
    const files = [...ui, join(ROOT, "src", "App.tsx"), join(ROOT, "src", "main.tsx")];
    const offenders = files.filter((f) => importsOf(f).some((i) => /(^|\/)evidence(\/|$)/.test(i))).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("only the net layer, CLI scripts and tests import the SSRF-safe fetcher", () => {
    const files = [...sources("src"), ...walk(join(ROOT, "scripts")).filter((f) => /\.tsx?$/.test(f))].filter((f) => !f.includes(join("src", "legacy")));
    const offenders = files
      .filter((f) => importsOf(f).some((i) => /net\/fetcher|\.\/fetcher/.test(i)))
      .map((f) => relative(ROOT, f))
      .filter((f) => !f.startsWith(join("src", "evidence", "net")) && !f.startsWith("scripts") && !/\.test\.tsx?$/.test(f));
    expect(offenders).toEqual([]);
  });

  it("retrieval and ingestion modules never import generation or the LLM", () => {
    const dirs = ["retrieval", "ingest", "rank", "ranking", "bundle", "net", "devcorpus"].map((d) => join("src", "evidence", d));
    const files = sources("src/evidence").filter((f) => dirs.some((d) => relative(ROOT, f).startsWith(d)));
    const offenders = files.filter((f) => importsOf(f).some((i) => /generation|llm/.test(i))).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
