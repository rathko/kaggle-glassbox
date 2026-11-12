import { test, expect, describe, setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000); // statistical tests can take seconds on a loaded machine (the bunfig preload alone did not always apply)
import { binomialSd, noiseFloor, twoProportionTest, perDrawSdFromPairedRescores, headToHeadBinomial, headToHeadNormal, falsePassRate, drawsForFalsePass, binomialUpperTail, heterogeneousCountSd, mcNemarExact, normalSurvival, scaledSumOfSquares } from "./noise-floor";

test("binomial SD at 120 tasks, p=0.15 is approximately 0.033", () => {
  expect(binomialSd(120, 0.15)).toBeCloseTo(0.0326, 3);
});

test("single-draw difference SD at 120 tasks, p=0.15 is approximately 0.046", () => {
  const { sdOfRate, sdOfSingleDrawDifference } = noiseFloor(120, 0.15);
  expect(sdOfRate).toBeCloseTo(0.0326, 3);
  expect(sdOfSingleDrawDifference).toBeCloseTo(0.0461, 3);
});

test("minDetectableDifference is 2x the single-draw-difference SD", () => {
  const nf = noiseFloor(120, 0.15);
  expect(nf.minDetectableDifference).toBeCloseTo(2 * nf.sdOfSingleDrawDifference, 10);
});

test("SD shrinks as n grows, for the same p", () => {
  expect(binomialSd(500, 0.15)).toBeLessThan(binomialSd(120, 0.15));
});

test("SD is 0 at the boundaries p=0 and p=1 (no variance left to measure)", () => {
  expect(binomialSd(100, 0)).toBe(0);
  expect(binomialSd(100, 1)).toBe(0);
});

test("binomialSd rejects invalid inputs", () => {
  expect(() => binomialSd(0, 0.5)).toThrow();
  expect(() => binomialSd(10, 1.5)).toThrow();
  expect(() => binomialSd(10, -0.1)).toThrow();
});

test("two-proportion test: identical rates give z near 0 and p near 1", () => {
  const { z, pValue } = twoProportionTest(18, 120, 18, 120);
  expect(z).toBeCloseTo(0, 6);
  expect(pValue).toBeCloseTo(1, 2);
});

test("two-proportion test: a large, consistent gap at reasonable n is significant", () => {
  // 30/120 (25%) vs 10/120 (8.3%) is a real, large gap.
  const { pValue, z } = twoProportionTest(30, 120, 10, 120);
  expect(Math.abs(z)).toBeGreaterThan(2);
  expect(pValue).toBeLessThan(0.05);
});

test("two-proportion test: a one-task difference at small n is not significant", () => {
  // 19/120 vs 18/120 is exactly the kind of noise this module exists to flag.
  const { pValue } = twoProportionTest(19, 120, 18, 120);
  expect(pValue).toBeGreaterThan(0.5);
});

test("two-proportion test rejects non-positive sample sizes", () => {
  expect(() => twoProportionTest(1, 0, 1, 10)).toThrow();
});

test("perDrawSdFromPairedRescores on diffs [+2,+2,-3,0] is approximately 1.46", () => {
  expect(perDrawSdFromPairedRescores([2, 2, -3, 0])).toBeCloseTo(1.46, 2);
});

test("perDrawSdFromPairedRescores on all-zero diffs is 0 (a perfectly reproducible grader)", () => {
  expect(perDrawSdFromPairedRescores([0, 0, 0])).toBe(0);
});

test("perDrawSdFromPairedRescores rejects an empty diff list", () => {
  expect(() => perDrawSdFromPairedRescores([])).toThrow();
});

test("headToHeadBinomial at n=58, p=0.18, +3 tasks is approximately win 0.718 / tie 0.072 / loss 0.210", () => {
  const { win, tie, loss } = headToHeadBinomial(58, 0.18, 3);
  expect(win).toBeCloseTo(0.718, 2);
  expect(tie).toBeCloseTo(0.072, 2);
  expect(loss).toBeCloseTo(0.210, 2);
  expect(win + tie + loss).toBeCloseTo(1, 9);
});

test("headToHeadBinomial with zero effect is symmetric (win ~= loss)", () => {
  const { win, loss } = headToHeadBinomial(58, 0.18, 0);
  expect(win).toBeCloseTo(loss, 6);
});

