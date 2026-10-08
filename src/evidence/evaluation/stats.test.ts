// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MIN_N_FOR_CI, cohensKappa, kappaOf, meanStat, ratio, rate } from "./stats";

describe("rate and ratio never produce NaN", () => {
  it("a zero denominator is null, not NaN, 0 or 1", () => {
    expect(ratio(0, 0)).toBeNull();
    const r = rate(0, 0);
    expect(r.value).toBeNull();
    expect(r.ci95).toBeNull();
    expect(r.k).toBe(0);
    expect(r.n).toBe(0);
  });

  it("reports k, n and value, and an exact interval only from n >= 10", () => {
    const small = rate(3, MIN_N_FOR_CI - 1);
    expect(small.value).toBe(0.333333);
    expect(small.ci95).toBeNull();
    const big = rate(3, MIN_N_FOR_CI);
    expect(big.value).toBe(0.3);
    expect(big.ci95).not.toBeNull();
    const [lo, hi] = big.ci95!;
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(lo).toBeLessThan(0.3);
    expect(hi).toBeGreaterThan(0.3);
  });

  it("the interval of 0/n has a lower bound of 0 and a positive upper bound (zero events do not prove a zero rate)", () => {
    const r = rate(0, 100);
    expect(r.ci95![0]).toBe(0);
    expect(r.ci95![1]).toBeGreaterThan(0);
  });

  it("rejects an impossible count", () => {
    expect(() => rate(5, 3)).toThrow(RangeError);
    expect(() => rate(-1, 3)).toThrow(RangeError);
  });
});

describe("meanStat", () => {
  it("excludes undefined units and counts them, never treating them as 0 or 1", () => {
    const s = meanStat([1, 2, 3, null], "seed");
    expect(s.n).toBe(3);
    expect(s.n_undefined).toBe(1);
    expect(s.mean).toBe(2);
    expect(s.ci95).toBeNull();
  });

  it("is null (not NaN) when every unit is undefined", () => {
    expect(meanStat([null, null], "s")).toEqual({ n: 0, n_undefined: 2, mean: null, ci95: null });
    expect(meanStat([], "s").mean).toBeNull();
  });

  it("gives a deterministic bootstrap interval around the mean once n >= 10", () => {
    const xs = [0.1, 0.4, 0.5, 0.9, 1, 0.3, 0.7, 0.6, 0.2, 0.8, 0.5, 0.45];
    const a = meanStat(xs, "same");
    const b = meanStat(xs, "same");
    expect(a).toEqual(b);
    expect(a.ci95).not.toBeNull();
    expect(a.ci95![0]).toBeLessThanOrEqual(a.mean!);
    expect(a.ci95![1]).toBeGreaterThanOrEqual(a.mean!);
  });
});

describe("Cohen's kappa", () => {
  it("is 1 for perfect agreement across more than one label", () => {
    expect(cohensKappa(["supported", "unsupported", "supported"], ["supported", "unsupported", "supported"])).toBe(1);
  });

  it("is 0 when agreement is exactly what chance predicts", () => {
    expect(cohensKappa(["supported", "supported", "unsupported", "unsupported"], ["supported", "unsupported", "supported", "unsupported"])).toBe(0);
  });

  it("matches a hand-computed value: po 0.75, pe 0.5 -> 0.5", () => {
    expect(cohensKappa(["supported", "supported", "supported", "unsupported"], ["supported", "supported", "unsupported", "unsupported"])).toBe(0.5);
  });

  it("is negative when raters systematically disagree", () => {
    expect(cohensKappa(["supported", "unsupported"], ["unsupported", "supported"])).toBe(-1);
  });

  it("is undefined (null) with no items or when both raters are constant", () => {
    expect(cohensKappa([], [])).toBeNull();
    expect(cohensKappa(["supported", "supported"], ["supported", "supported"])).toBeNull();
  });

  it("rejects raters over different numbers of items", () => {
    expect(() => cohensKappa(["supported"], [])).toThrow(RangeError);
  });

  it("works for numeric grades too", () => {
    expect(kappaOf<number>([0, 1, 2, 2], [0, 1, 2, 2])).toBe(1);
  });
});
