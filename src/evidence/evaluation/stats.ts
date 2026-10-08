// Small, deterministic statistics for the evaluation harness. Reuses the M3 harness' exact Clopper-Pearson interval and
// seeded percentile bootstrap. Rules that apply everywhere:
//   - a ratio with a zero denominator is `null` (undefined), never NaN and never silently 0 or 1;
//   - a confidence interval is reported only when n >= MIN_N_FOR_CI, because below that it is not statistically meaningful;
//   - every reported number is rounded to 6 decimals so artefacts are byte-stable.
import { bootstrapCi, clopperPearson, mean } from "../../evaluation/stats";

export const MIN_N_FOR_CI = 10;
export const BOOTSTRAP_RESAMPLES = 2000;
export const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** num / den, or null when den is 0. */
export const ratio = (num: number, den: number): number | null => (den === 0 ? null : round6(num / den));

export interface Rate {
  /** Numerator: units with the property. */
  k: number;
  /** Denominator: units that could have the property. */
  n: number;
  value: number | null;
  /** Exact (Clopper-Pearson) 95% interval; null when n < MIN_N_FOR_CI. */
  ci95: [number, number] | null;
}

export function rate(k: number, n: number): Rate {
  if (k < 0 || k > n) throw new RangeError(`rate: ${k}/${n}`);
  const ci = n >= MIN_N_FOR_CI ? clopperPearson(k, n) : null;
  return { k, n, value: ratio(k, n), ci95: ci ? [round6(ci[0]), round6(ci[1])] : null };
}

export interface MeanStat {
  /** Units with a defined value. */
  n: number;
  /** Units for which the metric is undefined (for example, no relevant evidence exists). */
  n_undefined: number;
  mean: number | null;
  /** Seeded percentile-bootstrap 95% interval over units; null when n < MIN_N_FOR_CI. */
  ci95: [number, number] | null;
}

export function meanStat(values: ReadonlyArray<number | null>, seed: string): MeanStat {
  const defined = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const n = defined.length;
  if (n === 0) return { n: 0, n_undefined: values.length, mean: null, ci95: null };
  const ci = n >= MIN_N_FOR_CI ? bootstrapCi(defined, mean, { b: BOOTSTRAP_RESAMPLES, seed }) : null;
  return { n, n_undefined: values.length - n, mean: round6(mean(defined)), ci95: ci ? [round6(ci[0]), round6(ci[1])] : null };
}

// ---------------------------------------------------------------------------------------------- agreement (judge validation)
export const LABELS = ["supported", "partially_supported", "unsupported"] as const;
export type Label = (typeof LABELS)[number];

/** Cohen's kappa for two raters over the same items, for any categorical labels. Null when undefined (no items, or chance agreement 1). */
export function kappaOf<T extends string | number>(a: readonly T[], b: readonly T[]): number | null {
  if (a.length !== b.length) throw new RangeError("kappa: rater lists differ in length");
  const n = a.length;
  if (n === 0) return null;
  let agree = 0;
  const ca = new Map<T, number>();
  const cb = new Map<T, number>();
  for (let i = 0; i < n; i += 1) {
    if (a[i] === b[i]) agree += 1;
    ca.set(a[i], (ca.get(a[i]) ?? 0) + 1);
    cb.set(b[i], (cb.get(b[i]) ?? 0) + 1);
  }
  const po = agree / n;
  let pe = 0;
  for (const [label, count] of ca) pe += (count / n) * ((cb.get(label) ?? 0) / n);
  if (pe >= 1) return null;
  return round6((po - pe) / (1 - pe));
}

/** Cohen's kappa for two raters over the three support labels. */
export const cohensKappa = (a: readonly Label[], b: readonly Label[]): number | null => kappaOf<Label>(a, b);
