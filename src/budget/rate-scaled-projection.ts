#!/usr/bin/env bun
// rate-scaled-projection: project a full-slate time budget for a CANDIDATE arm, when you can only
// afford to measure it on a small, cheap probe slate, by chaining two measured ratios onto a
// known reference cost.
//
// This is a different technique from `cap-budget-projection.ts` (which truncates a measured
// duration distribution at a candidate per-task cap). This one answers a different question:
// "I know how long the full evaluation takes for my BASELINE arm, measured on a big slate in a
// slow-but-cheap reference environment (e.g. serial/local). I have a CANDIDATE arm I can only
// afford to run on a small probe slate, in a fast-but-expensive target environment (e.g. a
// managed platform). What would the candidate cost on the full slate, in the target
// environment?" Two ratios bridge that gap, each measured on the data you actually have:
//
//   envSpeedRatio = median, over the probe slate's ids, of (baseline arm's duration in the
//                   TARGET env) / (baseline arm's duration in the REFERENCE env)
//                   — how much faster/slower the target environment is, for the SAME arm.
//   armRatio      = median, over the probe slate's ids, of (candidate arm's duration in the
//                   TARGET env) / (baseline arm's duration in the TARGET env)
//                   — how much slower/faster the candidate is than the baseline, in the SAME env.
//
// projectedHours = nTasks * (baseline's measured mean per-task duration on the full reference
//                  slate) * envSpeedRatio * armRatio / 3600
//
// Both ratios use the MEDIAN across probe-slate ids rather than a pooled mean, because a probe
// slate is usually small (one or two dozen ids) and a single outlier task can otherwise dominate
// the ratio; median is the same choice cap-budget-projection.ts's sibling tools make elsewhere in
// this repo for small-n task-level ratios.
//
// usage: bun src/budget/rate-scaled-projection.ts --n-tasks 120 \
//          --reference-slate ./reference-slate.jsonl \
//          --probe-baseline-reference-env ./probe-baseline-ref.jsonl \
//          --probe-baseline-target-env ./probe-baseline-target.jsonl \
//          --probe-arm-target-env ./probe-arm-target.jsonl
// each JSONL file has one row per draw: {"id": "<task id>", "durationSeconds": <number>}

export interface Projection {
  /** Mean, over the reference slate's ids, of each id's own mean duration (reference env). */
  fullReferenceMeanSeconds: number;
  /** Median ratio of target-env to reference-env duration for the baseline arm, over ids common
   *  to both probe measurements. */
  envSpeedRatio: number;
  /** Median ratio of candidate-arm to baseline-arm duration in the target env, over ids common
   *  to both probe measurements. */
  armRatio: number;
  projectedHours: number;
}

export type DurationsById = Record<string, number[]>;

function mean(a: number[]): number {
  if (!a.length) throw new Error("empty duration list");
  for (const x of a) if (!(Number.isFinite(x) && x > 0)) throw new Error(`durations must be positive seconds, got ${x}`);
  return a.reduce((x, y) => x + y, 0) / a.length;
}
function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median, over ids present in BOTH maps, of mean(numerator[id]) / mean(denominator[id]). */
export function medianRatio(numerator: DurationsById, denominator: DurationsById): number {
  const ids = Object.keys(numerator).filter((id) => denominator[id]?.length);
  if (!ids.length) throw new Error("no ids in common between the two duration maps — nothing to compare");
  return median(ids.map((id) => mean(numerator[id]) / mean(denominator[id])));
}

