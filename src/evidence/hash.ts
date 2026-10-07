// Deterministic hashing for the evidence layer: canonical JSON (sorted keys, no undefined/NaN) + SHA-256.
// Server-side only (node:crypto). Used by the corpus manifest, chunk hashes and (later) bundle hashes.
import { createHash } from "node:crypto";

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** Stable JSON: object keys sorted, arrays keep order. Throws on values that have no canonical form. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value, "$"));
}

function normalise(v: unknown, path: string): unknown {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`canonicalJson: non-finite number at ${path}`);
    return v;
  }
  if (Array.isArray(v)) return v.map((x, i) => normalise(x, `${path}[${i}]`));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x === undefined) throw new Error(`canonicalJson: undefined at ${path}.${k}`);
      out[k] = normalise(x, `${path}.${k}`);
    }
    return out;
  }
  throw new Error(`canonicalJson: unsupported ${typeof v} at ${path}`);
}

export const hashJson = (value: unknown): string => sha256Hex(canonicalJson(value));
