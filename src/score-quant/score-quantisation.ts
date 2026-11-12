// score-quantisation: a leaderboard or dashboard often shows a score rounded (or floored) to a
// fixed number of decimal places, from an underlying integer count of solved tasks out of n. That
// quantisation is lossy in a way that matters: two adjacent task counts can print the SAME
// displayed score, and — more importantly for reading a result honestly — the displayed score
// alone does not tell you whether the underlying platform is rounding or flooring. Guessing wrong
// about which one it does means misreading how many tasks a score actually represents, which
// matters when you're trying to tell whether a change moved the number by a real task or not.
//
// PURE, no I/O.

export type QuantMode = "floor" | "round";

/** The displayed score for `k` solved tasks out of `n`, quantised to `decimals` places (default 2) by either
 *  truncation ("floor", the common case for a platform that never rounds UP a partial score) or
 *  standard rounding ("round"). */
function checkArgs(n: number, mode: string, decimals: number): void {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("n must be a positive whole number no larger than 2^53 - 1");
  if (mode !== "floor" && mode !== "round") throw new Error("mode must be floor or round");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) throw new Error("decimals must be a whole number in [0, 12]");
}

export function quantisedScore(k: number, n: number, mode: QuantMode = "floor", decimals = 2): number {
  checkArgs(n, mode, decimals);
  if (!Number.isInteger(k) || k < 0 || k > n) throw new Error("k must be a whole number in [0, n]");
  // exact integer arithmetic: a float (scale * k) / n misrounds once scale * k passes 2^53
  const scale = 10n ** BigInt(decimals), K = BigInt(k), N = BigInt(n);
  const q = mode === "floor" ? (scale * K) / N : (2n * scale * K + N) / (2n * N);
  return Number(q) / Number(scale);
}

/** The range of integer task counts `k` in [0, n] consistent with a reported `score`, or null when none is.
 *  The displayed score never decreases as k grows, so the matches are one contiguous run, found by two binary
 *  searches: O(log n) even for a huge n. */
export function inferKRange(score: number, n: number, mode: QuantMode = "floor", decimals = 2): { min: number; max: number } | null {
  checkArgs(n, mode, decimals);
  if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error("score must be a fraction in [0, 1]");
  const scale = 10 ** decimals, target = Math.round(score * scale);
  // a displayed score has at most `decimals` places; anything finer is a typo or the wrong --decimals. The slack
  // scales with the product: at 12 places score * 1e12 is ~1e10 and carries a rounding error of several 1e-6
  const tol = Math.max(1e-6, 8 * Number.EPSILON * Math.abs(score * scale));
  if (Math.abs(score * scale - target) > tol) throw new Error(`score ${score} has more than ${decimals} decimal places`);
  // all in BigInt: near 2^53, float n + 1 and (lo + hi) / 2 stop making progress and the search never ends
  const S = 10n ** BigInt(decimals), N = BigInt(n), T = BigInt(target);
  const q = (k: bigint) => (mode === "floor" ? (S * k) / N : (2n * S * k + N) / (2n * N));
  const firstAbove = (pass: (v: bigint) => boolean) => { // first k in [0, n + 1] with pass(q(k)), n + 1 if none
    let lo = 0n, hi = N + 1n;
    while (lo < hi) { const m = (lo + hi) / 2n; if (pass(q(m))) hi = m; else lo = m + 1n; }
    return lo;
  };
  const min = firstAbove((v) => v >= T), max = firstAbove((v) => v > T) - 1n;
  return min <= max && min <= N ? { min: Number(min), max: Number(max) } : null;
}

/** Every integer task count `k` in [0, n] consistent with a reported `score` under the given
 *  quantisation mode. Usually a singleton — a reported score plus a known `n` usually pins down
 *  `k` exactly — but returns every match rather than assuming uniqueness, since a coarse enough
 *  n/score combination can be ambiguous. For a very large n prefer `inferKRange`. */
export function inferK(score: number, n: number, mode: QuantMode = "floor", decimals = 2): number[] {
  const r = inferKRange(score, n, mode, decimals);
  if (!r) return [];
  if (r.max - r.min > 1_000_000) throw new Error(`${r.max - r.min + 1} counts match; use inferKRange`);
  return Array.from({ length: r.max - r.min + 1 }, (_, i) => r.min + i);
}
