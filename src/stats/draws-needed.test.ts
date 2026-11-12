import { expect, test, setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000); // statistical tests can take seconds on a loaded machine (the bunfig preload alone did not always apply)
import { drawsNeeded, falsePassRate, passRate } from "./draws-needed.ts";

test("13 draws at SD 1.51 is just above 5% once ties pass", () => {
  expect(falsePassRate(13, 1.51, 1)).toBeGreaterThan(0.05);
  expect(falsePassRate(14, 1.51, 1)).toBeLessThan(0.05);
});

test("drawsNeeded finds 14 at the paper's SD and bar", () => {
  expect(drawsNeeded(1.51, 1, 0.05)).toBe(14);
});

test("a noisier stage needs more draws", () => {
  expect(drawsNeeded(1.72, 1, 0.05)).toBeGreaterThan(drawsNeeded(1.34, 1, 0.05));
});

test("passRate at effect 0 is the false-pass rate, and an effect exactly at the bar passes about half the time", () => {
  for (const n of [1, 4, 14]) expect(passRate(n, 1.5, 1, 0)).toBeCloseTo(falsePassRate(n, 1.5, 1), 12);
  expect(passRate(14, 1.5, 1, 1)).toBeGreaterThan(0.5);
  expect(passRate(14, 1.5, 1, 1)).toBeLessThan(0.6);
  expect(passRate(14, 1.5, 1, 2)).toBeGreaterThan(passRate(4, 1.5, 1, 2));
});

test("a fractional bar uses the next whole-task boundary: sd 1, bar 0.5, one draw is 36.2%, not 50%", () => {
  expect(falsePassRate(1, 1, 0.5)).toBeCloseTo(0.3618, 3);
  expect(drawsNeeded(1, 0.5, 0.4)).toBe(1);
  expect(falsePassRate(4, 1.5, 1)).toBeCloseTo(passRate(4, 1.5, 1, 0), 12);
});

test("a bar a hair above a whole-task boundary needs the next whole task", () => {
  expect(falsePassRate(10, 1, 0.10000000005)).toBeCloseTo(0.36866, 4);
});

test("a bar whose product with n rounds a hair above a whole number keeps that whole number: n 100, bar 0.07", () => {
  expect(falsePassRate(100, 1.5, 0.07)).toBeCloseTo(0.37965, 4);
});

test("the ulp snap never swallows a genuine fraction, even at a large n * bar", () => {
  // n * bar = 1e9 + 0.0005: the gate is ceil = 1e9 + 1, so a change of exactly that size passes about half the time
  expect(passRate(1000, 0.01, 1000000.0000005, 1000000.0000005)).toBeLessThan(0.2);
});

test("an extreme alpha is reached on the true normal tail, not where 1 - cdf rounds to zero (round 15)", () => {
  const { drawsNeeded: dn, falsePassRate: fpr } = require("./draws-needed");
  const { normalSurvival, normalCdf } = require("../noise-floor/noise-floor");
  expect(dn(1, 1, 1e-20, 1000, true)).toBe(172);
  expect(fpr(171, 1, 1, true)).toBeGreaterThan(1e-20);
  expect(normalSurvival(9.26)).toBeGreaterThan(1e-21);
  expect(1 - normalCdf(9.26)).toBe(0); // what the old tail gave
  // agrees with the CDF where both are precise
  for (const x of [-2, -0.3, 0, 0.7, 1.5, 3]) expect(Math.abs(normalSurvival(x) - (1 - normalCdf(x)))).toBeLessThan(5e-7);
  expect(normalSurvival(5)).toBeCloseTo(2.866515719e-7, 12);
});

test("a tail of exactly 1/2 is not below alpha 0.5, but any positive z is: one run suffices at a vast SD", () => {
  expect(drawsNeeded(1e12, 1, 0.5, 1000, true)).toBe(1);
  expect(drawsNeeded(1, 1, 1e-20, 1000, true)).toBe(172);
});
