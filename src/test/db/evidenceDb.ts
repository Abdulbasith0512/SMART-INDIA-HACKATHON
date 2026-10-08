// PGlite implementation of the ingestion engine's table interface (tests run ingestion against the REAL
// migrated schema as the privileged connection, which is what the service role is in production).
import type { EvidenceDb, Row } from "@/evidence/ingest/ingest";
import type { Db } from "./harness";

const ident = (s: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`bad identifier ${s}`);
  return `"${s}"`;
};

/** Arrays go in as Postgres array literals so enum[] / text[] columns coerce them. */
const param = (v: unknown): unknown =>
  Array.isArray(v) ? `{${v.map((x) => `"${String(x).replace(/(["\\])/g, "\\$1")}"`).join(",")}}` : v === undefined ? null : v;

function where(match: Row, offset = 0): { sql: string; params: unknown[] } {
  const keys = Object.keys(match);
  const params: unknown[] = [];
  const parts = keys.map((k) => {
    if (match[k] === null) return `${ident(k)} is null`;
    params.push(param(match[k]));
    // An array value is an IN filter (compared as text so uuid / text / enum columns all work).
    return Array.isArray(match[k]) ? `${ident(k)}::text = any($${offset + params.length}::text[])` : `${ident(k)} = $${offset + params.length}`;
  });
  return { sql: parts.length ? ` where ${parts.join(" and ")}` : "", params };
}

/** PGlite returns enum[] columns as their text form ("{a,b}"); PostgREST returns JSON arrays. Normalise to arrays. */
const ARRAY_COLUMNS = ["syndromes", "topics", "verification_basis"];
function arrays(row: Row): Row {
  for (const k of ARRAY_COLUMNS) {
    const v = row[k];
    if (typeof v === "string" && v.startsWith("{") && v.endsWith("}")) row[k] = v === "{}" ? [] : v.slice(1, -1).split(",").map((s) => s.replace(/^"|"$/g, ""));
  }
  return row;
}

export function pgliteEvidenceDb(db: Db): EvidenceDb {
  return {
    async select(table, match = {}, columns) {
      const w = where(match);
      const cols = columns?.length ? columns.map(ident).join(", ") : "*";
      return (await db.query<Row>(`select ${cols} from public.${ident(table)}${w.sql}`, w.params)).rows.map(arrays);
    },
    async insert(table, rows) {
      const out: Row[] = [];
      for (const row of rows) {
        const keys = Object.keys(row);
        const r = await db.query<Row>(
          `insert into public.${ident(table)} (${keys.map(ident).join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
          keys.map((k) => param(row[k])),
        );
        out.push(arrays(r.rows[0]));
      }
      return out;
    },
    async update(table, match, patch) {
      const keys = Object.keys(patch);
      const w = where(match, keys.length);
      const r = await db.query(
        `update public.${ident(table)} set ${keys.map((k, i) => `${ident(k)} = $${i + 1}`).join(", ")}${w.sql}`,
        [...keys.map((k) => param(patch[k])), ...w.params],
      );
      return r.affectedRows ?? 0;
    },
  };
}
