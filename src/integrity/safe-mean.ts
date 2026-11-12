// safe-mean: the mean of finite numbers without overflow on the way. The plain sum / n is used whenever the sum is
// finite, so ordinary reads are unchanged bit for bit; only when the sum overflows (rows near Number.MAX_VALUE) is the
// mean taken from the values scaled by their largest magnitude, summed with Neumaier compensation. Each scaled
// value is in [-1, 1], their mean too, so the result is finite whenever every input is.

/** Neumaier-compensated sum. */
export function compensatedSum(xs: number[]): number {
  let s = 0, c = 0;
  for (const x of xs) {
    const t = s + x;
    c += Math.abs(s) >= Math.abs(x) ? (s - t) + x : (x - t) + s;
    s = t;
  }
  return s + c;
}

/** Mean of finite numbers; NaN for an empty list. */
export function safeMean(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = xs.reduce((a, b) => a + b, 0);
  if (Number.isFinite(s)) return s / xs.length;
  const m = xs.reduce((a, b) => Math.max(a, Math.abs(b)), 0);
  if (!Number.isFinite(m)) return NaN;
  return (compensatedSum(xs.map((x) => x / m)) / xs.length) * m;
}
