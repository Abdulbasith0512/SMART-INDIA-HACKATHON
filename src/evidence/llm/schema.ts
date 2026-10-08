// Required model output and its runtime validation.
//
//   { "points": [ { "text", "kind", "citations": ["E1"], "anchors": [ { "citation": "E1", "quote": "verbatim" } ] } ],
//     "uncertainties": [], "missing_evidence": [] }
//
// JSON only. Unknown fields are refused, enum values are closed, every field is required, and sizes are bounded. A provider
// may be handed the JSON Schema below to constrain its output, but that is a convenience: this module is what decides.
import { z } from "zod";
import { POINT_KINDS, type ModelOutput } from "./types";

export const MAX_POINTS = 12;
export const MAX_TEXT = 500;
export const MAX_QUOTE = 400;
export const MAX_NOTES = 8;
export const MAX_NOTE = 300;
export const MAX_CITATIONS_PER_POINT = 6;
export const MAX_ANCHORS_PER_POINT = 12;

const CITATION_ID = /^E[1-9]\d{0,3}$/;
const citationId = z.string().regex(CITATION_ID, "citation id must look like E1");

const anchorSchema = z.object({ citation: citationId, quote: z.string().min(1).max(MAX_QUOTE) }).strict();

const pointSchema = z
  .object({
    text: z.string().min(1).max(MAX_TEXT),
    kind: z.enum(POINT_KINDS),
    citations: z.array(citationId).min(1).max(MAX_CITATIONS_PER_POINT),
    anchors: z.array(anchorSchema).min(1).max(MAX_ANCHORS_PER_POINT),
  })
  .strict()
  .refine((p) => new Set(p.citations).size === p.citations.length, { message: "citations must be unique", path: ["citations"] });

export const outputSchema = z
  .object({
    points: z.array(pointSchema).min(1).max(MAX_POINTS),
    uncertainties: z.array(z.string().min(1).max(MAX_NOTE)).max(MAX_NOTES),
    missing_evidence: z.array(z.string().min(1).max(MAX_NOTE)).max(MAX_NOTES),
  })
  .strict();

export type ParseFailure = { ok: false; category: "empty_response" | "malformed_json" | "schema_violation"; issues: string[] };
export type ParseResult = { ok: true; value: ModelOutput } | ParseFailure;

/** Strict parse: the whole response must be one JSON object (no fences, no prose around it) that satisfies the schema. */
export function parseModelOutput(raw: string): ParseResult {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, category: "empty_response", issues: [] };
  let json: unknown;
  try {
    json = JSON.parse(raw.trim());
  } catch {
    return { ok: false, category: "malformed_json", issues: [] };
  }
  const parsed = outputSchema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data as ModelOutput };
  // Issue paths and codes only: never the offending values, which are untrusted model text.
  return { ok: false, category: "schema_violation", issues: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`) };
}

/** The same shape as plain JSON Schema, restricted to the keywords Gemini's structured output documents as supported. */
export const OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    points: {
      type: "array",
      minItems: 1,
      maxItems: MAX_POINTS,
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          kind: { type: "string", enum: [...POINT_KINDS] },
          citations: { type: "array", minItems: 1, maxItems: MAX_CITATIONS_PER_POINT, items: { type: "string" } },
          anchors: {
            type: "array",
            minItems: 1,
            maxItems: MAX_ANCHORS_PER_POINT,
            items: { type: "object", properties: { citation: { type: "string" }, quote: { type: "string" } }, required: ["citation", "quote"], additionalProperties: false },
          },
        },
        required: ["text", "kind", "citations", "anchors"],
        additionalProperties: false,
      },
    },
    uncertainties: { type: "array", maxItems: MAX_NOTES, items: { type: "string" } },
    missing_evidence: { type: "array", maxItems: MAX_NOTES, items: { type: "string" } },
  },
  required: ["points", "uncertainties", "missing_evidence"],
  additionalProperties: false,
};
