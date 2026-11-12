// aa-splits: the false-pass rate of a "+1 solve" promotion gate, measured on draws of ONE unchanged
// package (an A/A study). The gate: an idea passes iff
//   mean(idea) >= mean(base) + max(MIN_MARGIN, sd(base) / sqrt(n_idea)),  sd = sample SD (n-1).
// FP(b,k) enumerates EVERY ordered pair of disjoint subsets (A, A') of the draws with |A| = b, |A'| = k and
// returns the fraction where A' passes against A. Splits share draws, so their passes are not independent:
// use the draw-level bootstrap for an interval, never a binomial over splits.
import { safeMean } from "../integrity/safe-mean";

export const MIN_MARGIN = 1.0;

// mean and sampleSd take the plain arithmetic whenever it stays finite, so every ordinary result (solve counts, the
// paper's numbers) is unchanged bit for bit; only finite scores whose sums or squared deviations overflow (near
// Number.MAX_VALUE) go through the scaled path, which is finite whenever the inputs are.
export function mean(xs: number[]): number { return safeMean(xs); }
export function sampleSd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const plain = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
  if (Number.isFinite(plain)) return plain;
  // deviations scaled by the largest one: each squared term is at most 1, so nothing overflows before the sqrt
  const dev = xs.map((x) => x / 2 - m / 2), big = dev.reduce((a, v) => Math.max(a, Math.abs(v)), 0);
  if (!(big > 0) || !Number.isFinite(big)) return Number.isFinite(big) ? 0 : NaN;
  return 2 * big * Math.sqrt(dev.reduce((s, v) => s + (v / big) ** 2, 0) / (xs.length - 1));
}

/** The gate verdict for one (baseline, idea) pair. `bar` is the minimum margin in score units (default 1 task). */
export function gatePasses(base: number[], idea: number[], bar = MIN_MARGIN): boolean {
  const margin = Math.max(bar, sampleSd(base) / Math.sqrt(idea.length));
  // The means are taken after subtracting one common score (the first baseline draw), so a large constant offset
  // (a metric that sits near 1e15) does not inflate the rounding slack: on the raw values, a few ulps of 1e15 is
  // about 3.5, larger than a bar of 1, and an unchanged arm would pass. The gate depends only on differences, so the
  // shift changes nothing mathematically.
  const c = base[0]!;
  const sb = base.map((x) => x - c), si = idea.map((x) => x - c);
  if (Number.isFinite(c) && sb.every(Number.isFinite) && si.every(Number.isFinite)) {
    const mi = mean(si), mb = mean(sb);
    // the shifted means still carry rounding of about their own size times epsilon; when that is not far below the
    // margin, the verdict is decided by rounding, not by the data, so it is refused rather than guessed
    if (Math.max(Math.abs(mi), Math.abs(mb)) * Number.EPSILON > 1e-6 * margin)
      throw new RangeError(`gate is numerically indeterminate: the scores differ by about ${Math.max(Math.abs(mi), Math.abs(mb)).toExponential(2)} but the margin is ${margin}; rescale the scores`);
    // ties pass. The slack absorbs a few ulps of rounding in the means and the SD, and is always a vanishing
    // fraction of the margin, so it can never let a no-change arm clear the bar.
    const tol = Math.min(16 * Number.EPSILON * Math.max(Math.abs(mi), Math.abs(mb), Math.abs(margin)), 1e-9 * margin);
    return mi >= mb + margin - tol;
  }
  // scores whose differences overflow (finite values of opposite sign near Number.MAX_VALUE): compare halves
  const mi = mean(idea), mb = mean(base);
  return mi / 2 - mb / 2 >= (margin / 2) * (1 - 16 * Number.EPSILON);
}

/** All k-subsets of indices [0, n), lexicographic. */
export function* combinations(n: number, k: number, start = 0, acc: number[] = []): Generator<number[]> {
  if (acc.length === k) { yield acc.slice(); return; }
  for (let i = start; i <= n - (k - acc.length); i++) { acc.push(i); yield* combinations(n, k, i + 1, acc); acc.pop(); }
}

