import { test, expect } from "bun:test";
import { quantisedScore, inferK, inferKRange } from "./score-quantisation";

test("quantisedScore floors 14/58 to 0.24", () => {
  expect(quantisedScore(14, 58, "floor")).toBe(0.24);
});

test("inferK recovers k=14 uniquely from score 0.24 at n=58 under floor", () => {
  expect(inferK(0.24, 58, "floor")).toEqual([14]);
});

test("quantisedScore floors 4/58 to 0.06", () => {
  expect(quantisedScore(4, 58, "floor")).toBe(0.06);
});

test("0.06 at n=58 is consistent with floor (k=4) but NOT with round", () => {
  expect(inferK(0.06, 58, "floor")).toContain(4);
  expect(quantisedScore(4, 58, "round")).not.toBe(0.06);
  expect(inferK(0.06, 58, "round")).not.toContain(4);
});

test("round can push a score up relative to floor for the same k", () => {
  // 4/58 = 6.8965...%; floor -> 6 -> 0.06, round -> 7 -> 0.07.
  expect(quantisedScore(4, 58, "round")).toBe(0.07);
});

test("quantisedScore rejects k outside [0, n] and non-positive n", () => {
  expect(() => quantisedScore(-1, 58)).toThrow();
  expect(() => quantisedScore(59, 58)).toThrow();
  expect(() => quantisedScore(1, 0)).toThrow();
});

test("inferK returns an empty array when no k is consistent with the score", () => {
  // n=3 can only ever floor to 0.00, 0.33, 0.66, or 1.00 — 0.50 matches none of them.
  expect(inferK(0.5, 3, "floor")).toEqual([]);
});

test("inferK rejects non-positive n", () => {
  expect(() => inferK(0.1, 0)).toThrow();
});

test("inferKRange agrees with a brute-force scan and stays fast for a huge n", async () => {
  const { inferKRange, quantisedScore } = await import("./score-quantisation");
  for (const n of [1, 3, 7, 58, 129, 300]) for (const mode of ["floor", "round"] as const) for (const dec of [1, 2, 3]) {
    for (let k = 0; k <= n; k++) {
      const shown = quantisedScore(k, n, mode, dec);
      const brute: number[] = [];
      for (let j = 0; j <= n; j++) if (quantisedScore(j, n, mode, dec) === shown) brute.push(j);
      expect(inferKRange(shown, n, mode, dec)).toEqual({ min: brute[0]!, max: brute[brute.length - 1]! });
    }
  }
  const t0 = performance.now();
  expect(inferKRange(0.5, 1_000_000_000, "floor", 2)).toEqual({ min: 500_000_000, max: 509_999_999 });
  expect(performance.now() - t0).toBeLessThan(50);
  expect(inferKRange(0.1725, 58, "floor", 4)).toBeNull();
});

test("bad quantisation inputs are rejected instead of matched", async () => {
  const { inferKRange, quantisedScore } = await import("./score-quantisation");
  expect(() => inferKRange(-0.001, 58, "floor", 2)).toThrow();
  expect(() => inferKRange(1.2, 58)).toThrow();
  expect(() => inferKRange(0.1725, 58, "floor", 2)).toThrow("decimal places");
  expect(() => inferKRange(0.17, 58.5)).toThrow();
  expect(() => inferKRange(0.17, 58, "up" as any)).toThrow();
  expect(() => quantisedScore(1.5, 10)).toThrow();
});

test("quantisation is exact for large counts and refuses unsafe task counts", () => {
  expect(quantisedScore(90000080, 90000090, "floor", 12)).toBe(0.999999888888);
  expect(() => inferKRange(0.5, 1e16)).toThrow(/2\^53/);
});

test("inferKRange terminates and is exact at the largest safe task count", () => {
  const r = inferKRange(0.5, Number.MAX_SAFE_INTEGER, "floor", 2)!;
  expect(r.min).toBe(Math.ceil(Number.MAX_SAFE_INTEGER / 2) - 0); // first k with floor(100k/n) >= 50
  expect(r.max).toBeGreaterThan(r.min);
});

test("inferKRange accepts a 12-decimal score whose float product carries rounding error (round 15)", () => {
  const { inferKRange: ikr } = require("./score-quantisation");
  expect(ikr(0.032250797363, 1_000_000_000_000, "floor", 12)).toEqual({ min: 32250797363, max: 32250797363 });
  expect(ikr(0.999999999999, 1_000_000_000_000, "floor", 12)).toEqual({ min: 999999999999, max: 999999999999 });
  // a genuinely finer score is still refused
  expect(() => ikr(0.0322507973635, 1_000_000_000_000, "floor", 12)).toThrow(/more than 12 decimal places/);
  expect(() => ikr(0.1725, 58, "floor", 3)).toThrow(/more than 3 decimal places/);
});
