import { test, expect, setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000); // statistical tests can take seconds on a loaded machine (the bunfig preload alone did not always apply)
import { gatePasses, falsePass, combinations, bootstrapFp, sampleSd, mulberry32, mean } from "./aa-splits";

test("the gate reproduces a real 4-draw baseline bar: 5,3,5,4 (sd 0.96) needs a 3-draw mean >= 5.25", () => {
  const base = [5, 3, 5, 4];
  expect(sampleSd(base)).toBeCloseTo(0.957, 3);
  expect(gatePasses(base, [5, 5, 6])).toBe(true);
  expect(gatePasses(base, [5, 5, 5])).toBe(false);
  expect(gatePasses(base, [6, 5, 5, 5])).toBe(true); // exactly at the bar passes
});

test("the margin becomes sd/sqrt(n) when that exceeds 1", () => {
  const base = [0, 10, 0, 10]; // sd 5.77 -> 3.33 at n = 3
  expect(gatePasses(base, [8, 8, 8])).toBe(false);
  expect(gatePasses(base, [8, 8, 9])).toBe(true);
});

test("enumeration is exhaustive and ordered", () => {
  expect([...combinations(16, 4)].length).toBe(1820);
  expect(falsePass([1, 2, 3, 4, 5, 6, 7], 4, 3).pairs).toBe(35);
  expect(falsePass([4, 4, 4, 4, 4, 4, 4, 4], 4, 3).passes).toBe(0);
  expect(falsePass([0, 0, 0, 0, 10, 10, 10], 4, 3).passes).toBe(13);
});

test("bootstrap is seeded and brackets the point estimate", () => {
  const d = [5, 3, 5, 4, 6, 2, 4, 5, 3, 4, 6, 4];
  const a = bootstrapFp(d, 4, 3, 200, 300, 7);
  expect(a).toEqual(bootstrapFp(d, 4, 3, 200, 300, 7));
  const p = falsePass(d, 4, 3).fp;
  expect(a[0]!).toBeLessThanOrEqual(p);
  expect(a[1]!).toBeGreaterThanOrEqual(p);
  const r = mulberry32(1);
  for (let i = 0; i < 1000; i++) { const x = r(); expect(x >= 0 && x < 1).toBe(true); }
});

test("jackknife SE: zero for constant draws, positive for spread draws", async () => {
  const { jackknifeSe } = await import("./aa-splits");
  expect(jackknifeSe([4, 4, 4, 4, 4, 4, 4, 4], 4, 3)).toBe(0);
  expect(jackknifeSe([5, 3, 5, 4, 6, 2, 4, 5, 3, 4], 4, 3)).toBeGreaterThan(0);
});

test("quantile7 matches the R/NumPy default (linear interpolation)", async () => {
  const { quantile7 } = await import("./aa-splits");
  expect(quantile7([1, 2, 3, 4], 0.5)).toBe(2.5);
  expect(quantile7([1, 2, 3, 4, 5], 0.25)).toBe(2);
  expect(quantile7([0, 10], 0.025)).toBeCloseTo(0.25, 12);
});

test("jackknife refuses too few draws with a clear message", async () => {
  const { jackknifeSe } = await import("./aa-splits");
  expect(() => jackknifeSe([1, 2, 3, 4, 5, 6, 7], 4, 3)).toThrow(/at least 8 draws/);
});

test("falsePass scores a caller-supplied gate over the same splits", () => {
  const draws = [5, 4, 6, 5, 3, 5, 6];
  const always = falsePass(draws, 4, 3, 1, () => true), never = falsePass(draws, 4, 3, 1, () => false);
  expect(always.fp).toBe(1);
  expect(never.fp).toBe(0);
  expect(always.pairs).toBe(35);
  const fixedMargin = falsePass(draws, 4, 3, 1, (b, i) => mean(i) >= mean(b) + 2);
  expect(fixedMargin.fp).toBeLessThan(falsePass(draws, 4, 3, 1).fp + 1e-12);
});

test("the gate's tie slack scales with the operands: a tiny continuous bar is not swallowed, integer ties still pass", () => {
  // seven zero scores never clear a positive bar, however small (the old fixed 1e-12 slack passed 35 of 35)
  expect(falsePass([0, 0, 0, 0, 0, 0, 0], 4, 3, 1e-12).passes).toBe(0);
  // an exact integer tie at the bar passes
  expect(gatePasses([0, 0, 0, 0], [1, 1, 1], 1)).toBe(true);
  // a tie that only differs by rounding in the means passes too (0.1 + 0.2 vs 0.3)
  expect(gatePasses([0, 0, 0, 0], [0.1 + 0.2, 0.3, 0.3], 0.3)).toBe(true);
  // the shipped pre-registered study keeps its exact count
  expect(falsePass([4, 5, 5, 5, 2, 6, 3, 4, 5, 4, 4, 5, 4, 2, 8, 4], 4, 3).passes).toBe(80165);
});

test("finite scores whose sums or squared deviations overflow give the same false-pass rate as the rescaled data", () => {
  const big = [1e308, 1e308, 1e308, 1e308, 1.1e308, 1.1e308, 1.1e308];
  const small = big.map((x) => x / 1e308);
  expect(Number.isFinite(mean(big))).toBe(true);
  expect(mean(big) / 1e308).toBeCloseTo(mean(small), 12);
  expect(sampleSd(big) / 1e308).toBeCloseTo(sampleSd(small), 12);
  const fb = falsePass(big, 4, 3, 1e306), fs = falsePass(small, 4, 3, 0.01);
  expect(fb.passes).toBe(fs.passes);
  expect(fb.fp).toBeCloseTo(13 / 35, 15);
  // the plain path is untouched: ordinary values give exactly the plain arithmetic
  const xs = [5, 3, 5, 4];
  expect(mean(xs)).toBe((5 + 3 + 5 + 4) / 4);
  const m = 17 / 4;
  expect(sampleSd(xs)).toBe(Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / 3));
});

test("a large constant offset never lets an unchanged arm through: slack is a vanishing fraction of the margin", () => {
  // on raw values a few ulps of 1e15 is about 3.5, more than the bar of 1
  expect(gatePasses([1e15, 1e15], [1e15], 1)).toBe(false);
  expect(gatePasses([1e15, 1e15], [1e15 + 2], 1)).toBe(true);
  expect(gatePasses([1e15, 1e15 + 1, 1e15], [1e15 + 1], 1)).toBe(false);
  // the same data without the offset gives the same verdicts
  expect(gatePasses([0, 0], [2], 1)).toBe(true);
  expect(falsePass([1e15, 1e15, 1e15, 1e15, 1e15], 2, 1, 1).passes).toBe(0);
  // integer ties still pass exactly at the bar
  expect(gatePasses([4, 4], [5], 1)).toBe(true);
});

test("a verdict decided by rounding is refused rather than guessed", () => {
  // scores 1e15 apart against a margin of 1e-3: the shifted means carry rounding near 0.1, far above the margin's scale
  expect(() => gatePasses([0, 0], [1e15], 1e-3)).toThrow(/numerically indeterminate/);
});
