import { test, expect, setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000); // statistical tests can take seconds on a loaded machine (the bunfig preload alone did not always apply)
import { mulberry32, shuffleInPlace } from "./seeded-random";

test("same seed produces the same sequence every time", () => {
  const a = mulberry32(42), b = mulberry32(42);
  const seqA = Array.from({ length: 10 }, () => a());
  const seqB = Array.from({ length: 10 }, () => b());
  expect(seqA).toEqual(seqB);
});

test("different seeds produce different sequences", () => {
  const a = mulberry32(1), b = mulberry32(2);
  const seqA = Array.from({ length: 5 }, () => a());
  const seqB = Array.from({ length: 5 }, () => b());
  expect(seqA).not.toEqual(seqB);
});

test("values stay in [0, 1)", () => {
  const rand = mulberry32(20261110);
  for (let i = 0; i < 10000; i++) {
    const v = rand();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  }
});

test("shuffleInPlace is a permutation (same multiset) and is deterministic for a fixed seed", () => {
  const original = [1, 2, 3, 4, 5, 6, 7, 8];
  const shuffledA = shuffleInPlace([...original], mulberry32(7));
  const shuffledB = shuffleInPlace([...original], mulberry32(7));
  expect(shuffledA.slice().sort((a, b) => a - b)).toEqual(original);
  expect(shuffledA).toEqual(shuffledB);
});

test("shuffleInPlace actually moves elements for a non-trivial array (not a silent no-op)", () => {
  const original = Array.from({ length: 20 }, (_, i) => i);
  const shuffled = shuffleInPlace([...original], mulberry32(20261110));
  expect(shuffled).not.toEqual(original);
});