test("headToHeadBinomial rejects a rate pushed outside [0, 1]", () => {
  expect(() => headToHeadBinomial(10, 0.95, 2)).toThrow();
  expect(() => headToHeadBinomial(10, 1.5, 0)).toThrow();
});

test("headToHeadNormal with re-score SD 1.5 and +3 tasks is approximately win 0.92", () => {
  const { win, tie, loss } = headToHeadNormal(3, 1.5);
  expect(win).toBeCloseTo(0.92, 2);
  expect(tie).toBe(0);
  expect(win + loss).toBeCloseTo(1, 9);
});

test("headToHeadNormal with zero effect gives win 0.5 (a coin flip)", () => {
  expect(headToHeadNormal(0, 1.5).win).toBeCloseTo(0.5, 6);
});

test("headToHeadNormal with perDrawSd 0 is deterministic on the sign of the effect", () => {
  expect(headToHeadNormal(1, 0)).toEqual({ win: 1, tie: 0, loss: 0 });
  expect(headToHeadNormal(-1, 0)).toEqual({ win: 0, tie: 0, loss: 1 });
  expect(headToHeadNormal(0, 0)).toEqual({ win: 0, tie: 1, loss: 0 });
});

test("headToHeadNormal rejects a negative SD", () => {
  expect(() => headToHeadNormal(1, -1)).toThrow();
});

test("falsePassRate, same-block control, perDrawSd 1.56, bar 1: n=3 is approximately 0.216", () => {
  expect(falsePassRate({ perDrawSd: 1.56, bar: 1, drawsPerArm: 3, sameBlockControl: true })).toBeCloseTo(0.216, 2);
});

test("falsePassRate, same-block control, perDrawSd 1.56, bar 1: n=5 is approximately 0.155", () => {
  expect(falsePassRate({ perDrawSd: 1.56, bar: 1, drawsPerArm: 5, sameBlockControl: true })).toBeCloseTo(0.155, 2);
});

test("falsePassRate, fixed baseline, perDrawSd 1.56, bar 1: n=3 is approximately 0.133", () => {
  expect(falsePassRate({ perDrawSd: 1.56, bar: 1, drawsPerArm: 3, sameBlockControl: false })).toBeCloseTo(0.133, 2);
});

test("falsePassRate is lower for a fixed baseline than for same-block control, same n (only the candidate draws carry noise)", () => {
  const sameBlock = falsePassRate({ perDrawSd: 1.56, bar: 1, drawsPerArm: 4, sameBlockControl: true });
  const fixed = falsePassRate({ perDrawSd: 1.56, bar: 1, drawsPerArm: 4, sameBlockControl: false });
  expect(fixed).toBeLessThan(sameBlock);
});

test("falsePassRate decreases as drawsPerArm grows, holding everything else fixed", () => {
  const n3 = falsePassRate({ perDrawSd: 1.56, bar: 1, drawsPerArm: 3, sameBlockControl: true });
  const n10 = falsePassRate({ perDrawSd: 1.56, bar: 1, drawsPerArm: 10, sameBlockControl: true });
  expect(n10).toBeLessThan(n3);
});

test("falsePassRate rejects non-positive perDrawSd or drawsPerArm", () => {
  expect(() => falsePassRate({ perDrawSd: 0, bar: 1, drawsPerArm: 3, sameBlockControl: true })).toThrow();
  expect(() => falsePassRate({ perDrawSd: 1.56, bar: 1, drawsPerArm: 0, sameBlockControl: true })).toThrow();
});

test("drawsForFalsePass(0.05, same-block) finds the minimum draws per arm under perDrawSd 1.56, bar 1 — exactly 14 (hand-checked: n=13 gives ~0.0511, n=14 gives ~0.0449)", () => {
  const n = drawsForFalsePass(0.05, { perDrawSd: 1.56, bar: 1, sameBlockControl: true });
  expect(n).toBe(14);
  // the chosen n must actually clear the target, and one draw fewer must not.
  expect(falsePassRate({ perDrawSd: 1.56, bar: 1, drawsPerArm: n, sameBlockControl: true })).toBeLessThan(0.05);
  expect(falsePassRate({ perDrawSd: 1.56, bar: 1, drawsPerArm: n - 1, sameBlockControl: true })).toBeGreaterThanOrEqual(0.05);
});

