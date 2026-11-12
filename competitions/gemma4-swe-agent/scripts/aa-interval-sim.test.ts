import { expect, setDefaultTimeout, test } from "bun:test";
setDefaultTimeout(60_000);

test("interval simulation: the exhaustive estimate is close to the true rate on average", async () => {
  const { simulateStudies, trueFp, coverage, TASK_RATES } = await import("./aa-interval-sim");
  const truth = trueFp(TASK_RATES, 200_000, 3);
  expect(truth).toBeGreaterThan(0.17);
  expect(truth).toBeLessThan(0.19);
  const c = coverage(simulateStudies(TASK_RATES, 12, 12, 5, { resamples: 50, splits: 100 }), truth);
  expect(Math.abs(c.meanFp - truth)).toBeLessThan(0.04);
}, 60_000);
