// Small, deterministic statistics helpers for the evaluation harness.
import { Rng } from "../synthetic/prng";

export const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
export const mean = (xs: readonly number[]): number => (xs.length ? sum(xs) / xs.length : NaN);

export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
export const median = (xs: readonly number[]): number => quantile(xs, 0.5);

// ---- exact (Clopper-Pearson) binomial interval, by bisection on the binomial tails --------------
function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i);
  return s;
}
function binomPmf(n: number, k: number, p: number): number {
  if (p <= 0) return k === 0 ? 1 : 0;
  if (p >= 1) return k === n ? 1 : 0;
  return Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p));
}
const binomCdf = (n: number, k: number, p: number): number => {
  let s = 0;
  for (let i = 0; i <= k; i++) s += binomPmf(n, i, p);
  return Math.min(1, s);
};

/** Exact two-sided (1 - alpha) interval for a binomial proportion k/n. */
export function clopperPearson(k: number, n: number, alpha = 0.05): [number, number] {
  if (n === 0) return [NaN, NaN];
  // Root of a monotone function f(p) = target on [0, 1].
  const bisect = (f: (p: number) => number, target: number, increasing: boolean): number => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      const above = f(mid) > target;
      if (above === increasing) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  };
  // lower: the p at which P(X >= k | p) = alpha/2 (increasing in p); upper: P(X <= k | p) = alpha/2 (decreasing in p)
  const lower = k === 0 ? 0 : bisect((p) => 1 - binomCdf(n, k - 1, p), alpha / 2, true);
  const upper = k === n ? 1 : bisect((p) => binomCdf(n, k, p), alpha / 2, false);
  return [lower, upper];
}

/** Percentile bootstrap CI of a statistic over resampled units (deterministic). */
export function bootstrapCi(units: readonly number[], stat: (xs: number[]) => number, opts: { b?: number; alpha?: number; seed?: string } = {}): [number, number] {
  const b = opts.b ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  if (units.length === 0) return [NaN, NaN];
  const rng = new Rng(opts.seed ?? "bootstrap");
  const vals: number[] = [];
  for (let i = 0; i < b; i++) {
    const sample: number[] = [];
    for (let j = 0; j < units.length; j++) sample.push(units[rng.int(0, units.length - 1)]);
    const v = stat(sample);
    if (Number.isFinite(v)) vals.push(v);
  }
  return [quantile(vals, alpha / 2), quantile(vals, 1 - alpha / 2)];
}

export const round = (x: number, d = 4): number => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);
