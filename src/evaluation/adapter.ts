// Evaluation-side adapter: synthetic reports -> the DEIDENTIFIED feature rows the detector consumes.
// This mirrors what the service-side SQL function `detection_daily_features` produces from
// `deidentified_observations` (block + India-local day + syndrome). It deliberately drops everything that is
// not in the deidentified tier and carries NO synthetic/ground-truth marker into the detector.
import type { DetectorInput, FeatureRow, RegionNode, SourceKey } from "../detection/types";
import type { SyntheticDataset } from "../synthetic/generate";

const IST_OFFSET_MS = 5.5 * 3_600_000;
const istDate = (iso: string): string => new Date(Date.parse(iso) + IST_OFFSET_MS).toISOString().slice(0, 10);

export function datasetToDetectorInput(ds: SyntheticDataset, privacyK = 5): DetectorInput {
  const regions: RegionNode[] = ds.geography.regions.map((r) => ({
    id: r.id, type: r.region_type, parentId: r.parent_region_id, name: r.name,
  }));
  const byId = new Map(regions.map((r) => [r.id, r]));
  const blockOf = (id: string): string => {
    const r = byId.get(id)!;
    return r.type === "block" ? r.id : r.parentId!;
  };

  const cells = new Map<string, FeatureRow>();
  for (const rep of ds.reports) {
    const regionId = blockOf(rep.region_id);
    const date = istDate(rep.observed_at);
    const key = `${regionId}|${date}|${rep.syndrome}`;
    let row = cells.get(key);
    if (!row) {
      row = { regionId, date, syndrome: rep.syndrome, reports: 0, cases: 0, unknownSeverity: 0, bySource: {} };
      cells.set(key, row);
    }
    row.reports += 1;
    row.cases += rep.case_count;
    if (rep.severity === "unknown") row.unknownSeverity += 1;
    const src = rep.source_type as SourceKey;
    row.bySource[src] = (row.bySource[src] ?? 0) + 1;
  }
  const rows = [...cells.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.regionId < b.regionId ? -1 : a.regionId > b.regionId ? 1 : a.syndrome < b.syndrome ? -1 : 1));
  return { rows, regions, startDate: ds.startDate, endDate: ds.endDate, privacyK };
}
