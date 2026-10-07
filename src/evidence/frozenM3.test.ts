// @vitest-environment node
// M4 must not touch M1-M3. This pins (a) every applied migration and (b) the frozen M3 detector sources,
// configuration and held-out evaluation artefact by normalised SHA-256. If one of these changes, the change is
// either an accident or a deliberate new detector/migration version that needs its own review and evaluation.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DETECTOR_V1, configHash } from "../detection";

const ROOT = process.cwd();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const norm = (f: string) => readFileSync(join(ROOT, f), "utf8").replace(/\r\n/g, "\n");

const APPLIED_MIGRATIONS: Record<string, string> = {
  "20261007000000_m1_auth_foundation.sql": "fe02014ca864eb1f0f2b53ce1cb96d155a0b1cc2b76465601b241bfbceb04425",
  "20261007010000_m1_revoke_trigger_function_execute.sql": "b4a9809b9efd3f83e18d52ac6ff525ca37713e4a33fcf9cc7c5643662c7cd3fe",
  "20261007020000_m2_schema.sql": "d1b65925d3bff9b3e66dd2f8806e4419ac527e1cd408783eddf12d874206d504",
  "20261007030000_m2_security.sql": "10cbb44674caa6b06400994c70bd4fe6145967d88e747765789d6f16b0bef777",
  "20261007040000_m2_role_probe_hardening.sql": "ec21f4bb7e5432c43c8119fc1171cacd5e3011a9e20afafea9c5577fd57ca4e5",
  "20261007050000_m3_detection.sql": "4b60238a9451af3db557766489035082e889c23ff3dc599f92830321d04a9c9f",
};
const FROZEN_CONFIG_HASH = "23188f021f80bd84113165469456f72165be682522243f908cbb715793d104ba";
const FROZEN_RESULTS_HASH = "13c5e6d401c6fac975e0f562a83b1f3abaacb706f7679e7270a780fe9c82619a";
const FROZEN_DETECTOR_SOURCES_HASH = "fb39c8a6d848f940c0d7a7359502d1695fbfe860e33704c306f2d336fd93db7b";

describe("M1-M3 are frozen under M4", () => {
  it("applied migrations are byte-for-byte unchanged (normalised line endings)", () => {
    for (const [file, expected] of Object.entries(APPLIED_MIGRATIONS)) {
      expect(sha(norm(join("supabase", "migrations", file))), file).toBe(expected);
    }
  });

  it("the M3 detector configuration is the frozen one", () => {
    expect(configHash(DETECTOR_V1)).toBe(FROZEN_CONFIG_HASH);
    expect(JSON.parse(norm("data/detection/m3-detector-v1.config.json")).config_hash).toBe(FROZEN_CONFIG_HASH);
  });

  it("the committed held-out M3 evaluation still refers to the frozen config and results", () => {
    const e = JSON.parse(norm("data/detection/m3-evaluation-v1.json"));
    expect(e.detector.config_hash).toBe(FROZEN_CONFIG_HASH);
    expect(e.hashes.results_summary_sha256).toBe(FROZEN_RESULTS_HASH);
  });

  it("the detector source files are unchanged", () => {
    const files = readdirSync(join(ROOT, "src", "detection")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort();
    expect(sha(files.map((f) => `${f}\n${norm(join("src", "detection", f))}`).join("\n---\n"))).toBe(FROZEN_DETECTOR_SOURCES_HASH);
  });

  it("only M4 migrations exist after the frozen set", () => {
    const later = readdirSync(join(ROOT, "supabase", "migrations")).filter((f) => f.endsWith(".sql") && !(f in APPLIED_MIGRATIONS));
    expect(later.every((f) => f > "20261007050000" && /_m4_/.test(f))).toBe(true);
  });
});
