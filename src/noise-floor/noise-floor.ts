// noise-floor: how much of an observed score difference is real, versus how much is just the
// coin-flip noise of a small evaluation set?
//
// Every single scored run of n tasks against a model is one draw from a binomial distribution.
// Before trusting a difference between two draws (this prompt got 52%, that one got 48%), you
// need to know the size of a difference that distribution would produce from chance ALONE. A
// change that moves the score by less than that is not evidence of anything — it is noise you
// are reading as signal.
//
// SCOPE. The binomial functions treat the n tasks as independent draws at ONE common rate. On a fixed benchmark
// whose tasks differ in difficulty that overstates the noise (a task you always solve adds none): use
// `heterogeneousCountSd` with per-task rates instead. Two runs on the SAME tasks are paired, not independent
// samples: compare them with `mcNemarExact` on the tasks where they disagree.
export interface NoiseFloor {
  /** Standard deviation of the pass rate itself, for a single draw of n tasks at rate p. */
  sdOfRate: number;
  /** Standard deviation of the DIFFERENCE between two independent single draws at the same
   * underlying rate — this is the number to compare an observed delta against. */
  sdOfSingleDrawDifference: number;
  /** A commonly-used rule of thumb: a difference smaller than this is not worth reading as
   * signal from a single pair of draws (2 SD of the difference, ~95% one-draw-vs-one-draw). */
  minDetectableDifference: number;
}

