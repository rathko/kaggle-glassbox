// Pass-count distribution under the null when reads that reuse the same draws share those draws' sampling error
// (instead of treating every read as independent). A group key names one set of draws: reads whose control (or arm)
// carries the same key see the same simulated mean. Two arms against one shared control are correlated 1/2.
import { mulberry32 } from "../../../src/stats/seeded-random.ts";

export interface NullRead {
  drawsArm: number; drawsCtl: number; bar: number;
  /** key of the control's draw set; reads with the same key share it (null: an independent control) */
  baselineGroup: string | null;
  /** key of the arm's draw set, when another read uses these same draws as its control (null: independent) */
  armGroup?: string | null;
  /** true effect added to the arm (power); 0 or absent under the null */
  effect?: number;
  /** physical blocks of the arm and the control, for between-block drift (tau): each named block gets ONE drift
   *  per simulated campaign, used on whichever side of whichever comparison it appears. null/absent on both sides
   *  (or the same name) means a same-block read, whose drift cancels. */
  armBlock?: string | null;
  ctlBlock?: string | null;
}

function gaussian(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Monte Carlo pass counts with shared noise per draw-set key (baselineGroup / armGroup). Returns the 5th/95th percentiles
 *  and both tails at `observed`. With `tau` > 0, a read whose arm and control sit in different blocks adds
 *  drift(armBlock) - drift(ctlBlock), with one N(0, tau) drift per block name per simulated campaign: reads against one
 *  earlier baseline block share its drift (+tau^2), and a read whose control is another read's arm block gets -tau^2. */
export function sharedBaselinePassCounts(reads: NullRead[], sd: number, observed: number, reps = 200_000, seed = 20261111, tau = 0): { mean: number; lo90: number; hi90: number; pAtLeastObserved: number; pAtMostObserved: number } {
  // one key names one set of draws, so every use of it must agree on how many draws that is
  const sizeOf = new Map<string, number>();
  for (const r of reads) for (const [key, n] of [[r.baselineGroup, r.drawsCtl], [r.armGroup, r.drawsArm]] as const) {
    if (key == null) continue;
    if (sizeOf.has(key) && sizeOf.get(key) !== n) throw new Error(`draw-set key ${key} is used with ${sizeOf.get(key)} and ${n} draws`);
    sizeOf.set(key, n);
  }
  const rand = mulberry32(seed);
  const counts = new Array<number>(reads.length + 1).fill(0);
  let total = 0;
  for (let r = 0; r < reps; r++) {
    const shared = new Map<string, number>(), drift = new Map<string, number>();
    const block = (name: string) => {
      if (!drift.has(name)) drift.set(name, gaussian(rand) * tau);
      return drift.get(name)!;
    };
    const draw = (key: string | null | undefined, n: number) => {
      if (key == null) return gaussian(rand) * sd / Math.sqrt(n);
      if (!shared.has(key)) shared.set(key, gaussian(rand) * sd / Math.sqrt(n));
      return shared.get(key)!;
    };
    let passes = 0;
    for (const read of reads) {
      let ctl = draw(read.baselineGroup, read.drawsCtl);
      let arm = draw(read.armGroup, read.drawsArm) + (read.effect ?? 0);
      if (tau > 0 && read.armBlock && read.ctlBlock && read.armBlock !== read.ctlBlock) { arm += block(read.armBlock); ctl += block(read.ctlBlock); }
      if (arm - ctl >= read.bar) passes++;
    }
    counts[passes]!++;
    total += passes;
  }
  const quantile = (q: number) => { let c = 0; for (let k = 0; k < counts.length; k++) { c += counts[k]!; if (c / reps >= q) return k; } return counts.length - 1; };
  const atLeast = counts.slice(observed).reduce((a, b) => a + b, 0) / reps;
  const atMost = counts.slice(0, observed + 1).reduce((a, b) => a + b, 0) / reps;
  return { mean: total / reps, lo90: quantile(0.05), hi90: quantile(0.95), pAtLeastObserved: atLeast, pAtMostObserved: atMost };
}
