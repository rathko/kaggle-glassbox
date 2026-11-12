import { normalSurvival } from "../noise-floor/noise-floor.ts";

/**
 * False-pass rate of a same-block +bar gate with n draws per arm, ties passing.
 * For solved counts the arm sums are integers, so "mean difference >= bar" is "sum difference >= ceil(n * bar)",
 * and the normal approximation uses a continuity correction of 0.5 on the sum scale (a fractional bar is handled
 * too). For a continuous score (`continuous`), the threshold is n * bar with no correction.
 */
export function falsePassRate(n: number, sd: number, bar: number, continuous = false): number {
  return passRate(n, sd, bar, 0, continuous);
}

/** Pass rate of the same gate when the change truly moves the per-run count by `effect` (power; effect 0 is falsePassRate). */
export function passRate(n: number, sd: number, bar: number, effect: number, continuous = false): number {
  // n * bar can land a rounding error above a whole number (100 * 0.07 = 7.000000000000001): snap values within a
  // few ulps of an integer before taking the ceiling, so the gate does not move by a whole task (a genuine fraction,
  // however small relative to n * bar, is far more than a few ulps)
  const nb = n * bar, snapped = Math.abs(nb - Math.round(nb)) <= 4 * Number.EPSILON * Math.max(1, Math.abs(nb)) ? Math.round(nb) : nb;
  const threshold = continuous ? nb : Math.ceil(snapped) - 0.5;
  return normalSurvival((threshold - n * effect) / (sd * Math.sqrt(2 * n)));
}

/** Smallest draws per arm that holds the false-pass rate below alpha. */
export function drawsNeeded(sd: number, bar: number, alpha: number, max = 1000, continuous = false): number {
  for (let n = 1; n <= max; n++) if (falsePassRate(n, sd, bar, continuous) < alpha) return n;
  throw new Error(`no n <= ${max} reaches alpha ${alpha}`);
}
