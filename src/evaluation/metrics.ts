// Aggregation of per-dataset evaluations into the reported metrics (with exact / bootstrap intervals).
import { Rng } from "../synthetic/prng";
import type { RunEvaluation } from "./match";
import { clopperPearson, mean, median, quantile, round } from "./stats";

export interface Proportion { k: number; n: number; value: number; ci95: [number, number] }

const prop = (k: number, n: number): Proportion => {
  const [lo, hi] = clopperPearson(k, n);
  return { k, n, value: n ? round(k / n) : NaN, ci95: [round(lo), round(hi)] };
};

function bootstrapRatio(pairs: Array<[number, number]>, seed: string, b = 2000): [number, number] {
  if (pairs.length === 0) return [NaN, NaN];
  const rng = new Rng(seed);
  const vals: number[] = [];
  for (let i = 0; i < b; i++) {
    let num = 0;
    let den = 0;
    for (let j = 0; j < pairs.length; j++) {
      const [a, d] = pairs[rng.int(0, pairs.length - 1)];
      num += a;
      den += d;
    }
    if (den > 0) vals.push(num / den);
  }
  return [quantile(vals, 0.025), quantile(vals, 0.975)];
}

function bootstrapMean(xs: number[], seed: string, b = 2000): [number, number] {
  if (xs.length === 0) return [NaN, NaN];
  const rng = new Rng(seed);
  const vals: number[] = [];
  for (let i = 0; i < b; i++) {
    let s = 0;
    for (let j = 0; j < xs.length; j++) s += xs[rng.int(0, xs.length - 1)];
    vals.push(s / xs.length);
  }
  return [quantile(vals, 0.025), quantile(vals, 0.975)];
}

export interface Summary {
  runs: number;
  clusters: { all: Proportion; evaluable: Proportion; lateOnly: number };
  delay: { n: number; median: number; q25: number; q75: number; mean: number; normalizedMedian: number };
  episodes: {
    total: number; tp: number; fp: number; precision: Proportion;
    falsePerRun: { mean: number; ci95: [number, number]; max: number; runsWithAny: number };
    falseSpurious: number; falseDecoy: number; fragmentsPerDetected: number;
  };
  units: { negatives: number; falsePositive: number; fpr: number; fprCi95: [number, number]; specificity: number; positiveUnits: number; unitSensitivity: number };
  decoys: { all: Proportion; byVariant: Record<string, Proportion> };
  localization: { n: number; meanJaccard: number; exactRate: number; meanOverreach: number; districtCorrect: number };
  priorityBands: Record<string, { episodes: number; tp: number; precision: number }>;
  byMultiplier: Record<string, Proportion>;
  bySyndrome: Record<string, Proportion>;
}

const multBucket = (m: number | null): string => (m === null ? "n/a" : m < 6 ? "<6" : m < 10 ? "6-10" : ">=10");

