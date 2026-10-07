// Independent held-out replicate datasets: randomised planted clusters and decoy variants.
// The distributions below are fixed a priori and documented in docs/M3-EVALUATION.md.
import { Rng } from "../synthetic/prng";
import { generateGeography } from "../synthetic/geography";
import { DAYS, type EventInput, type SourceTypeLike } from "./replicateTypes";

export const SEED_SPLITS = {
  /** Used freely while building and calibrating (null runs, alpha sanity, debugging). */
  devNull: range(1, 50),
  devReplicates: range(101, 150),
  /** Held out: not inspected during development; used once for the reported results. */
  testReplicates: range(1001, 1200),
  testNull: range(2001, 2200),
} as const;

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

const SYNDROMES = ["acute_diarrhoeal_illness", "fever", "fever_with_rash", "jaundice", "respiratory_illness"] as const;

export type DecoyVariant = "bulk_import_1d" | "bulk_import_3d" | "clinic_batch_1d" | "clinic_batch_3d";

const DECOY_SPEC: Record<DecoyVariant, { days: number; perDay: number; source: SourceTypeLike }> = {
  bulk_import_1d: { days: 1, perDay: 40, source: "imported_dataset" },
  bulk_import_3d: { days: 3, perDay: 25, source: "imported_dataset" },
  clinic_batch_1d: { days: 1, perDay: 30, source: "clinician" },
  clinic_batch_3d: { days: 3, perDay: 20, source: "clinician" },
};

export interface ReplicateMeta {
  decoyVariants: Record<string, DecoyVariant>;
}

/** 4 true clusters + 2 decoys (one bulk-import variant, one clinic-batch variant), all randomised from the seed. */
export function randomEvents(seed: number): { events: EventInput[]; meta: ReplicateMeta } {
  const rng = new Rng(`replicate|${seed}`);
  const geo = generateGeography();
  const districts = [...new Set(geo.blocks.map((b) => b.districtCode))];
  const blocksOf = (d: string) => geo.blocks.filter((b) => b.districtCode === d).map((b) => b.region.administrative_code);

  const events: EventInput[] = [];
  // Decoys keep a margin of (longest detector window + 2) from true clusters of the same syndrome/block so lagging
  // true-cluster alarms can never be confused with decoy alerts.
  const clash = (syndrome: string, codes: string[], start: number, end: number, margin: number) =>
    events.some((e) => e.syndrome === syndrome && e.region_codes.some((c) => codes.includes(c)) && start <= e.end_day + margin && end >= e.start_day - margin);

  const place = (build: (start: number, end: number, codes: string[], syndrome: EventInput["syndrome"]) => EventInput, minDur: number, maxDur: number, twoBlocks: boolean, margin = 7) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const syndrome = rng.pick(SYNDROMES);
      const d = rng.pick(districts);
      const pool = blocksOf(d);
      const first = rng.pick(pool);
      const codes = twoBlocks && rng.next() < 0.4 ? [first, rng.pick(pool.filter((c) => c !== first))] : [first];
      const dur = rng.int(minDur, maxDur);
      const start = rng.int(24, Math.min(70, DAYS - 1 - dur));
      const end = start + dur - 1;
      if (clash(syndrome, codes, start, end, margin)) continue;
      events.push(build(start, end, codes, syndrome));
      return;
    }
    throw new Error(`could not place event for seed ${seed}`);
  };

  for (let i = 1; i <= 4; i++) {
    place((start, end, codes, syndrome) => ({
      id: `P${i}`, kind: "true_cluster", description: `randomised cluster ${i}`, syndrome, region_codes: codes,
      start_day: start, end_day: end, shape: rng.next() < 0.7 ? "plateau" : "ramp",
      multiplier: Math.round((4 + rng.next() * 11) * 10) / 10, severity_shift: true,
    }), 5, 12, true);
  }

  const meta: ReplicateMeta = { decoyVariants: {} };
  const bulkVariant: DecoyVariant = rng.next() < 0.5 ? "bulk_import_1d" : "bulk_import_3d";
  const clinicVariant: DecoyVariant = rng.next() < 0.5 ? "clinic_batch_1d" : "clinic_batch_3d";
  for (const [id, variant] of [["DA", bulkVariant], ["DB", clinicVariant]] as const) {
    const spec = DECOY_SPEC[variant];
    meta.decoyVariants[id] = variant;
    place((start, _end, codes, syndrome) => ({
      id, kind: "decoy_reporting_artifact", description: `decoy ${variant}`, syndrome, region_codes: [codes[0]],
      start_day: start, end_day: start + spec.days - 1, shape: spec.days === 1 ? "single_day_burst" : "multi_day_burst",
      multiplier: null, severity_shift: false, burst_reports: spec.perDay, burst_source: spec.source as EventInput["burst_source"],
    }), spec.days, spec.days, false, 16);
  }
  return { events, meta };
}
