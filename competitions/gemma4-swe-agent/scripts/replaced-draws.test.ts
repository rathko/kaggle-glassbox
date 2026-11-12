import { expect, test, setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000); // statistical tests can take seconds on a loaded machine (the bunfig preload alone did not always apply)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type DecisionRow, nullPassProbabilityNormal, summariseNullPasses } from "./reproduce-paper-numbers.ts";

const rows: DecisionRow[] = JSON.parse(readFileSync(join(import.meta.dir, "..", "data/flaky10-decisions.json"), "utf8"));
const primary = rows.filter((d) => d.primary);

test("every decision row says whether it replaced a draw", () => {
  for (const r of rows) expect(typeof r.replacedDraw).toBe("boolean");
});

test("four of the 23 decided reads replaced a draw, one of which passed", () => {
  const replaced = primary.filter((d) => d.replacedDraw);
  expect(primary.length).toBe(23);
  expect(replaced.length).toBe(4);
  expect(replaced.filter((d) => d.passed).length).toBe(1);
});

test("dropping the replaced reads leaves observed passes inside the null range", () => {
  const kept = primary.filter((d) => !d.replacedDraw);
  const s = summariseNullPasses(kept, kept.map((d) => nullPassProbabilityNormal(d, 1.51)));
  expect(s.expected).toBeCloseTo(3.41, 2);
  expect(s.observed).toBe(3);
  expect(s.observed).toBeGreaterThanOrEqual(s.lo90);
  expect(s.observed).toBeLessThanOrEqual(s.hi90);
});