export function projectRateScaledBudget(opts: {
  referenceSlateDurations: DurationsById;
  probeBaselineReferenceEnvDurations: DurationsById;
  probeBaselineTargetEnvDurations: DurationsById;
  probeArmTargetEnvDurations: DurationsById;
  nTasks: number;
}): Projection {
  const { referenceSlateDurations, probeBaselineReferenceEnvDurations, probeBaselineTargetEnvDurations, probeArmTargetEnvDurations, nTasks } = opts;
  if (nTasks <= 0) throw new Error("nTasks must be positive");
  const ids = Object.keys(referenceSlateDurations);
  if (!ids.length) throw new Error("referenceSlateDurations is empty");
  const fullReferenceMeanSeconds = mean(ids.map((id) => mean(referenceSlateDurations[id])));
  const envSpeedRatio = medianRatio(probeBaselineTargetEnvDurations, probeBaselineReferenceEnvDurations);
  const armRatio = medianRatio(probeArmTargetEnvDurations, probeBaselineTargetEnvDurations);
  const projectedHours = (nTasks * fullReferenceMeanSeconds * envSpeedRatio * armRatio) / 3600;
  return { fullReferenceMeanSeconds, envSpeedRatio, armRatio, projectedHours };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
if (import.meta.main) {
  const { readFileSync } = await import("node:fs");
  const { countFlag } = await import("../replay/cli-num");
  const { strictArgs } = await import("../cli-args");
  const argv = process.argv.slice(2);
  strictArgs(argv, {
    valued: ["id-field", "duration-field", "n-tasks", "reference-slate", "probe-baseline-reference-env", "probe-baseline-target-env", "probe-arm-target-env"],
  }, "usage: bun src/budget/rate-scaled-projection.ts --n-tasks N --reference-slate <f> " +
    "--probe-baseline-reference-env <f> --probe-baseline-target-env <f> --probe-arm-target-env <f> [--id-field F] [--duration-field F]");
  const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const ID_FIELD = flag("id-field") ?? "id", DURATION_FIELD = flag("duration-field") ?? "durationSeconds";
  const loadDurations = (path: string): DurationsById => {
    const out: DurationsById = {};
    for (const line of readFileSync(path, "utf8").trim().split("\n").filter(Boolean)) {
      const row = JSON.parse(line) as Record<string, unknown>;
      const id = row[ID_FIELD], d = row[DURATION_FIELD];
      if (typeof id !== "string" && typeof id !== "number") throw new Error(`${path}: a row has no "${ID_FIELD}" (set --id-field)`);
      if (typeof d !== "number") throw new Error(`${path}: row ${id} has no numeric "${DURATION_FIELD}" (set --duration-field)`);
      (out[String(id)] ??= []).push(d);
    }
    return out;
  };
  const nTasks = countFlag("n-tasks", flag("n-tasks"), 0); // 0 = absent, caught by the usage check below
  const referenceSlate = flag("reference-slate");
  const probeBaselineRef = flag("probe-baseline-reference-env");
  const probeBaselineTarget = flag("probe-baseline-target-env");
  const probeArmTarget = flag("probe-arm-target-env");
  if (!nTasks || !referenceSlate || !probeBaselineRef || !probeBaselineTarget || !probeArmTarget) {
    console.error(
      "usage: bun src/budget/rate-scaled-projection.ts --n-tasks N --reference-slate <f> " +
      "--probe-baseline-reference-env <f> --probe-baseline-target-env <f> --probe-arm-target-env <f>",
    );
    process.exit(2);
  }
  const result = projectRateScaledBudget({
    referenceSlateDurations: loadDurations(referenceSlate),
    probeBaselineReferenceEnvDurations: loadDurations(probeBaselineRef),
    probeBaselineTargetEnvDurations: loadDurations(probeBaselineTarget),
    probeArmTargetEnvDurations: loadDurations(probeArmTarget),
    nTasks,
  });
  console.log(
    `reference slate mean duration: ${result.fullReferenceMeanSeconds.toFixed(1)}s\n` +
    `env speed ratio (target/reference): ${result.envSpeedRatio.toFixed(3)}\n` +
    `arm ratio (candidate/baseline, target env): ${result.armRatio.toFixed(3)}\n` +
    `projected ${nTasks}-task budget in the target environment: ${result.projectedHours.toFixed(2)}h`,
  );
}
