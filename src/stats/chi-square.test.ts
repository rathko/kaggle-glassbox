import { test, expect, setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000); // statistical tests can take seconds on a loaded machine (the bunfig preload alone did not always apply)
import { chiSquareCdf, chiSquareQuantile, chiSquareSurvival } from "./chi-square";

test("chiSquareQuantile at df=4 matches standard table values", () => {
  expect(chiSquareQuantile(0.975, 4)).toBeCloseTo(11.143, 2);
  expect(chiSquareQuantile(0.025, 4)).toBeCloseTo(0.484, 2);
});

test("chiSquareQuantile at df=10 matches standard table values", () => {
  expect(chiSquareQuantile(0.975, 10)).toBeCloseTo(20.483, 1);
  expect(chiSquareQuantile(0.025, 10)).toBeCloseTo(3.247, 1);
});

test("chiSquareCdf and chiSquareQuantile are inverses of each other", () => {
  const x = chiSquareQuantile(0.9, 6);
  expect(chiSquareCdf(x, 6)).toBeCloseTo(0.9, 3);
});

test("chiSquareCdf is 0 at x=0 and increases monotonically", () => {
  expect(chiSquareCdf(0, 5)).toBe(0);
  expect(chiSquareCdf(5, 5)).toBeLessThan(chiSquareCdf(10, 5));
});

test("rejects non-positive df or out-of-range p", () => {
  expect(() => chiSquareQuantile(0.5, 0)).toThrow();
  expect(() => chiSquareQuantile(0, 4)).toThrow();
  expect(() => chiSquareQuantile(1, 4)).toThrow();
  expect(() => chiSquareCdf(1, -1)).toThrow();
});

test("chiSquareSurvival keeps a far upper tail that 1 - CDF loses, and agrees with 1 - CDF elsewhere", () => {
  // df = 2: S(x) = exp(-x/2) exactly
  for (const x of [0.5, 3, 20, 80, 120]) expect(chiSquareSurvival(x, 2) / Math.exp(-x / 2)).toBeCloseTo(1, 10);
  expect(chiSquareSurvival(120, 2)).toBeGreaterThan(0); // 8.8e-27; 1 - CDF gives 0
  expect(1 - chiSquareCdf(120, 2)).toBe(0);
  // df = 10 at x = 100: e^-50 (1 + 50 + 50^2/2 + 50^3/6 + 50^4/24)
  expect(chiSquareSurvival(100, 10) / (Math.exp(-50) * (1 + 50 + 1250 + 50 ** 3 / 6 + 50 ** 4 / 24))).toBeCloseTo(1, 10);
  for (const [x, df] of [[3, 4], [10, 7], [0.2, 1]] as const) expect(chiSquareSurvival(x, df)).toBeCloseTo(1 - chiSquareCdf(x, df), 12);
  expect(chiSquareSurvival(0, 3)).toBe(1);
  let prev = 1;
  for (let x = 0.5; x < 60; x += 0.5) { const v = chiSquareSurvival(x, 5); expect(v).toBeLessThanOrEqual(prev); prev = v; }
});
