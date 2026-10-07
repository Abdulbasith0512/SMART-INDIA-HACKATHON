// Numerical primitives for the detector: deterministic, dependency-free, no I/O.
// Validated against scipy goldens (see numerics.test.ts and scripts/golden/gen_numerics_golden.py).

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

// Lanczos approximation (g = 7, n = 9), relative error ~1e-15 for x > 0.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

/** ln Γ(x) for x > 0. */
export function logGamma(x: number): number {
  if (!(x > 0)) throw new RangeError(`logGamma requires x > 0 (got ${x})`);
  if (x < 0.5) {
    // Reflection: Γ(x)Γ(1-x) = π / sin(πx)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const xm = x - 1;
  let a = LANCZOS[0];
  const t = xm + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (xm + i);
  return 0.5 * Math.log(2 * Math.PI) + (xm + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * P(X >= k) for X ~ Poisson(mu), integer k. Computed as an upper-tail sum (never 1 - cdf),
 * so extreme tails (1e-12 and below) keep full relative precision.
 */
export function poissonSf(k: number, mu: number): number {
  if (k <= 0) return 1;
  if (mu <= 0) return 0;
  let term = Math.exp(k * Math.log(mu) - mu - logGamma(k + 1)); // pmf(k)
  let sum = term;
  for (let j = k; j < k + 100000; j++) {
    term *= mu / (j + 1);
    sum += term;
    if (term < sum * 1e-17 && j > mu) break;
  }
  return Math.min(1, sum);
}

/**
 * P(X >= k) for X ~ NegativeBinomial(r, q): pmf(j) = Γ(j+r)/(Γ(r) j!) q^r (1-q)^j, real r > 0, q in (0,1].
 * This is the Gamma-Poisson posterior predictive: baseline rate ~ Gamma(shape r, rate beta),
 * window exposure N_w => X ~ NB(r, q = beta / (beta + N_w)).
 */
export function negBinSf(k: number, r: number, q: number): number {
  if (k <= 0) return 1;
  if (!(r > 0)) throw new RangeError(`negBinSf requires r > 0 (got ${r})`);
  if (q >= 1) return 0;
  if (q <= 0) return 1;
  const lq = Math.log(q);
  const l1q = Math.log1p(-q);
  let term = Math.exp(logGamma(k + r) - logGamma(r) - logGamma(k + 1) + r * lq + k * l1q); // pmf(k)
  let sum = term;
  const meanTail = (r * (1 - q)) / q;
  for (let j = k; j < k + 1000000; j++) {
    term *= ((j + r) / (j + 1)) * (1 - q);
    sum += term;
    if (term < sum * 1e-17 && j > meanTail) break;
  }
  return Math.min(1, sum);
}

// ---- regularised incomplete gamma (used for the normal tail) -----------------------------------
function gammaPSeries(a: number, x: number): number {
  let ap = a;
  let del = 1 / a;
  let sum = del;
  for (let n = 0; n < 1000; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * 1e-16) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

function gammaQContinuedFraction(a: number, x: number): number {
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** Regularised upper incomplete gamma Q(a, x). */
export function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  return x < a + 1 ? 1 - gammaPSeries(a, x) : gammaQContinuedFraction(a, x);
}

/** Standard normal upper tail P(Z >= z), z >= 0 (Q(1/2, z^2/2) / 2). */
export function normalSf(z: number): number {
  if (z <= 0) return 0.5 + 0.5 * (1 - gammaQ(0.5, (z * z) / 2));
  return 0.5 * gammaQ(0.5, (z * z) / 2);
}

/** z such that P(Z >= z) = p, for p in (0, 0.5]; deterministic bisection. */
export function zFromUpperTail(p: number): number {
  const pp = clamp(p, 1e-300, 0.5);
  let lo = 0;
  let hi = 40;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (normalSf(mid) > pp) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Round to a fixed number of decimals (used before persisting/hashing so output is reproducible). */
export const round = (x: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
};
