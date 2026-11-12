// chi-square: CDF and quantile function for the chi-square distribution, used by
// `reproduce-paper-numbers.ts` to put a confidence interval on a variance estimate from a small
// number of paired re-score differences. No external stats dependency — same philosophy as
// `src/noise-floor/noise-floor.ts`'s own closed-form normal CDF.
//
// PURE, no I/O.

// Regularized lower incomplete gamma function P(a, x), via the standard series expansion for
// x < a+1 and a continued fraction for x >= a+1 (the numerically stable split used throughout
// the literature for this function — a single series or continued fraction alone loses
// precision outside its own regime).
function logGamma(x: number): number {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < 8; i++) a += g[i] / (x + i + 1);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Q(a, x) = 1 - P(a, x), computed directly in the continued-fraction regime so a far upper tail keeps its
 *  digits (1 - P loses everything below ~1e-16). */
function regularizedUpperIncompleteGamma(a: number, x: number): number {
  if (a <= 0) throw new Error("a must be positive");
  if (x < 0) throw new Error("x must be non-negative");
  if (x < a + 1) return 1 - regularizedLowerIncompleteGamma(a, x);
  return upperContinuedFraction(a, x);
}

function regularizedLowerIncompleteGamma(a: number, x: number): number {
  if (a <= 0) throw new Error("a must be positive");
  if (x < 0) throw new Error("x must be non-negative");
  if (x === 0) return 0;
  if (x < a + 1) {
    let sum = 1 / a, del = sum, ap = a;
    for (let n = 0; n < 500; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  return 1 - upperContinuedFraction(a, x);
}

// continued fraction for Q(a,x) = 1 - P(a,x), valid for x >= a + 1
function upperContinuedFraction(a: number, x: number): number {
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** P(X > x) for X ~ chi-square(df), accurate deep in the upper tail. */
export function chiSquareSurvival(x: number, df: number): number {
  if (df <= 0) throw new Error("df must be positive");
  if (x <= 0) return 1;
  return regularizedUpperIncompleteGamma(df / 2, x / 2);
}

/** P(X <= x) for X ~ chi-square(df). */
export function chiSquareCdf(x: number, df: number): number {
  if (df <= 0) throw new Error("df must be positive");
  if (x <= 0) return 0;
  return regularizedLowerIncompleteGamma(df / 2, x / 2);
}

/** The value x such that P(X <= x) = p, for X ~ chi-square(df). Found by bisection over the CDF
 *  above — the CDF is monotonic, so this is robust even though it has no closed form. */
export function chiSquareQuantile(p: number, df: number): number {
  if (p <= 0 || p >= 1) throw new Error("p must be in (0, 1)");
  if (df <= 0) throw new Error("df must be positive");
  let lo = 0, hi = Math.max(1, df);
  while (chiSquareCdf(hi, df) < p) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (chiSquareCdf(mid, df) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
