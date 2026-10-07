// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "./sha256";
import { clamp, gammaQ, logGamma, negBinSf, normalSf, poissonSf, round, zFromUpperTail } from "./numerics";

const golden = JSON.parse(readFileSync(join(process.cwd(), "src", "detection", "__fixtures__", "numerics.golden.json"), "utf8"));
const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);

describe("numerics vs scipy goldens", () => {
  it("logGamma", () => {
    for (const { x, v } of golden.gammaln) expect(rel(logGamma(x), v) < 1e-12 || Math.abs(logGamma(x) - v) < 1e-12, `x=${x}`).toBe(true);
  });

  it("Poisson upper tail P(X >= k)", () => {
    for (const { k, mu, sf } of golden.poisson_sf) expect(rel(poissonSf(k, mu), sf), `k=${k} mu=${mu}`).toBeLessThan(1e-10);
  });

  it("negative-binomial (Gamma-Poisson predictive) upper tail P(X >= k) with real r", () => {
    for (const { k, r, q, sf } of golden.negbin_sf) expect(rel(negBinSf(k, r, q), sf), `k=${k} r=${r} q=${q}`).toBeLessThan(1e-10);
  });

  it("normal upper-tail inverse", () => {
    for (const { p, z } of golden.normal_isf) expect(Math.abs(zFromUpperTail(p) - z), `p=${p}`).toBeLessThan(1e-8);
  });
});

describe("numerics properties and edge cases", () => {
  it("closed-form check: P(Poisson(2) >= 5) = 1 - 7e^-2", () => {
    expect(Math.abs(poissonSf(5, 2) - (1 - 7 * Math.exp(-2)))).toBeLessThan(1e-14);
  });

  it("tails are monotone: more observed => smaller p; larger expectation => larger p", () => {
    for (let k = 1; k < 40; k++) {
      expect(poissonSf(k + 1, 3)).toBeLessThan(poissonSf(k, 3));
      expect(negBinSf(k + 1, 4.5, 0.7)).toBeLessThan(negBinSf(k, 4.5, 0.7));
    }
    expect(poissonSf(6, 4)).toBeGreaterThan(poissonSf(6, 2));
    expect(negBinSf(6, 4.5, 0.5)).toBeGreaterThan(negBinSf(6, 4.5, 0.9));
  });

  it("handles degenerate inputs", () => {
    expect(poissonSf(0, 1)).toBe(1);
    expect(poissonSf(-3, 1)).toBe(1);
    expect(poissonSf(3, 0)).toBe(0);
    expect(negBinSf(0, 2, 0.5)).toBe(1);
    expect(negBinSf(3, 2, 1)).toBe(0);
    expect(() => negBinSf(3, 0, 0.5)).toThrow(RangeError);
    expect(() => logGamma(0)).toThrow(RangeError);
  });

  it("negative binomial converges to Poisson as the prior becomes precise", () => {
    // r = rate*beta, q = beta/(beta+Nw): beta -> infinity gives Poisson(rate*Nw)
    const rate = 0.8, nw = 5, beta = 1e6;
    expect(rel(negBinSf(9, rate * beta, beta / (beta + nw)), poissonSf(9, rate * nw))).toBeLessThan(1e-4);
  });

  it("extreme tails keep relative precision (no 1 - cdf cancellation)", () => {
    const p = poissonSf(60, 3);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1e-40);
    expect(normalSf(8)).toBeGreaterThan(0);
    expect(rel(normalSf(8), 6.22096057427178e-16)).toBeLessThan(1e-8);
  });

  it("helpers", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(round(1.23456789, 3)).toBe(1.235);
    expect(gammaQ(1, 2)).toBeCloseTo(Math.exp(-2), 12);
  });
});

describe("sha256 / canonical json", () => {
  it("matches node:crypto, including multi-block and non-ASCII input", () => {
    for (const s of ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "x".repeat(1000), "ଓଡ଼ିଶା ओडिशा ✓"]) {
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s).digest("hex"));
    }
  });

  it("canonicalJson is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(canonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }));
  });
});