test("drawsForFalsePass rejects a target outside (0, 1)", () => {
  expect(() => drawsForFalsePass(0, { perDrawSd: 1.56, bar: 1, sameBlockControl: true })).toThrow();
  expect(() => drawsForFalsePass(1, { perDrawSd: 1.56, bar: 1, sameBlockControl: true })).toThrow();
});

test("binomialUpperTail(10, 0, p) is 1 (X is always >= 0)", () => {
  expect(binomialUpperTail(10, 0, 0.3)).toBeCloseTo(1, 9);
});

test("binomialUpperTail(10, 11, p) is 0 (k above n is impossible)", () => {
  expect(binomialUpperTail(10, 11, 0.3)).toBe(0);
});

test("binomialUpperTail matches a hand-computable case: P(X >= 1) for n=1 is p", () => {
  expect(binomialUpperTail(1, 1, 0.3)).toBeCloseTo(0.3, 9);
});

test("binomialUpperTail(23, 4, p) is high when p is close to the observed rate (not a surprising count)", () => {
  // 4/23 is roughly 0.174; at a null rate in that neighborhood, seeing >= 4 should be unremarkable.
  const tail = binomialUpperTail(23, 4, 0.18);
  expect(tail).toBeGreaterThan(0.4);
});

test("binomialUpperTail rejects invalid inputs", () => {
  expect(() => binomialUpperTail(0, 0, 0.5)).toThrow();
  expect(() => binomialUpperTail(10, 1.5, 0.5)).toThrow();
  expect(() => binomialUpperTail(10, -1, 0.5)).toThrow();
  expect(() => binomialUpperTail(10, 1, 1.5)).toThrow();
});

describe("scope helpers: heterogeneous tasks and paired runs", () => {
  test("heterogeneousCountSd: zero when every task is certain, binomial when every rate is equal", () => {
    expect(heterogeneousCountSd([0, 1])).toBe(0); // the binomial model would say sqrt(2 * 0.25) = 0.707
    expect(heterogeneousCountSd([0.3, 0.3, 0.3, 0.3])).toBeCloseTo(binomialSd(4, 0.3) * 4, 12);
    expect(heterogeneousCountSd([0.1, 0.5, 0.9])).toBeLessThan(binomialSd(3, 0.5) * 3);
    expect(() => heterogeneousCountSd([])).toThrow();
    expect(() => heterogeneousCountSd([1.2])).toThrow();
  });
  test("mcNemarExact: hand-computed binomial tails", () => {
    expect(mcNemarExact(2, 8).pValue).toBeCloseTo(2 * (1 + 10 + 45) / 1024, 12); // 0.109
    expect(mcNemarExact(0, 5).pValue).toBeCloseTo(2 / 32, 12);
    expect(mcNemarExact(4, 4).pValue).toBe(1);
    expect(mcNemarExact(0, 0)).toEqual({ discordant: 0, pValue: 1 });
    expect(() => mcNemarExact(-1, 3)).toThrow();
    expect(() => mcNemarExact(1.5, 3)).toThrow();
  });
  test("counts outside [0, n] and fractional task numbers are rejected, not tested", () => {
    expect(() => twoProportionTest(-1, 10, 5, 10)).toThrow(); // used to give z = -3.35, p = 0.0008
    expect(() => twoProportionTest(11, 10, 5, 10)).toThrow();
    expect(() => twoProportionTest(1.5, 10, 5, 10)).toThrow();
    expect(() => binomialSd(10.5, 0.3)).toThrow();
    expect(() => binomialUpperTail(9.5, 2, 0.3)).toThrow();
    expect(() => headToHeadBinomial(10, Number.NaN, 1)).toThrow();
  });
});

test("McNemar stays fast and exact-in-shape for huge discordant counts", () => {
  const t = performance.now();
  expect(mcNemarExact(1, 99_999_999).pValue).toBe(0);
  expect(() => mcNemarExact(1, 1e9)).toThrow(/not supported/);
  const near = mcNemarExact(4e7, 4e7 + 10);
  expect(near.pValue).toBeGreaterThan(0.99);
  expect(performance.now() - t).toBeLessThan(2000);
  expect(mcNemarExact(2, 8).pValue).toBeCloseTo(0.109375, 10); // 2 * (1 + 10 + 45) / 1024
});

