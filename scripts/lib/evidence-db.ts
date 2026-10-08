// supabase-js (service role) implementation of the ingestion engine's table interface.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EvidenceDb, Row } from "../../src/evidence/ingest/ingest";

interface Result {
  data: Row[] | null;
  error: { message: string } | null;
}
interface Query extends PromiseLike<Result> {
  eq(column: string, value: unknown): Query;
  in(column: string, values: unknown[]): Query;
  is(column: string, value: null): Query;
  select(columns?: string): Query;
}
interface Loose {
  from(table: string): {
    select(columns: string): Query;
    insert(rows: Row[]): Query;
    update(patch: Row): Query;
  };
}

async function done(table: string, q: PromiseLike<Result>): Promise<Row[]> {
  const { data, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return data ?? [];
}

export function supabaseEvidenceDb(client: SupabaseClient): EvidenceDb {
  const c = client as unknown as Loose;
  const filter = (q: Query, match: Row): Query =>
    Object.entries(match).reduce((acc, [k, v]) => (v === null ? acc.is(k, null) : Array.isArray(v) ? acc.in(k, v) : acc.eq(k, v)), q);
  return {
    select: (table, match = {}, columns) => done(table, filter(c.from(table).select(columns?.length ? columns.join(",") : "*"), match)),
    insert: (table, rows) => done(table, c.from(table).insert(rows).select("*")),
    update: async (table, match, patch) => (await done(table, filter(c.from(table).update(patch), match).select("id"))).length,
  };
}
