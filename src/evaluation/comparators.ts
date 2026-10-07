// Comparator detectors, used ONLY as benchmarks on the same data and the same metrics as the real detector.
// Parameters are the textbook/naive defaults, not tuned on any oracle.
import type { DetectorInput } from "../detection/types";
import { addDaysIso, dayNumber } from "../detection/series";
import type { EvalEpisode } from "./match";

interface Cells { days: number; blocks: string[]; series: Map<string, Float64Array> }

function cellsOf(input: DetectorInput, syndromes: string[]): Cells {
  const days = dayNumber(input.endDate) - dayNumber(input.startDate) + 1;
  const blocks = input.regions.filter((r) => r.type === "block").map((r) => r.id).sort();
  const series = new Map<string, Float64Array>();
  for (const b of blocks) for (const s of syndromes) series.set(`${b}|${s}`, new Float64Array(days));
  for (const r of input.rows) {
    const a = series.get(`${r.regionId}|${r.syndrome}`);
    if (a) a[dayNumber(r.date) - dayNumber(input.startDate)] += r.reports;
  }
  return { days, blocks, series };
}

function toEpisodes(name: string, alarmDays: Map<string, number[]>, maxGap = 2): EvalEpisode[] {
  const out: EvalEpisode[] = [];
  for (const [cell, days] of [...alarmDays.entries()].sort()) {
    const [block, syndrome] = cell.split("|");
    let cur: EvalEpisode | null = null;
    for (const d of [...days].sort((a, b) => a - b)) {
      if (cur && d - cur.lastAlarmDay <= maxGap + 1) {
        cur.lastAlarmDay = d;
        cur.alarms.push({ day: d, windowStart: d, windowEnd: d, involved: [block] });
      } else {
        cur = { id: `${name}|${cell}|${d}`, syndrome, firstAlarmDay: d, lastAlarmDay: d, involved: [block], alarms: [{ day: d, windowStart: d, windowEnd: d, involved: [block] }] };
        out.push(cur);
      }
    }
  }
  return out;
}

/** Naive rule: alarm whenever a block reports at least `threshold` observations of a syndrome in one day. */
export function fixedThresholdEpisodes(input: DetectorInput, syndromes: string[], threshold = 5): EvalEpisode[] {
  const { days, blocks, series } = cellsOf(input, syndromes);
  const alarms = new Map<string, number[]>();
  for (const b of blocks) for (const s of syndromes) {
    const y = series.get(`${b}|${s}`)!;
    for (let d = 0; d < days; d++) if (y[d] >= threshold) (alarms.get(`${b}|${s}`) ?? alarms.set(`${b}|${s}`, []).get(`${b}|${s}`)!).push(d);
  }
  return toEpisodes("fixed", alarms);
}

/** EARS-C2 style: z = (y - mean) / sd over a 7-day baseline ending 3 days earlier; alarm if z > 3 (sd floored at 1). */
export function earsC2Episodes(input: DetectorInput, syndromes: string[], z = 3): EvalEpisode[] {
  const { days, blocks, series } = cellsOf(input, syndromes);
  const alarms = new Map<string, number[]>();
  for (const b of blocks) for (const s of syndromes) {
    const y = series.get(`${b}|${s}`)!;
    for (let d = 9; d < days; d++) {
      const base = Array.from({ length: 7 }, (_, i) => y[d - 9 + i]);
      const mu = base.reduce((a, c) => a + c, 0) / 7;
      const sd = Math.sqrt(base.reduce((a, c) => a + (c - mu) ** 2, 0) / 6);
      if ((y[d] - mu) / Math.max(sd, 1) > z) (alarms.get(`${b}|${s}`) ?? alarms.set(`${b}|${s}`, []).get(`${b}|${s}`)!).push(d);
    }
  }
  return toEpisodes("c2", alarms);
}

export { addDaysIso };
