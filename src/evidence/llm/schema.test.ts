// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MAX_ANCHORS_PER_POINT, MAX_CITATIONS_PER_POINT, MAX_NOTE, MAX_NOTES, MAX_POINTS, MAX_QUOTE, MAX_TEXT, OUTPUT_JSON_SCHEMA, parseModelOutput } from "./schema";

const point = (over: Record<string, unknown> = {}) => ({ text: "Passage [E1] states a rule.", kind: "evidence_statement", citations: ["E1"], anchors: [{ citation: "E1", quote: "a rule of some kind" }], ...over });
const out = (over: Record<string, unknown> = {}) => JSON.stringify({ points: [point()], uncertainties: [], missing_evidence: [], ...over });

describe("model output schema", () => {
  it("accepts the required shape", () => {
    const r = parseModelOutput(out());
    expect(r.ok).toBe(true);
  });

  it("classifies empty, malformed and schema-violating answers", () => {
    expect(parseModelOutput("")).toMatchObject({ ok: false, category: "empty_response" });
    expect(parseModelOutput("   \n ")).toMatchObject({ ok: false, category: "empty_response" });
    expect(parseModelOutput("{ not json")).toMatchObject({ ok: false, category: "malformed_json" });
    expect(parseModelOutput("[1,2]")).toMatchObject({ ok: false, category: "schema_violation" });
    expect(parseModelOutput("null")).toMatchObject({ ok: false, category: "schema_violation" });
  });

  it("is JSON only: fences, prose around the object, and a trailing explanation are all malformed", () => {
    expect(parseModelOutput("```json\n" + out() + "\n```")).toMatchObject({ ok: false, category: "malformed_json" });
    expect(parseModelOutput("Here is the answer: " + out())).toMatchObject({ ok: false, category: "malformed_json" });
    expect(parseModelOutput(out() + " Hope this helps!")).toMatchObject({ ok: false, category: "malformed_json" });
  });

  it("refuses unknown fields at every level", () => {
    expect(parseModelOutput(out({ confidence: 0.9 }))).toMatchObject({ ok: false, category: "schema_violation" });
    expect(parseModelOutput(out({ points: [point({ extra: 1 })] }))).toMatchObject({ ok: false, category: "schema_violation" });
    expect(parseModelOutput(out({ points: [point({ anchors: [{ citation: "E1", quote: "a rule of some kind", note: "x" }] })] }))).toMatchObject({ ok: false, category: "schema_violation" });
  });

  it("refuses missing required fields", () => {
    for (const drop of ["points", "uncertainties", "missing_evidence"]) {
      const o = JSON.parse(out());
      delete o[drop];
      expect(parseModelOutput(JSON.stringify(o)), drop).toMatchObject({ ok: false, category: "schema_violation" });
    }
    for (const drop of ["text", "kind", "citations", "anchors"]) {
      const p = point();
      delete (p as Record<string, unknown>)[drop];
      expect(parseModelOutput(out({ points: [p] })), drop).toMatchObject({ ok: false, category: "schema_violation" });
    }
  });

  it("refuses invalid enum values, malformed citation ids and malformed anchors", () => {
    expect(parseModelOutput(out({ points: [point({ kind: "opinion" })] }))).toMatchObject({ ok: false });
    for (const bad of ["e1", "E", "E0", "E01", "E1; DROP", "[E1]", "E12345", ""]) expect(parseModelOutput(out({ points: [point({ citations: [bad], anchors: [{ citation: "E1", quote: "a rule of some kind" }] })] })), bad).toMatchObject({ ok: false });
    expect(parseModelOutput(out({ points: [point({ anchors: [{ citation: "E1" }] })] }))).toMatchObject({ ok: false });
    expect(parseModelOutput(out({ points: [point({ anchors: [{ citation: "E1", quote: "" }] })] }))).toMatchObject({ ok: false });
    expect(parseModelOutput(out({ points: [point({ anchors: [] })] }))).toMatchObject({ ok: false });
    expect(parseModelOutput(out({ points: [point({ citations: [] })] }))).toMatchObject({ ok: false });
    expect(parseModelOutput(out({ points: [point({ citations: ["E1", "E1"] })] }))).toMatchObject({ ok: false });
  });

  it("refuses wrong types", () => {
    expect(parseModelOutput(out({ points: "none" }))).toMatchObject({ ok: false });
    expect(parseModelOutput(out({ uncertainties: [1] }))).toMatchObject({ ok: false });
    expect(parseModelOutput(out({ points: [point({ text: 5 })] }))).toMatchObject({ ok: false });
  });

  it("bounds sizes", () => {
    expect(parseModelOutput(out({ points: [] }))).toMatchObject({ ok: false });
    expect(parseModelOutput(out({ points: Array.from({ length: MAX_POINTS + 1 }, () => point()) }))).toMatchObject({ ok: false });
    expect(parseModelOutput(out({ points: [point({ text: "x".repeat(MAX_TEXT + 1) })] }))).toMatchObject({ ok: false });
    expect(parseModelOutput(out({ points: [point({ anchors: [{ citation: "E1", quote: "y".repeat(MAX_QUOTE + 1) }] })] }))).toMatchObject({ ok: false });
    expect(parseModelOutput(out({ uncertainties: Array.from({ length: MAX_NOTES + 1 }, () => "a note") }))).toMatchObject({ ok: false });
    expect(parseModelOutput(out({ missing_evidence: ["n".repeat(MAX_NOTE + 1)] }))).toMatchObject({ ok: false });
    expect(parseModelOutput(out({ points: [point({ citations: Array.from({ length: MAX_CITATIONS_PER_POINT + 1 }, (_, i) => `E${i + 1}`) })] }))).toMatchObject({ ok: false });
    expect(parseModelOutput(out({ points: [point({ anchors: Array.from({ length: MAX_ANCHORS_PER_POINT + 1 }, () => ({ citation: "E1", quote: "a rule of some kind" })) })] }))).toMatchObject({ ok: false });
    expect(parseModelOutput(out({ points: Array.from({ length: MAX_POINTS }, () => point()) })).ok).toBe(true);
  });

  it("reports only issue paths and codes, never the offending values", () => {
    const r = parseModelOutput(out({ points: [point({ kind: "SECRET-VALUE-IN-KIND" })] }));
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(JSON.stringify(r.issues)).not.toContain("SECRET-VALUE-IN-KIND");
  });

  it("publishes a JSON Schema that uses only the keywords Gemini documents as supported", () => {
    const allowed = new Set(["type", "properties", "required", "additionalProperties", "enum", "items", "minItems", "maxItems"]);
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (k === "properties") for (const sub of Object.values(v as object)) walk(sub);
          else {
            expect(allowed.has(k), k).toBe(true);
            walk(v);
          }
        }
      }
    };
    walk(OUTPUT_JSON_SCHEMA);
    expect(OUTPUT_JSON_SCHEMA.additionalProperties).toBe(false);
  });
});
