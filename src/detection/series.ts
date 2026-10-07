// Dense, zero-filled daily series built from deidentified feature rows.
// Only data up to the as-of day is ever READ by the detector; the arrays span the whole range for speed.
import { SOURCE_KEYS, type DetectorConfig, type DetectorInput, type SourceKey } from "./types";

export function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export class SeriesStore {
  readonly days: number;
  readonly startDate: string;
  readonly dates: string[];
  readonly dow: Uint8Array; // 0 = Sunday
  readonly blocks: string[]; // block ids, sorted
  readonly blockIndex = new Map<string, number>();
  readonly districts: string[]; // district ids, sorted
  readonly districtOfBlock: number[];
  readonly blocksOfDistrict: number[][];
  readonly names = new Map<string, string>();
  readonly syndromes: string[];
  readonly syndromeIndex = new Map<string, number>();
  readonly reports: Float64Array[][]; // [block][syndrome][day]
  readonly cases: Float64Array[][];
  readonly unknownSev: Float64Array[][];
  readonly sources: Float64Array[][][]; // [block][syndrome][sourceIdx][day]
  readonly blockTotal: Float64Array[]; // all syndromes, all sources
  readonly stateTotal: Float64Array;
  readonly stateTotalNonBulk: Float64Array;
  readonly stateBySyndrome: Float64Array[];
  readonly districtActive: Uint8Array[];
  readonly bulkIdx: number[];
  skippedRows = 0;

  constructor(input: DetectorInput, cfg: DetectorConfig) {
    this.startDate = input.startDate;
    const first = dayNumber(input.startDate);
    this.days = dayNumber(input.endDate) - first + 1;
    if (this.days < 1) throw new Error("endDate must not precede startDate");
    this.dates = Array.from({ length: this.days }, (_, i) => addDaysIso(input.startDate, i));
    this.dow = Uint8Array.from(this.dates, (d) => new Date(`${d}T00:00:00Z`).getUTCDay());

    const byId = new Map(input.regions.map((r) => [r.id, r]));
    for (const r of input.regions) this.names.set(r.id, r.name);
    const blockNodes = input.regions.filter((r) => r.type === "block").sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.blocks = blockNodes.map((b) => b.id);
    this.blocks.forEach((id, i) => this.blockIndex.set(id, i));
    const districtIds = [...new Set(blockNodes.map((b) => b.parentId).filter((x): x is string => !!x && byId.get(x)?.type === "district"))].sort();
    this.districts = districtIds;
    const dIdx = new Map(districtIds.map((id, i) => [id, i]));
    this.districtOfBlock = blockNodes.map((b) => dIdx.get(b.parentId ?? "") ?? -1);
    if (this.districtOfBlock.some((x) => x < 0)) throw new Error("every block must belong to a district");
    this.blocksOfDistrict = districtIds.map(() => []);
    this.districtOfBlock.forEach((d, bi) => this.blocksOfDistrict[d].push(bi));

    this.syndromes = cfg.syndromes;
    this.syndromes.forEach((s, i) => this.syndromeIndex.set(s, i));
    const nB = this.blocks.length;
    const nS = this.syndromes.length;
    const mk = () => new Float64Array(this.days);
    this.reports = Array.from({ length: nB }, () => Array.from({ length: nS }, mk));
    this.cases = Array.from({ length: nB }, () => Array.from({ length: nS }, mk));
    this.unknownSev = Array.from({ length: nB }, () => Array.from({ length: nS }, mk));
    this.sources = Array.from({ length: nB }, () => Array.from({ length: nS }, () => SOURCE_KEYS.map(mk)));
    this.blockTotal = Array.from({ length: nB }, mk);
    this.stateTotal = mk();
    this.stateTotalNonBulk = mk();
    this.stateBySyndrome = Array.from({ length: nS }, mk);
    this.districtActive = districtIds.map(() => new Uint8Array(this.days));
    this.bulkIdx = cfg.bulkSources.map((s) => SOURCE_KEYS.indexOf(s));

    for (const row of input.rows) {
      const bi = this.blockIndex.get(row.regionId);
      const d = dayNumber(row.date) - first;
      if (bi === undefined || d < 0 || d >= this.days) {
        this.skippedRows++;
        continue;
      }
      this.blockTotal[bi][d] += row.reports;
      this.stateTotal[d] += row.reports;
      let bulk = 0;
      for (const bIdx of this.bulkIdx) bulk += row.bySource[SOURCE_KEYS[bIdx] as SourceKey] ?? 0;
      this.stateTotalNonBulk[d] += row.reports - bulk;
      if (row.reports > 0) this.districtActive[this.districtOfBlock[bi]][d] = 1;
      const si = this.syndromeIndex.get(row.syndrome);
      if (si === undefined) continue;
      this.reports[bi][si][d] += row.reports;
      this.cases[bi][si][d] += row.cases;
      this.unknownSev[bi][si][d] += row.unknownSeverity;
      this.stateBySyndrome[si][d] += row.reports;
      SOURCE_KEYS.forEach((k, ki) => {
        this.sources[bi][si][ki][d] += row.bySource[k] ?? 0;
      });
    }
  }

  dayOf(iso: string): number {
    return dayNumber(iso) - dayNumber(this.startDate);
  }
}
