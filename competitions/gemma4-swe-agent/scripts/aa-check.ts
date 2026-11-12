// A/A check through the +1 gate: compare every block of an unchanged package with every other block
// of the same package, using each block's own draw count, and count directed comparisons that clear the bar.
import { normalSurvival } from "../../../src/noise-floor/noise-floor.ts";

/** expected: the normal model the paper states (P(D >= bar) as a continuous tail at bar).
 *  expectedLattice: the same model with a continuity correction. Each block mean is an integer solve count over
 *  its draws, so D = X/n_a - Y/n_c only takes values on a lattice of step h = gcd(n_a, n_c)/(n_a n_c), and the
 *  gate passes ties (D >= bar). The inclusive boundary is the first lattice point at or above the bar, and the
 *  normal tail is read half a step below it. */
export interface AaResult { directed: number; observed: number; expected: number; expectedLattice: number }

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** The continuity-corrected boundary for P(D >= bar) when D lives on multiples of h: (first lattice point >= bar) - h/2.
 *  bar/h is snapped to the nearest integer when it is within a few ulps of it, so a bar that is exactly a lattice
 *  point (1 = 12/12) is not pushed one step up by rounding error. */
export function latticeBoundary(bar: number, h: number): number {
  const k = bar / h, r = Math.round(k);
  const steps = Math.abs(k - r) <= 4 * Number.EPSILON * Math.max(1, Math.abs(k)) ? r : Math.ceil(k);
  return steps * h - h / 2;
}

/** blocks: package -> list of { draws, mean } per block. Draw counts must be positive whole numbers. */
export function aaThroughGate(blocks: Map<string, { draws: number; mean: number }[]>, sd: number, bar: number): AaResult {
  let directed = 0, observed = 0, expected = 0, expectedLattice = 0;
  for (const bl of blocks.values()) {
    for (let i = 0; i < bl.length; i++) for (let j = 0; j < bl.length; j++) {
      if (i === j) continue;
      directed++;
      const na = bl[i]!.draws, nc = bl[j]!.draws;
      if (!Number.isSafeInteger(na) || na < 1 || !Number.isSafeInteger(nc) || nc < 1) throw new Error(`block draw counts must be positive whole numbers, got ${na} and ${nc}`);
      const se = sd * Math.sqrt(1 / na + 1 / nc);
      expected += normalSurvival(bar / se);
      expectedLattice += normalSurvival(latticeBoundary(bar, gcd(na, nc) / (na * nc)) / se);
      if (bl[i]!.mean - bl[j]!.mean >= bar - 1e-9) observed++;
    }
  }
  return { directed, observed, expected, expectedLattice };
}
