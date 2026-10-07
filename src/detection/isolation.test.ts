// @vitest-environment node
// Leakage guard: the detector must be incapable of seeing the synthetic generator, the evaluation oracle or
// any ground-truth / synthetic marker.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(process.cwd(), "src", "detection");
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));

describe("detector isolation (no ground-truth leakage)", () => {
  it("finds the detector sources", () => {
    expect(files.length).toBeGreaterThan(8);
  });

  it("imports nothing from src/synthetic, src/evaluation, data/ or the supabase client", () => {
    for (const f of files) {
      const text = readFileSync(join(DIR, f), "utf8");
      const imports = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
      // Test files may use node built-ins (fs/crypto) but still must not reach the generator or oracle.
      const banned = f.endsWith(".test.ts") ? /synthetic|evaluation|ground|\/data\/|supabase/i : /synthetic|evaluation|ground|\/data\/|supabase|node:/i;
      for (const i of imports) expect(i, `${f} imports ${i}`).not.toMatch(banned);
    }
  });

  it("never mentions synthetic markers or ground truth in code (comments about the rule itself are allowed in types.ts/detector.ts headers)", () => {
    for (const f of files) {
      if (f.endsWith(".test.ts")) continue;
      const code = readFileSync(join(DIR, f), "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
        .join("\n");
      expect(code, f).not.toMatch(/synthetic_batch|is_synthetic|isSynthetic|groundTruth|ground_truth|planted/i);
    }
  });

  it("FeatureRow and RegionNode carry no synthetic marker", () => {
    const types = readFileSync(join(DIR, "types.ts"), "utf8");
    const row = types.slice(types.indexOf("export interface FeatureRow"), types.indexOf("export type TestKind"));
    expect(row).not.toMatch(/synthetic|truth|planted|event/i);
  });
});