test("McNemar near the cap matches the normal tail where the imbalance is two SDs", () => {
  // m = 1e8, imbalance 2 SD = 2 * sqrt(1e8)/2 = 1e4 on each side of the half
  const p = mcNemarExact(5e7 - 1e4, 5e7 + 1e4).pValue;
  expect(p).toBeGreaterThan(0.044);
  expect(p).toBeLessThan(0.047);
});

test("twoProportionTest reads a far tail directly instead of rounding it to 0", () => {
  const { pValue, z } = twoProportionTest(0, 1000, 100, 1000);
  expect(pValue).toBeGreaterThan(0);
  expect(pValue).toBeLessThan(1e-20);
  // the same approximation evaluated directly: 2 * P(Z > |z|)
  expect(Math.abs(z)).toBeGreaterThan(10);
  // ordinary p-values are unchanged in substance
  expect(twoProportionTest(18, 120, 18, 120).pValue).toBeCloseTo(1, 6);
});

test("probabilities stay in [0, 1]: two-sided p clamped, head-to-head triple normalised to sum to 1", () => {
  expect(twoProportionTest(0, 10, 0, 10).pValue).toBe(1);
  for (let n = 1; n <= 40; n++) for (let a = 0; a <= n; a++) for (const b of [0, a, n]) {
    const t = twoProportionTest(b, n, a, n);
    expect(t.pValue).toBeGreaterThanOrEqual(0); expect(t.pValue).toBeLessThanOrEqual(1);
    const h = headToHeadBinomial(n, a / n, b - a);
    for (const v of [h.win, h.tie, h.loss]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    expect(Math.abs(h.win + h.tie + h.loss - 1)).toBeLessThan(1e-15);
  }
  const h = headToHeadBinomial(14, 1 / 14, 13); // the case that printed win 1.0000000000000004
  expect(h.win).toBeLessThanOrEqual(1);
  expect(h.loss).toBe(0);
  const hn = headToHeadNormal(1e6, 1);
  expect(hn.win).toBeLessThanOrEqual(1); expect(hn.loss).toBeGreaterThanOrEqual(0);
});

test("normalSurvival is exactly 1/2 at 0, strictly below 1/2 for any z > 0, and decreasing across the series/fit seam", () => {
  expect(normalSurvival(0)).toBe(0.5);
  expect(normalSurvival(-0)).toBe(0.5);
  for (const z of [1e-15, 1e-12, 1e-6, 0.1, 0.4999999, 0.5, 0.5000001, 1, 5]) expect(normalSurvival(z)).toBeLessThan(0.5);
  for (const z of [1e-12, 0.3, 2]) expect(normalSurvival(z) + normalSurvival(-z)).toBeCloseTo(1, 15);
  // known values (to well within the fit's 1.2e-7 relative error)
  expect(normalSurvival(0.25)).toBeCloseTo(0.40129367431707627, 15); // series branch: exact to double precision
  expect(normalSurvival(1.959963984540054)).toBeCloseTo(0.025, 8);
  let prev = 0.5;
  for (let z = 0; z <= 1; z += 1e-4) { const v = normalSurvival(z); expect(v).toBeLessThanOrEqual(prev); prev = v; }
});

test("paired re-score SD neither overflows nor underflows, and is bit-identical for ordinary diffs", () => {
  expect(perDrawSdFromPairedRescores([1e200])).toBeCloseTo(7.0710678118654744e199, -186);
  expect(Number.isFinite(perDrawSdFromPairedRescores([1e308, -1e308]))).toBe(true);
  expect(perDrawSdFromPairedRescores([1e-200, 2e-200])).toBeGreaterThan(0);
  const d = [1, -2, 1, 0];
  expect(perDrawSdFromPairedRescores(d)).toBe(Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length) / Math.SQRT2);
  expect(scaledSumOfSquares([3, 4])).toEqual({ scale: 1, sumSq: 25 });
  expect(() => scaledSumOfSquares([1, Infinity])).toThrow(/finite/);
});
