import { test, expect, setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000); // statistical tests can take seconds on a loaded machine (the bunfig preload alone did not always apply)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gradeableRescoreSd, expectedFlips } from "./gradeable.ts";

const ROOT = join(import.meta.dir, "..");
function load() {
  const outcomes = new Map<string, number[]>();
  for (const line of readFileSync(join(ROOT, "data/base-era-task-outcomes.csv"), "utf8").trim().split("\n").slice(1)) {
    const [, , slate, task, resolved] = line.split(",");
    if (slate !== "129") continue;
    if (!outcomes.has(task!)) outcomes.set(task!, []);
    outcomes.get(task!)!.push(Number(resolved));
  }
  const ref = new Map<string, number>();
  for (const line of readFileSync(join(ROOT, "data/base-era-reference-fix.csv"), "utf8").trim().split("\n").slice(1)) {
    const [task, pass] = line.split(",");
    ref.set(task!, Number(pass));
  }
  return { outcomes, ref };
}

test("29 of 129 reference fixes fail locally and none of those tasks was ever solved", () => {
  const { outcomes, ref } = load();
  const g = gradeableRescoreSd(outcomes, ref, 58);
  expect(g.tasks).toBe(129);
  expect(g.referenceFails).toBe(29);
  expect(g.referenceFailsEverSolved).toBe(0);
});

test("dropping never-gradeable tasks raises the predicted 58-task re-score SD from about 1.65 to about 1.88", () => {
  const { outcomes, ref } = load();
  const g = gradeableRescoreSd(outcomes, ref, 58);
  expect(g.sdAll).toBeCloseTo(1.65, 2);
  expect(g.sdGradeable).toBeCloseTo(1.88, 2);
});

test("gradeable-only variance predicts about 8.0 and 14.2 flips between identical re-runs on 66 and 117 tasks", () => {
  const { outcomes, ref } = load();
  const g = gradeableRescoreSd(outcomes, ref, 58);
  expect(expectedFlips(g.meanVarGradeable, 66)).toBeCloseTo(8.0, 1);
  expect(expectedFlips(g.meanVarGradeable, 117)).toBeCloseTo(14.2, 1);
});

test("a task with no reference-fix flag is an error, not a silent default", () => {
  expect(() => gradeableRescoreSd(new Map([["T999", [0, 1]]]), new Map(), 58)).toThrow(/T999/);
});

test("gradeable-only resampled 58-task SD is 1.90 (95% 1.62 to 2.15), and predicts 8.3 and 14.6 flips", async () => {
  const { parseTaskOutcomes, predictedRescoreSdResampling } = await import("./reproduce-paper-numbers.ts");
  const { outcomes: _o, ref } = load();
  const rows = parseTaskOutcomes(readFileSync(join(ROOT, "data/base-era-task-outcomes.csv"), "utf8"));
  const g = predictedRescoreSdResampling(rows, "129", 58, { include: (t: string) => ref.get(t) === 1 });
  expect(g.median).toBeCloseTo(1.90, 2);
  expect(g.lo95).toBeCloseTo(1.62, 2);
  expect(g.hi95).toBeCloseTo(2.15, 2);
  expect(expectedFlips((g.median * g.median) / 58, 66)).toBeCloseTo(8.25, 1);
  expect(expectedFlips((g.median * g.median) / 58, 117)).toBeCloseTo(14.6, 1);
});
