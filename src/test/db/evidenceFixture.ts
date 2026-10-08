// Shared fixtures for the evidence DB tests (not a test file): a migrated PGlite database with Odisha-style regions,
// the development corpus ingested in a chosen order, and detector-shaped signal candidates.
import { hashJson } from "@/evidence/hash";
import { ingestCorpus } from "@/evidence/ingest/ingest";
import type { PreparedDocument } from "@/evidence/ingest/prepare";
import { createDb, seedFixture, type Db } from "./harness";
import { pgliteEvidenceDb } from "./evidenceDb";

const rid = (n: number) => `00000000-0000-0000-0000-00000000${String(n).padStart(4, "0")}`;
/** Region ids and names mirror src/evidence/retrieval/testkit.ts so DB-backed and in-memory runs are comparable. */
export const DBR = {
  country: rid(9101), state: rid(9102), khordha: rid(9103), ganjam: rid(9104), balianta: rid(9105), jatni: rid(9106), aska: rid(9107),
  otherState: rid(9108), otherDistrict: rid(9109),
};

export async function freshEvidenceDb(): Promise<Db> {
  const db = await createDb();
  await seedFixture(db);
  await db.exec(`
    insert into public.regions (id, name, region_type, parent_region_id, administrative_code, is_synthetic) values
      ('${DBR.country}', 'India (synthetic)', 'country', null, 'SYN-IN', true),
      ('${DBR.state}', 'Odisha', 'state', '${DBR.country}', 'SYN-OD', true),
      ('${DBR.khordha}', 'Khordha', 'district', '${DBR.state}', 'SYN-OD-KHO', true),
      ('${DBR.ganjam}', 'Ganjam', 'district', '${DBR.state}', 'SYN-OD-GAN', true),
      ('${DBR.balianta}', 'Balianta', 'block', '${DBR.khordha}', 'SYN-OD-KHO-BAL', true),
      ('${DBR.jatni}', 'Jatni', 'block', '${DBR.khordha}', 'SYN-OD-KHO-JAT', true),
      ('${DBR.aska}', 'Aska', 'block', '${DBR.ganjam}', 'SYN-OD-GAN-ASK', true),
      ('${DBR.otherState}', 'Elsewhere State', 'state', '${DBR.country}', 'SYN-XX', true),
      ('${DBR.otherDistrict}', 'Elsewhere District', 'district', '${DBR.otherState}', 'SYN-XX-D1', true);`);
  return db;
}

/**
 * Ingest documents ONE AT A TIME in the given order (predecessors of superseded editions are moved ahead of their
 * successors, the only ordering constraint). Used to give two databases different physical row orders and ids.
 */
export async function ingestInOrder(db: Db, prepared: readonly PreparedDocument[]): Promise<void> {
  const ordered = [...prepared];
  for (const p of [...ordered]) {
    if (!p.doc.supersedes) continue;
    const pred = ordered.findIndex((x) => x.doc.canonical_id === p.doc.supersedes);
    const me = ordered.findIndex((x) => x.doc.canonical_id === p.doc.canonical_id);
    if (pred > me) ordered.splice(me, 0, ...ordered.splice(pred, 1));
  }
  const edb = pgliteEvidenceDb(db);
  for (const p of ordered) {
    const r = await ingestCorpus(edb, [p], { corpusName: "order-test", now: () => "2026-01-01T00:00:00.000Z" });
    if (!r.ok) throw new Error(`ingest ${p.doc.canonical_id}: ${r.errors.join("; ")}`);
  }
}

export interface SignalSeed {
  id: string;
  regionId?: string;
  syndrome?: string;
  start?: string;
  end?: string;
  involved?: Array<{ id: string; name: string }>;
  components?: Record<string, unknown>;
}

/** Insert a candidate shaped exactly like the detector writes it, including counts and free text retrieval must NOT carry. */
export async function insertSignal(db: Db, s: SignalSeed): Promise<void> {
  const involved = s.involved ?? [{ id: DBR.balianta, name: "Balianta" }];
  await db.query(
    `insert into public.signal_candidates
       (id, region_id, time_window_start, time_window_end, syndrome, observed_value, baseline_value, deviation, signal_score, sample_count, minimum_sample_count,
        confidence, origin, explanation, episode_key, score_components, evidence)
     values ($1, $2, $3, $4, $5, 17, 4.2, 5.1, 81, 17, 5, 0.74, 'system_detector', $6, $7, $8::jsonb, $9::jsonb)`,
    [
      s.id, s.regionId ?? DBR.balianta, s.start ?? "2025-08-31T18:30:00Z", s.end ?? "2025-09-07T18:30:00Z", s.syndrome ?? "acute_diarrhoeal_illness",
      "Emerging signal requiring verification: 17 reports in Balianta (Khordha district). Human verification required.", hashJson(s.id),
      JSON.stringify({ involvedBlocks: involved.length, blocksInDistrict: 4, persistence: 0.8, priority: "high", note: "not a probability", ...(s.components ?? {}) }),
      JSON.stringify({ detector_version: "test", involved_blocks: involved, peak: { observed: 17, expected: 4.2, ratio: 4.05, p_value: 1e-6, window_days: 5 }, n_alarm_days: 4 }),
    ],
  );
}
