// Test harness: runs the REAL supabase/migrations on an in-process Postgres (PGlite, WASM) with
// minimal stand-ins for the Supabase-provided pieces (auth schema, auth.uid(), API roles).
// This exercises schema, constraints, triggers, RLS and privileged functions without Docker.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email varchar,
    raw_user_meta_data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  -- Mirrors Supabase's default privileges: new objects in public are granted to the API roles.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

export type Db = PGlite;

/** `stopBefore`: apply only migrations whose file name sorts before this prefix (schema-snapshot comparisons). */
export async function createDb(opts: { stopBefore?: string } = {}): Promise<Db> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && (!opts.stopBefore || f < opts.stopBefore))
    .sort();
  for (const f of files) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }
  // Test-the-tests hook: apply a deliberate weakening (mutation) and confirm the suite goes red.
  if (process.env.DB_TEST_MUTATION && !opts.stopBefore) await db.exec(process.env.DB_TEST_MUTATION);
  return db;
}

export interface Outcome<T = Record<string, unknown>> {
  rows: T[];
  affected: number;
  error?: { code?: string; message: string };
}

/** Run one statement and capture either rows or the error (never throws). */
export async function run<T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<Outcome<T>> {
  try {
    const r = await db.query<T>(sql, params);
    return { rows: r.rows, affected: r.affectedRows ?? 0 };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { rows: [], affected: 0, error: { code: err.code, message: err.message ?? String(e) } };
  }
}

/** Execute fn as an authenticated user (JWT sub = uid). */
export async function asUser<T>(db: Db, uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(
    `set role authenticated; select set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, role: "authenticated" })}', false);`,
  );
  try {
    return await fn();
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claims', '', false);`);
  }
}

export async function asAnon<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role anon;`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role;`);
  }
}

export async function asService<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role service_role;`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role;`);
  }
}

// ---- Deterministic fixture ids -------------------------------------------------------------
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

export const IDS = {
  // users
  citizenA: id(101),
  citizenB: id(102),
  clinician: id(103), // scoped to district D1
  officer1: id(104), // scoped to district D1
  officer2: id(105), // scoped to district D2
  officerNoScope: id(106), // officer role, NULL scope
  admin: id(107),
  // regions
  country: id(900),
  state: id(901),
  d1: id(911),
  d2: id(912),
  b1a: id(921),
  b1b: id(922),
  b2a: id(923),
  l1a1: id(931),
  l1a2: id(932),
  inactiveBlock: id(924),
};

/** Minimal geography + users used by most DB tests. Runs as the privileged connection. */
export async function seedFixture(db: Db): Promise<void> {
  await db.exec(`
    insert into public.regions (id, name, region_type, parent_region_id, administrative_code, is_synthetic) values
      ('${IDS.country}', 'India', 'country', null, 'T-IN', true),
      ('${IDS.state}', 'Odisha', 'state', '${IDS.country}', 'T-OD', true),
      ('${IDS.d1}', 'District One', 'district', '${IDS.state}', 'T-OD-1', true),
      ('${IDS.d2}', 'District Two', 'district', '${IDS.state}', 'T-OD-2', true),
      ('${IDS.b1a}', 'Block 1A', 'block', '${IDS.d1}', 'T-OD-1-A', true),
      ('${IDS.b1b}', 'Block 1B', 'block', '${IDS.d1}', 'T-OD-1-B', true),
      ('${IDS.b2a}', 'Block 2A', 'block', '${IDS.d2}', 'T-OD-2-A', true),
      ('${IDS.inactiveBlock}', 'Block Inactive', 'block', '${IDS.d2}', 'T-OD-2-X', true),
      ('${IDS.l1a1}', 'Locality 1A1', 'locality', '${IDS.b1a}', 'T-OD-1-A-1', true),
      ('${IDS.l1a2}', 'Locality 1A2', 'locality', '${IDS.b1a}', 'T-OD-1-A-2', true);
    update public.regions set active = false where id = '${IDS.inactiveBlock}';

    insert into auth.users (id, email, raw_user_meta_data) values
      ('${IDS.citizenA}', 'a@test.invalid', '{"display_name":"Citizen A"}'),
      ('${IDS.citizenB}', 'b@test.invalid', '{"display_name":"Citizen B"}'),
      ('${IDS.clinician}', 'c@test.invalid', '{"display_name":"Clinician"}'),
      ('${IDS.officer1}', 'o1@test.invalid', '{"display_name":"Officer 1"}'),
      ('${IDS.officer2}', 'o2@test.invalid', '{"display_name":"Officer 2"}'),
      ('${IDS.officerNoScope}', 'o0@test.invalid', '{"display_name":"Officer unscoped"}'),
      ('${IDS.admin}', 'ad@test.invalid', '{"display_name":"Admin"}');

    insert into public.user_roles (user_id, role, region_id) values
      ('${IDS.clinician}', 'clinician', '${IDS.d1}'),
      ('${IDS.officer1}', 'officer', '${IDS.d1}'),
      ('${IDS.officer2}', 'officer', '${IDS.d2}'),
      ('${IDS.officerNoScope}', 'officer', null),
      ('${IDS.admin}', 'admin', null);
  `);
}

/** A valid individual citizen report row (column list used for inserts). */
export function reportInsertSql(overrides: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    observed_at: `now() - interval '1 day'`,
    source_type: `'citizen'`,
    region_id: `'${IDS.b1a}'`,
    syndrome: `'acute_diarrhoeal_illness'`,
    symptom_codes: `array['diarrhoea','vomiting']`,
    severity: `'moderate'`,
    age_band: `'age_18_44'`,
    language: `'en'`,
  };
  const cols = { ...base, ...overrides };
  const names = Object.keys(cols);
  return `insert into public.health_reports (${names.join(", ")}) values (${names.map((n) => cols[n]).join(", ")}) returning id`;
}
