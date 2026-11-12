import { test, expect, setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000); // statistical tests can take seconds on a loaded machine (the bunfig preload alone did not always apply)
import { regularizedIncompleteBeta, fCdf, fSurvival } from "./f-distribution";
import { binomialUpperTail } from "../noise-floor/noise-floor";

test("regularizedIncompleteBeta matches the exact binomial tail identity", () => {
  // P(X >= k) for X ~ Binomial(n, p) equals I_p(k, n - k + 1) for 1 <= k <= n. Cross-checks the
  // incomplete beta implementation against `binomialUpperTail`, an independently-tested exact
  // PMF sum, rather than against a second copy of the same approximation.
  for (const [n, k, p] of [[10, 3, 0.4], [20, 12, 0.3], [5, 1, 0.9], [15, 15, 0.2]] as const) {
    expect(regularizedIncompleteBeta(k, n - k + 1, p)).toBeCloseTo(binomialUpperTail(n, k, p), 9);
  }
});

test("regularizedIncompleteBeta boundary values", () => {
  expect(regularizedIncompleteBeta(2, 3, 0)).toBe(0);
  expect(regularizedIncompleteBeta(2, 3, 1)).toBe(1);
  expect(regularizedIncompleteBeta(1, 1, 0.5)).toBeCloseTo(0.5, 10); // Beta(1,1) is uniform
});

test("regularizedIncompleteBeta rejects invalid parameters", () => {
  expect(() => regularizedIncompleteBeta(0, 1, 0.5)).toThrow();
  expect(() => regularizedIncompleteBeta(1, 1, 1.5)).toThrow();
});

test("fSurvival matches standard published F-table critical values", () => {
  // Each pair is a published upper-5%/1% critical value: fSurvival at that value should read
  // back ~0.05 / ~0.01.
  expect(fSurvival(4.96, 1, 10)).toBeCloseTo(0.05, 2);
  expect(fSurvival(3.325, 5, 10)).toBeCloseTo(0.05, 2);
  expect(fSurvival(2.978, 10, 10)).toBeCloseTo(0.05, 2);
  expect(fSurvival(4.85, 10, 10)).toBeCloseTo(0.01, 2);
  expect(fSurvival(161.4, 1, 1)).toBeCloseTo(0.05, 2);
});

test("fCdf and fSurvival are complements", () => {
  expect(fCdf(2.3, 4, 20) + fSurvival(2.3, 4, 20)).toBeCloseTo(1, 10);
});

test("fSurvival at f=0 is 1, and decreases as f grows", () => {
  expect(fSurvival(0, 5, 10)).toBe(1);
  expect(fSurvival(1, 5, 10)).toBeGreaterThan(fSurvival(5, 5, 10));
});

test("fSurvival rejects non-positive degrees of freedom", () => {
  expect(() => fSurvival(1, 0, 10)).toThrow();
  expect(() => fSurvival(1, 10, -1)).toThrow();
});
