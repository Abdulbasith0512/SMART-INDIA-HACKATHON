// The evaluation ORACLE: planted ground truth turned into day-indexed events with realised counts.
// Only the evaluator touches this. The detector never sees any of it.
import { addDays } from "../synthetic/prng";
import { START_DATE, type GroundTruthEvent, type SyntheticDataset } from "../synthetic/generate";

export interface OracleEvent {
  id: string;
  kind: "true_cluster" | "decoy_reporting_artifact";
  variant?: string;
  syndrome: string;
  shape: string;
  multiplier: number | null;
  blocks: string[]; // block region ids
  startDay: number; // inclusive, 0-based from START_DATE
  endDay: number; // inclusive
  durationDays: number;
  realizedReports: number; // reports in the window for this syndrome/blocks (background + injected)
  reportDays: number; // distinct days in the window with >= 1 such report
  /** True when the realised data in the window could in principle meet the evidence floor on >= 2 days. */
  evaluable: boolean;
}

const dayIndex = (iso: string): number => Math.round((Date.parse(iso) - Date.parse(START_DATE)) / 86_400_000);
const istDay = (iso: string): number => dayIndex(new Date(Date.parse(iso) + 5.5 * 3_600_000).toISOString().slice(0, 10));

export function buildOracle(ds: SyntheticDataset, evidenceFloor = 5, variants: Record<string, string> = {}): OracleEvent[] {
  const idByCode = new Map(ds.geography.regions.map((r) => [r.administrative_code, r.id]));
  const parent = new Map(ds.geography.regions.map((r) => [r.id, r.parent_region_id]));
  const type = new Map(ds.geography.regions.map((r) => [r.id, r.region_type]));
  const blockOf = (id: string): string => (type.get(id) === "block" ? id : parent.get(id)!);

  return ds.groundTruth.map((g: GroundTruthEvent) => {
    const blocks = g.region_codes.map((c) => idByCode.get(c)!).filter(Boolean);
    const startDay = dayIndex(g.start_date);
    const endDay = dayIndex(g.end_date);
    const days = new Set<number>();
    let realized = 0;
    for (const r of ds.reports) {
      if (r.syndrome !== g.syndrome) continue;
      const d = istDay(r.observed_at);
      if (d < startDay || d > endDay || !blocks.includes(blockOf(r.region_id))) continue;
      realized++;
      days.add(d);
    }
    return {
      id: g.id, kind: g.kind, variant: variants[g.id], syndrome: g.syndrome, shape: g.shape, multiplier: g.multiplier, blocks, startDay, endDay,
      durationDays: endDay - startDay + 1, realizedReports: realized, reportDays: days.size,
      evaluable: g.kind === "true_cluster" && realized >= evidenceFloor && days.size >= 2,
    };
  });
}

export const dayToDate = (d: number): string => addDays(START_DATE, d);
