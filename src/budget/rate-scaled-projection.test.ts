import { test, expect } from "bun:test";
import { medianRatio, projectRateScaledBudget, type DurationsById } from "./rate-scaled-projection";

test("medianRatio takes the median of per-id ratios over ids common to both maps", () => {
  const num: DurationsById = { a: [5, 5], b: [8] };
  const den: DurationsById = { a: [10, 10], b: [20] };
  // a: 5/10 = 0.5, b: 8/20 = 0.4 -> median of [0.5, 0.4] = 0.45
  expect(medianRatio(num, den)).toBeCloseTo(0.45, 6);
});

test("medianRatio ignores ids present in only one map", () => {
  const num: DurationsById = { a: [5], b: [8], c: [100] };
  const den: DurationsById = { a: [10], b: [20] };
  expect(medianRatio(num, den)).toBeCloseTo(0.45, 6);
});

test("medianRatio throws when there are no ids in common", () => {
  expect(() => medianRatio({ a: [1] }, { b: [1] })).toThrow(/no ids in common/);
});

test("projectRateScaledBudget chains the reference mean, env-speed ratio, and arm ratio", () => {
  const referenceSlateDurations: DurationsById = { a: [100, 120], b: [200], c: [150, 150] };
  // fullReferenceMean = mean(110, 200, 150) = 153.333...
  const probeBaselineReferenceEnvDurations: DurationsById = { x: [10, 10], y: [20] };
  const probeBaselineTargetEnvDurations: DurationsById = { x: [5, 5], y: [8] };
  // envSpeedRatio = median(5/10, 8/20) = median(0.5, 0.4) = 0.45
  const probeArmTargetEnvDurations: DurationsById = { x: [4], y: [10] };
  // armRatio = median(4/5, 10/8) = median(0.8, 1.25) = 1.025

  const result = projectRateScaledBudget({
    referenceSlateDurations,
    probeBaselineReferenceEnvDurations,
    probeBaselineTargetEnvDurations,
    probeArmTargetEnvDurations,
    nTasks: 100,
  });

  expect(result.fullReferenceMeanSeconds).toBeCloseTo(153.3333, 3);
  expect(result.envSpeedRatio).toBeCloseTo(0.45, 6);
  expect(result.armRatio).toBeCloseTo(1.025, 6);
  // projectedHours = 100 * 153.3333 * 0.45 * 1.025 / 3600
  expect(result.projectedHours).toBeCloseTo(1.9646, 3);
});

test("projectRateScaledBudget rejects a non-positive nTasks", () => {
  const d: DurationsById = { a: [1] };
  expect(() =>
    projectRateScaledBudget({
      referenceSlateDurations: d, probeBaselineReferenceEnvDurations: d, probeBaselineTargetEnvDurations: d, probeArmTargetEnvDurations: d, nTasks: 0,
    }),
  ).toThrow(/nTasks must be positive/);
});

test("projectRateScaledBudget rejects an empty reference slate", () => {
  const d: DurationsById = { a: [1] };
  expect(() =>
    projectRateScaledBudget({
      referenceSlateDurations: {}, probeBaselineReferenceEnvDurations: d, probeBaselineTargetEnvDurations: d, probeArmTargetEnvDurations: d, nTasks: 10,
    }),
  ).toThrow(/referenceSlateDurations is empty/);
});

test("a candidate arm identical to baseline (armRatio = 1) and identical envs (envSpeedRatio = 1) projects to exactly the reference mean x nTasks", () => {
  const referenceSlateDurations: DurationsById = { a: [60] };
  const same: DurationsById = { x: [60] };
  const result = projectRateScaledBudget({
    referenceSlateDurations,
    probeBaselineReferenceEnvDurations: same,
    probeBaselineTargetEnvDurations: same,
    probeArmTargetEnvDurations: same,
    nTasks: 10,
  });
  expect(result.projectedHours).toBeCloseTo((10 * 60) / 3600, 9);
});

test("CLI: --n-tasks must be a positive safe whole number (usage error, exit 2)", () => {
  const { join } = require("node:path");
  const SCRIPT = join(import.meta.dir, "rate-scaled-projection.ts");
  for (const bad of ["-5", "2.5", "Infinity"]) {
    const p = Bun.spawnSync(["bun", SCRIPT, "--n-tasks", bad, "--reference-slate", "x", "--probe-baseline-reference-env", "x", "--probe-baseline-target-env", "x", "--probe-arm-target-env", "x"]);
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain("--n-tasks");
  }
});