export function summarise(evals: readonly RunEvaluation[], seedLabel = "eval"): Summary {
  const trueEvents = evals.flatMap((r) => r.events.filter((e) => e.kind === "true_cluster"));
  const detected = trueEvents.filter((e) => e.detected);
  const evaluable = trueEvents.filter((e) => e.evaluable);
  const delays = detected.map((e) => e.delayDays!).filter((x) => x !== null);
  const norm = detected.map((e) => e.normalizedDelay!);

  const tp = evals.reduce((a, r) => a + r.tpEpisodes, 0);
  const fp = evals.reduce((a, r) => a + r.fpEpisodes, 0);
  const fpPerRun = evals.map((r) => r.fpEpisodes);
  const labels = evals.flatMap((r) => r.episodes);

  const negatives = evals.reduce((a, r) => a + r.units.negative, 0);
  const fpUnits = evals.reduce((a, r) => a + r.units.falsePositive, 0);
  const positives = evals.reduce((a, r) => a + r.units.positive, 0);
  const posAlarmed = evals.reduce((a, r) => a + r.units.positiveAlarmed, 0);

  const decoyEvents = evals.flatMap((r) => r.events.filter((e) => e.kind === "decoy_reporting_artifact"));
  const byVariant: Record<string, Proportion> = {};
  for (const v of [...new Set(decoyEvents.map((e) => e.variant ?? "default"))].sort()) {
    const ev = decoyEvents.filter((e) => (e.variant ?? "default") === v);
    byVariant[v] = prop(ev.filter((e) => !e.alerted).length, ev.length); // value = REJECTION rate
  }

  const loc = detected.map((e) => e.localization).filter((l): l is NonNullable<typeof l> => l !== null);

  const bands: Summary["priorityBands"] = {};
  for (const band of ["low", "medium", "high"]) {
    const ls = labels.filter((l) => l.priority === band);
    const t = ls.filter((l) => l.label === "TP").length;
    bands[band] = { episodes: ls.length, tp: t, precision: ls.length ? round(t / ls.length) : NaN };
  }
  const groupRecall = (key: (e: (typeof trueEvents)[number]) => string) => {
    const out: Record<string, Proportion> = {};
    for (const g of [...new Set(trueEvents.map(key))].sort()) {
      const evs = trueEvents.filter((e) => key(e) === g);
      out[g] = prop(evs.filter((e) => e.detected).length, evs.length);
    }
    return out;
  };

  return {
    runs: evals.length,
    clusters: {
      all: prop(detected.length, trueEvents.length),
      evaluable: prop(evaluable.filter((e) => e.detected).length, evaluable.length),
      lateOnly: trueEvents.filter((e) => e.lateDetected).length,
    },
    delay: {
      n: delays.length, median: round(median(delays), 2), q25: round(quantile(delays, 0.25), 2), q75: round(quantile(delays, 0.75), 2),
      mean: round(mean(delays), 2), normalizedMedian: round(median(norm), 3),
    },
    episodes: {
      total: tp + fp, tp, fp, precision: prop(tp, tp + fp),
      falsePerRun: { mean: round(mean(fpPerRun), 3), ci95: bootstrapMean(fpPerRun, `${seedLabel}|fp`).map((x) => round(x, 3)) as [number, number], max: Math.max(0, ...fpPerRun), runsWithAny: fpPerRun.filter((x) => x > 0).length },
      falseSpurious: labels.filter((l) => l.fpKind === "spurious").length,
      falseDecoy: labels.filter((l) => l.fpKind === "decoy").length,
      fragmentsPerDetected: detected.length ? round(evals.reduce((a, r) => a + r.fragments, 0) / detected.length, 3) : NaN,
    },
    units: {
      negatives, falsePositive: fpUnits, fpr: negatives ? fpUnits / negatives : NaN,
      fprCi95: bootstrapRatio(evals.map((r) => [r.units.falsePositive, r.units.negative]), `${seedLabel}|fpr`).map((x) => x) as [number, number],
      specificity: negatives ? 1 - fpUnits / negatives : NaN,
      positiveUnits: positives, unitSensitivity: positives ? round(posAlarmed / positives) : NaN,
    },
    decoys: { all: prop(decoyEvents.filter((e) => !e.alerted).length, decoyEvents.length), byVariant },
    localization: {
      n: loc.length, meanJaccard: round(mean(loc.map((l) => l.jaccard)), 3), exactRate: loc.length ? round(loc.filter((l) => l.exact).length / loc.length, 3) : NaN,
      meanOverreach: round(mean(loc.map((l) => l.overreach)), 3), districtCorrect: loc.length ? round(loc.filter((l) => l.jaccard > 0).length / loc.length, 3) : NaN,
    },
    priorityBands: bands,
    byMultiplier: groupRecall((e) => multBucket(e.multiplier)),
    bySyndrome: groupRecall((e) => e.syndrome),
  };
}
