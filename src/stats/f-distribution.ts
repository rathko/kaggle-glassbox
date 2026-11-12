// f-distribution: CDF/survival function for the F distribution, used by
// `reproduce-paper-numbers.ts` for the one-way block-effect test (is there more spread between
// blocks of an unchanged package than sampling alone predicts?). No external stats dependency —
// same philosophy as `chi-square.ts`.
//
// PURE, no I/O.

// Lanczos approximation to log(Gamma(x)) — same coefficients as chi-square.ts (duplicated rather
// than shared, to keep each distribution module a standalone, independently-testable unit).
function logGamma(x: number): number {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < 8; i++) a += g[i]! / (x + i + 1);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// Continued-fraction evaluation for the incomplete beta function (Numerical Recipes' betacf),
// used by `regularizedIncompleteBeta` below for whichever of I_x(a,b) / I_{1-x}(b,a) converges
// faster for the given x.
function betaContinuedFraction(a: number, b: number, x: number): number {
  const MAX_ITER = 200, EPS = 3e-14, FPMIN = 1e-300;
  let c = 1, d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta function I_x(a, b) = P(X <= x) for X ~ Beta(a, b), for a, b > 0
 *  and x in [0, 1]. Standard split (Numerical Recipes "betai"): evaluate the continued fraction on
 *  whichever side of x = (a+1)/(a+b+2) converges quickly, and use the complement identity
 *  I_x(a,b) = 1 - I_{1-x}(b,a) for the other side. */
export function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (a <= 0 || b <= 0) throw new Error("a and b must be positive");
  if (x < 0 || x > 1) throw new Error("x must be in [0, 1]");
  if (x === 0 || x === 1) return x;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** P(F <= f) for F ~ F-distribution(df1, df2), via the standard identity with the regularized
 *  incomplete beta: CDF(f) = I_{df1*f / (df1*f + df2)}(df1/2, df2/2). */
export function fCdf(f: number, df1: number, df2: number): number {
  if (df1 <= 0 || df2 <= 0) throw new Error("df1 and df2 must be positive");
  if (f <= 0) return 0;
  const x = (df1 * f) / (df1 * f + df2);
  return regularizedIncompleteBeta(df1 / 2, df2 / 2, x);
}

/** P(F >= f) for F ~ F-distribution(df1, df2) — the upper-tail p-value an ANOVA/F-test reads
 *  against. Computed directly via the complement form (not `1 - fCdf`) so it stays accurate in
 *  the far tail, where `1 - fCdf` would lose precision to cancellation. */
export function fSurvival(f: number, df1: number, df2: number): number {
  if (df1 <= 0 || df2 <= 0) throw new Error("df1 and df2 must be positive");
  if (f <= 0) return 1;
  const x = df2 / (df2 + df1 * f);
  return regularizedIncompleteBeta(df2 / 2, df1 / 2, x);
}