export interface FpResult { pairs: number; passes: number; fp: number }

export type GatePredicate = (base: number[], idea: number[]) => boolean;

/** FP(b,k): exhaustive over ordered disjoint (A, A') splits of the draws. Pass `gate` to score your own
 *  promotion rule instead of the built-in one (then `bar` is unused). */
export function falsePass(draws: number[], b: number, k: number, bar = MIN_MARGIN, gate?: GatePredicate): FpResult {
  const passesGate: GatePredicate = gate ?? ((base, idea) => gatePasses(base, idea, bar));
  const n = draws.length;
  if (b + k > n) throw new Error(`need ${b + k} draws for FP(${b},${k}); have ${n}`);
  let pairs = 0, passes = 0;
  for (const A of combinations(n, b)) {
    const inA = new Set(A);
    const rest = [...Array(n).keys()].filter((i) => !inA.has(i));
    const base = A.map((i) => draws[i]!);
    for (const Bi of combinations(rest.length, k)) {
      pairs++;
      if (passesGate(base, Bi.map((j) => draws[rest[j]!]!))) passes++;
    }
  }
  return { pairs, passes, fp: passes / pairs };
}

/** mulberry32: small, well-known, seedable PRNG so the bootstrap is reproducible bit for bit. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Type-7 (linear interpolation) sample quantile of an ascending-sorted array, the R/NumPy default. */
export function quantile7(sorted: number[], p: number): number {
  const h = (sorted.length - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

/** One random ordered disjoint split (A, A'), |A| = b, |A'| = k, by partial Fisher-Yates. */
export function randomSplit(n: number, b: number, k: number, rnd: () => number): [number[], number[]] {
  const idx = [...Array(n).keys()];
  for (let i = 0; i < b + k; i++) {
    const j = i + Math.floor(rnd() * (n - i));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return [idx.slice(0, b), idx.slice(b, b + k)];
}

/** Percentile bootstrap over draws for FP(b,k). Each resample draws N values with replacement; its FP is
 *  estimated from `splits` random disjoint splits (exhaustive enumeration per resample is too slow at N=16).
 *  Returns the values at the given quantiles. */
export function bootstrapFp(draws: number[], b: number, k: number, resamples: number, splits: number, seed: number, q = [0.025, 0.975]): number[] {
  const rnd = mulberry32(seed), out: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const s = draws.map(() => draws[Math.floor(rnd() * draws.length)]!);
    let pass = 0;
    for (let t = 0; t < splits; t++) {
      const [A, B] = randomSplit(s.length, b, k, rnd);
      if (gatePasses(A.map((i) => s[i]!), B.map((i) => s[i]!))) pass++;
    }
    out.push(pass / splits);
  }
  out.sort((x, y) => x - y);
  return q.map((p) => quantile7(out, p));
}

/** Jackknife SE of FP(b,k): leave one draw out, recompute exhaustively. FP(b,k) is a U-statistic, so this
 *  tracks its sampling SD closely (simulated, 960 studies at N = 16: mean SE 0.0359 vs true SD 0.0358), but
 *  +/-1.96 SE covers only ~88% (the statistic is discrete and skewed). Report it as an SE, not a 95% interval. */
export function jackknifeSe(draws: number[], b: number, k: number, bar = MIN_MARGIN): number {
  const n = draws.length;
  if (n < b + k + 1) throw new Error(`jackknife of FP(${b},${k}) needs at least ${b + k + 1} draws; have ${n}`);
  const loo = draws.map((_, i) => falsePass(draws.filter((_, j) => j !== i), b, k, bar).fp);
  const m = loo.reduce((a, x) => a + x, 0) / n;
  return Math.sqrt(((n - 1) / n) * loo.reduce((s, x) => s + (x - m) ** 2, 0));
}
