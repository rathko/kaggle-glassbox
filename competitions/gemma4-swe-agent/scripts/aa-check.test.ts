import { test, expect, setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000); // statistical tests can take seconds on a loaded machine (the bunfig preload alone did not always apply)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aaThroughGate, latticeBoundary } from "./aa-check.ts";
import { binomialFlips } from "./gradeable.ts";

const ROOT = join(import.meta.dir, "..");

function unchangedBlocks(): Map<string, { draws: number; mean: number }[]> {
  const draws = new Map<string, Set<string>>(), sums = new Map<string, number>();
  for (const line of readFileSync(join(ROOT, "data/flaky10-task-outcomes.csv"), "utf8").trim().split("\n").slice(1)) {
    const [d, p, b, , r] = line.split(",");
    if (!["V26", "V28", "V31"].includes(p!)) continue;
    const key = `${p}|${b}`;
    (draws.get(key) ?? draws.set(key, new Set()).get(key)!).add(d!);
    sums.set(key, (sums.get(key) ?? 0) + Number(r));
  }
  const out = new Map<string, { draws: number; mean: number }[]>();
  for (const [key, ds] of draws) {
    const p = key.split("|")[0]!;
    (out.get(p) ?? out.set(p, []).get(p)!).push({ draws: ds.size, mean: sums.get(key)! / ds.size });
  }
  return out;
}

test("A/A through the +1 gate: 14 of 62 directed block comparisons pass, about 10.9 expected at SD 1.51", () => {
  const r = aaThroughGate(unchangedBlocks(), 1.51, 1);
  expect(r.directed).toBe(62);
  expect(r.observed).toBe(14);
  expect(r.expected).toBeCloseTo(10.91, 1);
  // the same model with the continuity correction for integer solve counts (ties pass): about 12.1
  expect(r.expectedLattice).toBeCloseTo(12.14, 1);
});

test("latticeBoundary reads the tail half a lattice step below the first lattice point at or above the bar", () => {
  // n_a = 3, n_c = 4: h = 1/12; the bar 1 is the lattice point 12/12 (snapped, not pushed one step up)
  expect(latticeBoundary(1, 1 / 12)).toBeCloseTo(1 - 1 / 24, 12);
  // n_a = n_c = 4: h = 1/4; a bar between lattice points rounds up to the next one
  expect(latticeBoundary(0.3, 0.25)).toBeCloseTo(0.5 - 0.125, 12);
  // 0.1 + 0.2 is a hair above 0.3: still snapped onto the lattice point 0.3 = 3 * 0.1
  expect(latticeBoundary(0.1 + 0.2, 0.1)).toBeCloseTo(0.3 - 0.05, 12);
});

test("aaThroughGate refuses a non-integer draw count (the lattice needs whole counts)", () => {
  expect(() => aaThroughGate(new Map([["X", [{ draws: 2.5, mean: 5 }, { draws: 3, mean: 4 }]]]), 1.5, 1)).toThrow(/whole numbers/);
});

test("binomial flips for another team's identical re-runs: about 33 on 66 tasks (31, 27) and 49 on 117 (36, 35)", () => {
  expect(Math.round(binomialFlips(31, 27, 66))).toBe(33);
  expect(Math.round(binomialFlips(36, 35, 117))).toBe(49);
});

test("aaThroughGate ignores self-comparisons", () => {
  const r = aaThroughGate(new Map([["X", [{ draws: 4, mean: 5 }]]]), 1.5, 1);
  expect(r.directed).toBe(0);
});
