import { expect, test } from "bun:test";
import { safeMean, compensatedSum } from "./safe-mean";

test("safeMean: plain mean whenever the sum is finite, bit for bit", () => {
  for (const xs of [[0.1, 0.2, 0.3], [1, 2, 3, 4], [0.73, 0.5, 1e-9], [-5, 5, 1e300]]) {
    const plain = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(Object.is(safeMean(xs), plain)).toBe(true);
  }
});

test("safeMean: rows near Number.MAX_VALUE give their finite mean, not Infinity", () => {
  const M = Number.MAX_VALUE;
  expect(safeMean([M, M, M])).toBe(M);
  expect(safeMean([1e308, 1e308])).toBe(1e308);
  expect(safeMean([M, -M, M])).toBeCloseTo(M / 3, -300);
  expect(Number.isFinite(safeMean([M, M / 2, M / 4]))).toBe(true);
  expect(safeMean([-M, -M, -M])).toBe(-M);
});

test("compensatedSum keeps small terms a naive sum drops", () => {
  expect(compensatedSum([1, 1e100, 1, -1e100])).toBe(2);
});
