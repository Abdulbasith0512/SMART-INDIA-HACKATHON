// Canonical serialisation and hashing of the evidence bundle.
//
//   bundle_hash = SHA-256( canonical JSON of the bundle WITHOUT `bundle_hash` and `retrieved_at` )
//
// Canonical JSON here means: object keys sorted by code point; array order exactly as built (the builder emits
// arrays in a fixed semantic order, never database order); every string and key normalised to Unicode NFC;
// numbers finite and serialised by JSON.stringify (negative zero becomes 0); no undefined values. The bundle holds
// no random ids and no clock values besides `retrieved_at`, which is excluded from the hash, so the same signal +
// corpus + configuration + as-of date always produces byte-identical canonical JSON and the same hash.
import { sha256Hex } from "../hash";
import { compareCodePoints } from "../retrieval/tokenize";

/** Fields that are never part of the hash: the hash itself and the wall-clock time of the build. */
export const HASH_EXCLUDED_FIELDS = ["bundle_hash", "retrieved_at"] as const;

function normalise(v: unknown, path: string): unknown {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "string") return v.normalize("NFC");
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`canonical bundle: non-finite number at ${path}`);
    return Object.is(v, -0) ? 0 : v;
  }
  if (Array.isArray(v)) return v.map((x, i) => normalise(x, `${path}[${i}]`));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(v as Record<string, unknown>).map(([k, x]) => [k.normalize("NFC"), x] as const).sort((a, b) => compareCodePoints(a[0], b[0]));
    for (let i = 1; i < entries.length; i += 1) if (entries[i][0] === entries[i - 1][0]) throw new Error(`canonical bundle: duplicate key after normalisation at ${path}.${entries[i][0]}`);
    for (const [k, x] of entries) {
      if (x === undefined) throw new Error(`canonical bundle: undefined at ${path}.${k}`);
      out[k] = normalise(x, `${path}.${k}`);
    }
    return out;
  }
  throw new Error(`canonical bundle: unsupported ${typeof v} at ${path}`);
}

/** Canonical JSON of the hashed part of a bundle (hash and retrieved_at are dropped if present). */
export function canonicalBundleJson(bundle: object): string {
  const body: Record<string, unknown> = { ...(bundle as Record<string, unknown>) };
  for (const f of HASH_EXCLUDED_FIELDS) delete body[f];
  return JSON.stringify(normalise(body, "$"));
}

export const bundleHashOf = (bundle: object): string => sha256Hex(canonicalBundleJson(bundle));

/** Deep camelCase -> snake_case for KEYS only (values are untouched). Idempotent on keys that are already snake_case. */
export function snakeKeys<T>(value: T): unknown {
  if (Array.isArray(value)) return value.map((x) => snakeKeys(x));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()] = snakeKeys(v);
    return out;
  }
  return value;
}