function assertTasks(n: number, name = "n"): void {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive whole number`);
}
function assertCount(k: number, n: number, name = "k"): void {
  if (!Number.isInteger(k) || k < 0 || k > n) throw new Error(`${name} must be a whole number in [0, ${n}]`);
}

/** Binomial standard deviation of a pass rate from n independent tasks at true rate p. */
export function binomialSd(n: number, p: number): number {
  assertTasks(n);
  if (!Number.isFinite(p)) throw new Error("p must be a number");
  if (p < 0 || p > 1) throw new Error("p must be in [0, 1]");
  return Math.sqrt((p * (1 - p)) / n);
}

/** Full noise-floor summary for an evaluation of n tasks at an assumed/estimated true rate p. */
export function noiseFloor(n: number, p: number): NoiseFloor {
  const sdOfRate = binomialSd(n, p);
  // Var(X - Y) = Var(X) + Var(Y) for independent draws at the same rate = 2 * sdOfRate^2.
  const sdOfSingleDrawDifference = Math.sqrt(2) * sdOfRate;
  return { sdOfRate, sdOfSingleDrawDifference, minDetectableDifference: 2 * sdOfSingleDrawDifference };
}

/** Two-proportion z-test: is the difference between two observed pass rates (k1/n1 vs k2/n2)
 * larger than chance alone would produce, under the null hypothesis that both draws share one
 * true rate? Uses the pooled-proportion z-test — the standard choice for this comparison, more
 * conservative than treating each draw's own observed rate as if it were the true rate. */
export function twoProportionTest(k1: number, n1: number, k2: number, n2: number): { z: number; pValue: number; pooledP: number } {
  if (n1 <= 0 || n2 <= 0) throw new Error("n1 and n2 must be positive");
  assertTasks(n1, "n1"); assertTasks(n2, "n2"); assertCount(k1, n1, "k1"); assertCount(k2, n2, "k2");
  const p1 = k1 / n1, p2 = k2 / n2;
  const pooledP = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(pooledP * (1 - pooledP) * (1 / n1 + 1 / n2));
  const z = se === 0 ? 0 : (p1 - p2) / se;
  // direct tail: 1 - normalCdf rounds a far tail to 0; the tail approximation can exceed 1/2 by ~1e-8 at z = 0, so
  // the doubled value is clamped to a probability
  const pValue = Math.min(1, 2 * normalSurvival(Math.abs(z)));
  return { z, pValue, pooledP };
}

// Standard normal CDF via the Abramowitz & Stegun erf approximation (max error ~1.5e-7) — no
// external stats library needed for a two-sided p-value.
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
/** Upper tail of the standard normal, P(Z > x), computed directly rather than as 1 - normalCdf(x): the subtraction
 *  rounds to 0 once the tail drops below ~1e-16, so a sizing loop that waits for a tail under a tiny alpha stops
 *  early. Uses the Chebyshev-fitted complementary error function of Numerical Recipes (fractional error under 1.2e-7
 *  everywhere), so the tail keeps its relative precision far out. */
export function normalSurvival(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x < 0) return 1 - normalSurvival(-x);
  // near zero the fitted erfc is off by ~1.5e-8 (it gives 0.500000015 at 0), which matters to a strict "tail < 0.5"
  // test; the Maclaurin series of P(0 < Z < x) is exact there, so the tail is exactly 1/2 at 0 and below it after
  if (x < SMALL_Z) return 0.5 - centralMass(x);
  return Math.min(0.5, 0.5 * erfc(x / Math.SQRT2));
}
/** Below this z the series is used; it converges to double precision in a few terms there. */
const SMALL_Z = 0.5;
/** P(0 < Z < x) for small x >= 0, by the series phi(0) * sum (-1)^k x^(2k+1) / (2^k k! (2k+1)). */
function centralMass(x: number): number {
  const x2 = x * x;
  let term = x, sum = x; // k = 0: x / 1
  for (let k = 1; k < 40; k++) {
    term *= -x2 / (2 * k);
    const add = term / (2 * k + 1);
    sum += add;
    if (Math.abs(add) <= 1e-17 * Math.abs(sum)) break;
  }
  return sum / Math.sqrt(2 * Math.PI);
}
function erfc(z: number): number { // z >= 0
  const t = 1 / (1 + 0.5 * z);
  return t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
}
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

// ---------------------------------------------------------------------------------------------
// Re-score noise: how much does the score itself move when you grade the EXACT SAME bytes twice?
// ---------------------------------------------------------------------------------------------
//
// A binomial noise floor (above) assumes the only source of variance is which tasks get drawn. In
// practice a grader can also be noisy ON THE SAME task set — flaky test infra, a judge model that
// doesn't always call the same verdict, environment nondeterminism. The way to measure THAT
// specific noise source is to score the identical artifact twice and look at the paired
// differences; this is independent of (and typically additive with) sampling noise.

/** Per-draw standard deviation implied by a set of PAIRED re-score differences on identical
 *  bytes (same submission, same tasks, scored twice; `diffs[i]` = score_b[i] - score_a[i]).
 *  Under the null that both scorings target the same true value, each diff has variance
 *  2 * sigma^2 (the sum of two independent per-draw variances), so sigma = RMS(diff) / sqrt(2).
 *  Uses RMS (root-mean-square, deviation from zero) rather than sample SD (deviation from the
 *  diffs' own mean) deliberately: the null hypothesis IS that the true mean diff is zero, and
 *  RMS is the right estimator of variance around a known, not an estimated, center. */
export function perDrawSdFromPairedRescores(diffs: number[]): number {
  if (diffs.length === 0) throw new Error("need at least one paired re-score difference");
  const { scale, sumSq } = scaledSumOfSquares(diffs);
  return scale * Math.sqrt(sumSq / diffs.length) / Math.SQRT2;
}

/** Sum of squares as scale^2 * sumSq, so it neither overflows (diffs near 1e200) nor underflows (near 1e-200).
 *  Ordinary magnitudes use scale 1 and the plain sum, so everyday results are bit-for-bit what d*d gives. */
export function scaledSumOfSquares(xs: number[]): { scale: number; sumSq: number } {
  let m = 0;
  for (const x of xs) { if (!Number.isFinite(x)) throw new Error(`not a finite number: ${x}`); m = Math.max(m, Math.abs(x)); }
  if (m === 0 || (m >= 1e-150 && m <= 1e150)) return { scale: 1, sumSq: xs.reduce((s, x) => s + x * x, 0) };
  return { scale: m, sumSq: xs.reduce((s, x) => s + (x / m) * (x / m), 0) };
}

export interface HeadToHead {
  win: number;
  tie: number;
  loss: number;
}

/** Probability a candidate arm "wins" a head-to-head re-run against a baseline arm, where both
 *  are independent draws of n tasks and the candidate's TRUE rate is the baseline's rate plus an
 *  effect of `effectTasks` additional expected solves out of n (p2 = p1 + effectTasks / n).
 *  win = P(candidate > baseline), tie = P(candidate == baseline), loss = P(candidate < baseline),
 *  computed by exact convolution of the two binomial distributions (no normal approximation —
 *  n is usually small enough that this is cheap and exact). */
export function headToHeadBinomial(n: number, baselineRate: number, effectTasks: number): HeadToHead {
  if (n <= 0) throw new Error("n must be positive");
  assertTasks(n);
  if (!Number.isFinite(baselineRate) || !Number.isFinite(effectTasks)) throw new Error("baselineRate and effectTasks must be numbers");
  if (baselineRate < 0 || baselineRate > 1) throw new Error("baselineRate must be in [0, 1]");
  const candidateRate = baselineRate + effectTasks / n;
  if (candidateRate < 0 || candidateRate > 1) throw new Error("baselineRate + effectTasks/n must be in [0, 1]");
  const baseline = binomialPmf(n, baselineRate);
  const candidate = binomialPmf(n, candidateRate);
  // P(Y > X), P(Y = X) and P(Y < X), each summed directly with running CDFs of Y (O(n), not O(n^2)). Rounding in the
  // pmfs can push a sum a few ulps outside [0, 1], so each is clamped at 0 and the triple divided by its total: every
  // component is then a probability and the three sum to 1.
  let win = 0, tie = 0, loss = 0, below = 0;
  for (let x = 0; x <= n; x++) {
    const py = candidate[x]!;
    loss += baseline[x]! * below; // P(Y < x)
    tie += baseline[x]! * py;
    below += py;
    win += baseline[x]! * Math.max(0, 1 - below); // P(Y > x)
  }
  win = Math.max(0, win); tie = Math.max(0, tie); loss = Math.max(0, loss);
  const total = win + tie + loss;
  return { win: win / total, tie: tie / total, loss: loss / total };
}

/** Same head-to-head question, but using a MEASURED per-draw SD (e.g. from
 *  `perDrawSdFromPairedRescores`) instead of assuming binomial sampling is the only noise
 *  source. Models the head-to-head difference as Normal(effectTasks, 2 * perDrawSd^2) — two
 *  independent draws, each with variance perDrawSd^2 — and reports win = P(diff > 0). There is
 *  no discrete "tie" in a continuous model, so `tie` is 0 and `loss` is the complement of `win`;
 *  this is the right tool when your noise is dominated by grader/environment variance rather
 *  than by which tasks got sampled (compare against `headToHeadBinomial`, which assumes the
 *  opposite). */
export function headToHeadNormal(effectTasks: number, perDrawSd: number): HeadToHead {
  if (perDrawSd < 0) throw new Error("perDrawSd must be non-negative");
  if (perDrawSd === 0) return effectTasks > 0 ? { win: 1, tie: 0, loss: 0 } : effectTasks < 0 ? { win: 0, tie: 0, loss: 1 } : { win: 0, tie: 1, loss: 0 };
  const sdOfDifference = Math.SQRT2 * perDrawSd;
  const win = Math.min(1, Math.max(0, normalCdf(effectTasks / sdOfDifference)));
  return { win, tie: 0, loss: 1 - win };
}

// ---------------------------------------------------------------------------------------------
// False-pass rate: how often does a promotion bar pass a change with ZERO true effect?
// ---------------------------------------------------------------------------------------------
//
// A cheap stage promotes an idea when its measured effect clears a fixed bar (e.g. "+1 solve per
// draw"). If the idea has no true effect at all, the bar still gets cleared sometimes, purely from
// per-draw noise — that is the false-pass rate this section computes. Two ways a candidate can be
// compared against a baseline:
//   - "same-block control": candidate and baseline are both drawn fresh, in the same block, so the
//     comparison is a DIFFERENCE of two independent draws. Var(diff) = 2 * perDrawSd^2 / drawsPerArm,
//     i.e. sdOfDifference = perDrawSd * sqrt(2 / drawsPerArm).
//   - "fixed baseline": the baseline is a known constant (e.g. a large historical average), so only
//     the candidate's own draws carry noise. sdOfDifference = perDrawSd / sqrt(drawsPerArm).
// Modeled as Normal(0, sdOfDifference) under the null of zero true effect; a "pass" is the event
// that the draw exceeds the bar, so the false-pass rate is the upper tail P(diff > bar) =
// normalSurvival(bar / sdOfDifference), P(Z > bar / sdOfDifference). This is a one-sided tail (a promotion bar only cares about
// clearing it from below, not a symmetric two-sided difference).

export interface FalsePassParams {
  /** Measured per-draw standard deviation (same unit as `bar`, e.g. "solves per draw"). */
  perDrawSd: number;
  /** The promotion bar: a difference in mean solves per draw strictly above zero true effect. */
  bar: number;
  /** Number of draws used per arm (candidate and baseline each get this many draws). */
  drawsPerArm: number;
  /** true: candidate vs a freshly-drawn baseline in the same block. false: candidate vs a known
   *  fixed baseline value (no draw-to-draw noise on the baseline side). */
  sameBlockControl: boolean;
}

function sdOfPromotionDifference(perDrawSd: number, drawsPerArm: number, sameBlockControl: boolean): number {
  if (perDrawSd <= 0) throw new Error("perDrawSd must be positive");
  if (drawsPerArm <= 0) throw new Error("drawsPerArm must be positive");
  return sameBlockControl ? perDrawSd * Math.sqrt(2 / drawsPerArm) : perDrawSd / Math.sqrt(drawsPerArm);
}

/** Probability that a stage with zero true effect clears the promotion bar by chance alone, given
 *  a measured per-draw SD and a number of draws per arm. Normal approximation (see section header
 *  above for the exact model). */
export function falsePassRate(params: FalsePassParams): number {
  const { perDrawSd, bar, drawsPerArm, sameBlockControl } = params;
  const sd = sdOfPromotionDifference(perDrawSd, drawsPerArm, sameBlockControl);
  return normalSurvival(bar / sd);
}

/** The minimum `drawsPerArm` needed to push the false-pass rate strictly under `target`, holding
 *  `perDrawSd`/`bar`/`sameBlockControl` fixed. False-pass rate is monotonically decreasing in
 *  `drawsPerArm` (more draws per arm shrinks the noise), so a simple upward scan from n=1 is exact
 *  and terminates quickly for any realistic target/SD/bar combination. */
export function drawsForFalsePass(target: number, params: Omit<FalsePassParams, "drawsPerArm">): number {
  if (target <= 0 || target >= 1) throw new Error("target must be in (0, 1)");
  const { perDrawSd, bar, sameBlockControl } = params;
  const MAX_DRAWS = 100_000;
  for (let n = 1; n <= MAX_DRAWS; n++) {
    if (falsePassRate({ perDrawSd, bar, drawsPerArm: n, sameBlockControl }) < target) return n;
  }
  throw new Error(`no drawsPerArm up to ${MAX_DRAWS} brings the false-pass rate under ${target}`);
}

// ---------------------------------------------------------------------------------------------
// Binomial upper tail: P(X >= k) for X ~ Binomial(n, p).
// ---------------------------------------------------------------------------------------------
//
// Used to ask "how surprising is it to see at least this many passes out of this many trials, if
// the true per-trial pass probability were the null rate?" — the discrete-exact counterpart to the
// continuous false-pass-rate model above, for turning an observed (passes, trials) count into a
// significance read against a candidate null rate.

/** P(X >= k) for X ~ Binomial(n, p), via the exact PMF (stable well past any realistic campaign's
 *  trial count — see `binomialPmf` below). */
export function binomialUpperTail(n: number, k: number, p: number): number {
  if (n <= 0) throw new Error("n must be positive");
  assertTasks(n);
  if (!Number.isInteger(k) || k < 0) throw new Error("k must be a non-negative integer");
  if (p < 0 || p > 1) throw new Error("p must be in [0, 1]");
  if (k > n) return 0;
  const pmf = binomialPmf(n, p);
  let tail = 0;
  for (let x = k; x <= n; x++) tail += pmf[x]!;
  return tail;
}

/** SD of the solved COUNT of one run when task i is solved with its own probability rates[i] (independent
 *  tasks, different difficulties): sqrt(sum p_i (1 - p_i)). Always <= the binomial SD at the mean rate;
 *  equal only when every task has the same rate. Estimate rates from repeated runs of one unchanged agent. */
export function heterogeneousCountSd(rates: number[]): number {
  if (!rates.length) throw new Error("need at least one task rate");
  for (const p of rates) if (!(p >= 0 && p <= 1)) throw new Error("every rate must be in [0, 1]");
  return Math.sqrt(rates.reduce((s, p) => s + p * (1 - p), 0));
}

/** Exact McNemar test for two runs on the SAME tasks. `aOnly` = tasks run A solved and B did not, `bOnly` the
 *  reverse; tasks both solved or both missed carry no information about the difference. Under "no difference"
 *  each discordant task is a fair coin: two-sided p = min(1, 2 * P(X <= min(aOnly, bOnly))), X ~ Bin(aOnly+bOnly, 1/2). */
export const MCNEMAR_MAX_DISCORDANT = 100_000_000;

export function mcNemarExact(aOnly: number, bOnly: number): { discordant: number; pValue: number } {
  for (const [nm, v] of [["aOnly", aOnly], ["bOnly", bOnly]] as const) if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${nm} must be a non-negative whole number`);
  const m = aOnly + bOnly;
  // the first term comes from log-gamma differences whose absolute error grows with m log m; past 1e8 it is no longer
  // trustworthy to the digits a p-value needs (and no task slate is that large)
  if (m > MCNEMAR_MAX_DISCORDANT) throw new Error(`aOnly + bOnly above ${MCNEMAR_MAX_DISCORDANT} is not supported`);
  if (m === 0) return { discordant: 0, pValue: 1 };
  const lo = Math.min(aOnly, bOnly);
  // P(X <= lo) for X ~ Bin(m, 1/2), summed downward from lo with the term ratio x / (m - x + 1); terms fall off
  // geometrically below lo < m/2, so this stops after O(sqrt(m)) terms instead of building a pmf of length m
  let term = Math.exp(logChoose(m, lo) - m * Math.LN2), tail = 0;
  for (let x = lo; x >= 0; x--) {
    tail += term;
    if (term < tail * 1e-17) break;
    term *= x / (m - x + 1);
  }
  return { discordant: m, pValue: Math.min(1, 2 * tail) };
}

/** Exact binomial PMF over k = 0..n at rate p, via log-space binomial coefficients (stable for
 *  n into the low hundreds, which covers any evaluation slate this module is meant for). */
function binomialPmf(n: number, p: number): number[] {
  const out = new Array<number>(n + 1);
  for (let k = 0; k <= n; k++) {
    out[k] = p === 0 ? (k === 0 ? 1 : 0) : p === 1 ? (k === n ? 1 : 0) : Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p));
  }
  return out;
}
function logChoose(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}
function logFactorial(n: number): number {
  return logGamma(n + 1);
}
// Lanczos approximation to log(Gamma(x)) — exact factorials would overflow well before n=170.
function logGamma(x: number): number {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < 8; i++) a += g[i] / (x + i + 1);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
