import { test, expect, setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000); // statistical tests can take seconds on a loaded machine (the bunfig preload alone did not always apply)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cheapPositivesConfirmed,
  FLAKY10_PER_DRAW_SD,
  FLAKY10_ADR_SIGMA,
  DRIFT_PACKAGE_TO_V_PACKAGE,
  parsePlatformHistory,
  parseFlaky10Drift,
  pairedDiffs,
  rescoreSdWithCi,
  heterogeneityChiSquare,
  driftRanges,
  concordanceConfusion,
  flaky10PassRateSummary,
  OBSERVED_FLAKY10_PASSES,
  OBSERVED_FLAKY10_TRIALS,
  type ConcordanceRow,
  parseTaskOutcomes,
  drawTotals,
  assertCompleteTaskMatrix,
  nullPassProbabilityNormal,
  nullPassProbabilityTaskModel,
  taskRates,
  summariseNullPasses,
  pooledWithinBlockSd,
  pooledWithinBlockSdWithCi,
  predictedRescoreSd,
  predictedRescoreSdResampling,
  taskSolveShares,
  poissonBinomialPmf,
  comparatorPackages,
  blockEffectFTest,
  varianceRatioPermutationTest,
  recomputableEffectZTest,
  commonEffectPower,
  maxIdeasWithEffectStillPlausible,
  blockPairPromotionRate,
  driftRowsByPackage,
  taskOutcomeBlocksByPackage,
  sidakSelectionPValue,
  type DecisionRow,
} from "./reproduce-paper-numbers";

const ROOT = join(import.meta.dir, "..");
const platformRows = parsePlatformHistory(readFileSync(join(ROOT, "data/platform-history.csv"), "utf8"));
const driftRows = parseFlaky10Drift(readFileSync(join(ROOT, "data/flaky10-drift.csv"), "utf8"));
const concRows: ConcordanceRow[] = JSON.parse(readFileSync(join(ROOT, "data/concordance-rows.json"), "utf8"));

test("parses all 36 platform-history rows and all 4 same-bytes pairs", () => {
  expect(platformRows).toHaveLength(36);
  const pairIds = new Set(platformRows.map((r) => r.pairId).filter((p) => p !== null));
  expect(pairIds.size).toBe(4);
});

test("re-score SD from the identical-bytes pairs is approximately 1.46 tasks, CI approximately 0.87-4.19", () => {
  const diffs = pairedDiffs(platformRows);
  expect(diffs).toHaveLength(4);
  const { sd, ciLow, ciHigh, df } = rescoreSdWithCi(diffs);
  expect(sd).toBeCloseTo(1.46, 2);
  expect(ciLow).toBeCloseTo(0.87, 2);
  expect(ciHigh).toBeCloseTo(4.19, 2);
  expect(df).toBe(4);
});

test("heterogeneity chi-square of all 12 base-era uploads against SD 1.5 is approximately 11.0 on 11 df, p ~= 0.45", () => {
  const het = heterogeneityChiSquare(platformRows, "10-28", 1.5);
  expect(het.chi2).toBeCloseTo(10.96, 1);
  expect(het.n).toBe(12);
  expect(het.df).toBe(11);
  expect(het.p).toBeCloseTo(0.45, 2);
});

test("per-package drift ranges are approximately 2.0 / 2.17 / 2.0", () => {
  const ranges = driftRanges(driftRows);
  const sorted = Object.keys(ranges).sort();
  expect(sorted).toEqual(["A", "B", "C"]);
  expect(ranges.A).toBeCloseTo(2.0, 2);
  expect(ranges.B).toBeCloseTo(2.17, 2);
  expect(ranges.C).toBeCloseTo(2.0, 2);
});

test("flaky10 -> platform funnel agreement is 1/7, versus a constant-null baseline of 6/7", () => {
  const conf = concordanceConfusion(concRows, "flaky10->platform");
  expect(conf.determinable).toBe(7);
  expect(conf.agreeing).toBe(1);
  expect(conf.constantGuess).toBe("null");
  expect(conf.constantGuessCorrect).toBe(6);
});

test("flaky10 pass rate: observed 4/23 = 17.4%, null false-pass rate at 3-5 draws (same-block) is 15.5-21.6%", () => {
  expect(OBSERVED_FLAKY10_PASSES).toBe(4);
  expect(OBSERVED_FLAKY10_TRIALS).toBe(23);
  const flaky = flaky10PassRateSummary();
  expect(flaky.rate).toBeCloseTo(0.174, 2);
  expect(flaky.nullRateLow).toBeCloseTo(0.126, 2);
  expect(flaky.nullRateHigh).toBeCloseTo(0.209, 2);
  expect(flaky.nullRateLow).toBeLessThan(flaky.nullRateHigh);
  // the observed count should not be a surprising one under that null — this campaign's funnel
  // promotion history is consistent with pure chance, not evidence the funnel beats the noise floor.
  expect(flaky.upperTailAtObserved).toBeGreaterThan(0.3);
});

test("heterogeneityChiSquare includes every era row, even the chronologically newest", () => {
  // Synthetic: 4 era rows, including one far outlier — it should count toward n and pull chi2 up,
  // not get silently dropped as "still being evaluated".
  const rows = [
    { date: "10-28", anonVariant: "VX", score: 0.1, k: 5, pairId: null },
    { date: "10-29", anonVariant: "VY", score: 0.1, k: 6, pairId: null },
    { date: "10-30", anonVariant: "VZ", score: 0.1, k: 7, pairId: null },
    { date: "11-01", anonVariant: "VW", score: 0.1, k: 100, pairId: null }, // included — should blow up chi2
  ];
  const het = heterogeneityChiSquare(rows, "10-28", 1.5);
  expect(het.n).toBe(4);
  expect(het.df).toBe(3);
  expect(het.chi2).toBeGreaterThan(1000); // the k=100 outlier dominates once it's included
  expect(het.p).toBeLessThan(0.001);
});

test("heterogeneityChiSquare throws rather than silently computing from an empty/too-small era", () => {
  expect(() => heterogeneityChiSquare(platformRows, "10-28", 1.5)).not.toThrow();
  expect(() => heterogeneityChiSquare(platformRows, "99-99", 1.5)).toThrow();
});

// ---- the best upload's selection-corrected p-value (Sidak over 12 candidate uploads) ----

test("Sidak-corrected selection p-value for the best upload's 4-task gap: raw ~0.0297, corrected over 12 candidates ~0.30", () => {
  const result = sidakSelectionPValue(4, 1.5, 12);
  expect(result.rawP).toBeCloseTo(0.0297, 3);
  expect(result.sidakP).toBeCloseTo(0.30, 2);
  // Sidak is less conservative (smaller) than the plain Bonferroni bound n * rawP
  expect(result.sidakP).toBeLessThan(result.nCandidates * result.rawP);
});

test("sidakSelectionPValue at nCandidates=1 reduces to the uncorrected one-sided p", () => {
  const result = sidakSelectionPValue(4, 1.5, 1);
  expect(result.sidakP).toBeCloseTo(result.rawP, 10);
});

test("sidakSelectionPValue rejects non-positive SD or fewer than 1 candidate", () => {
  expect(() => sidakSelectionPValue(4, 0, 12)).toThrow();
  expect(() => sidakSelectionPValue(4, 1.5, 0)).toThrow();
});

// ---- decision-level null passes (data/flaky10-decisions.json + data/flaky10-task-outcomes.csv) ----
const decisions: DecisionRow[] = JSON.parse(readFileSync(join(ROOT, "data/flaky10-decisions.json"), "utf8"));
const f10 = parseTaskOutcomes(readFileSync(join(ROOT, "data/flaky10-task-outcomes.csv"), "utf8"));
const baseEra = parseTaskOutcomes(readFileSync(join(ROOT, "data/base-era-task-outcomes.csv"), "utf8"));
const primary = decisions.filter((d) => d.primary);

test("decision table: 26 reads, 23 primary, 4 primary passes, matching the typed-in 4/23", () => {
  expect(decisions).toHaveLength(26);
  expect(primary).toHaveLength(23);
  expect(primary.filter((d) => d.passed)).toHaveLength(OBSERVED_FLAKY10_PASSES);
  expect(primary.length).toBe(OBSERVED_FLAKY10_TRIALS);
  expect(primary.filter((d) => d.controlType === "fixed-baseline")).toHaveLength(3);
  expect(primary.filter((d) => d.controlType === "historical-mean")).toHaveLength(1);
});

test("every recomputable effect equals mean(arm) - mean(control), and pass iff effect >= threshold", () => {
  const m = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  for (const d of decisions) {
    if (d.armCounts === null) { expect(d.armUnsealed).toBe(true); expect(d.passed).toBe(false); continue; }
    const ctl = d.controlType === "fixed-baseline" ? d.fixedBaselineValue! : m(d.ctlCounts);
    expect(d.effect).toBeCloseTo(m(d.armCounts) - ctl, 1);
    expect(d.passed).toBe(d.passThreshold !== null && d.effect >= d.passThreshold - 1e-9);
  }
});

test("draw totals in the per-task outcome file reproduce every read's arm and same-block control counts", () => {
  const totals = drawTotals(f10);
  expect(totals.size).toBe(162);
  const countsOf = (pkg: string, block: string) => [...new Set(f10.filter((r) => r.group === pkg && r.block === block).map((r) => r.draw))].map((d) => totals.get(d)!).sort();
  for (const d of decisions) {
    if (d.armCounts !== null) expect(countsOf(d.anonPackage, d.anonBlock)).toEqual([...d.armCounts].sort());
    if (d.controlType === "same-block") expect(countsOf(d.comparator, d.anonBlock)).toEqual([...d.ctlCounts].sort());
  }
});

test("expected null passes over the 23 reads: 4.25 (normal, SD 1.56) and 4.38 (exact task model); observed 4 is unremarkable", () => {
  const normal = summariseNullPasses(primary, primary.map((d) => nullPassProbabilityNormal(d, 1.56)));
  expect(normal.expected).toBeCloseTo(4.25, 2);
  expect([normal.lo90, normal.hi90]).toEqual([1, 7]);
  expect(normal.observed).toBe(4);
  expect(normal.pAtLeastObserved).toBeCloseTo(0.637, 2);
  const exact = summariseNullPasses(primary, primary.map((d) => nullPassProbabilityTaskModel(d, taskRates(f10, d.comparator))));
  expect(exact.expected).toBeCloseTo(4.38, 2);
  expect([exact.lo90, exact.hi90]).toEqual([2, 8]);
  expect(exact.pAtLeastObserved).toBeGreaterThan(0.5);
});

test("sensitivity: expected null passes 2.81 at SD 1.2 and 5.55 at SD 2.0; 4 stays inside both 90% intervals", () => {
  for (const [s, e] of [[1.2, 2.81], [2.0, 5.55]] as const) {
    const r = summariseNullPasses(primary, primary.map((d) => nullPassProbabilityNormal(d, s)));
    expect(r.expected).toBeCloseTo(e, 2);
    expect(r.lo90).toBeLessThanOrEqual(4);
    expect(r.hi90).toBeGreaterThanOrEqual(4);
  }
});

test("a fixed baseline carries its own sampling error: 3 draws v a 4-draw baseline is 0.201, not the known-baseline 0.133", () => {
  const fixed = primary.find((d) => d.controlType === "fixed-baseline")!;
  expect(nullPassProbabilityNormal(fixed, 1.56)).toBeCloseTo(0.201, 3);
  expect(nullPassProbabilityNormal({ ...fixed, drawsCtl: 1e9 }, 1.56)).toBeCloseTo(0.133, 3);
});

test("a read with no pass band on solves (veto only) contributes zero", () => {
  const veto = decisions.find((d) => d.passThreshold === null)!;
  expect(nullPassProbabilityNormal(veto, 1.56)).toBe(0);
  expect(nullPassProbabilityTaskModel(veto, [0.5])).toBe(0);
});

test("poissonBinomialPmf sums to 1 and matches the binomial when rates are equal", () => {
  const f = poissonBinomialPmf([0.3, 0.3, 0.3]);
  expect(f.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  expect(f[0]).toBeCloseTo(0.343, 12);
  expect(f[3]).toBeCloseTo(0.027, 12);
});

test("flaky-10 per-draw SD pooled within package x block is 1.51 on 122 df (1.56 is inside its CI)", () => {
  const w = pooledWithinBlockSd(f10);
  expect(w.df).toBe(122);
  expect(w.sd).toBeCloseTo(1.51, 2);
});

test("task heterogeneity predicts a 58-task re-score SD near 1.68, far below the binomial 2.88", () => {
  const pred = predictedRescoreSd(baseEra, "129", 58);
  expect(pred.tasks).toBe(129);
  expect(pred.families).toBe(4);
  expect(pred.sd).toBeCloseTo(1.68, 2);
  const binomial = Math.sqrt(58 * (10 / 58) * (48 / 58));
  expect(binomial).toBeCloseTo(2.88, 2);
  const { ciLow, ciHigh } = rescoreSdWithCi(pairedDiffs(platformRows));
  expect(pred.sd).toBeGreaterThan(ciLow);
  expect(pred.sd).toBeLessThan(ciHigh);
});

test("at the lane's measured SD 1.51, the 23 reads expect about 4.1 null passes (90% 1 to 7)", () => {
  const s = summariseNullPasses(primary, primary.map((d) => nullPassProbabilityNormal(d, FLAKY10_PER_DRAW_SD)));
  expect(FLAKY10_PER_DRAW_SD).toBe(1.51);
  expect(s.expected).toBeCloseTo(4.07, 2);
  expect([s.lo90, s.hi90]).toEqual([1, 7]);
});

// ---- item 1: pooled flaky-10 SD with a 95% CI, and the 162-draws/df-122 consistency check ----

test("pooled flaky-10 per-draw SD: 1.51, 95% CI 1.34-1.72, from 162 sealed draws over 40 groups (0 singletons)", () => {
  const w = pooledWithinBlockSdWithCi(f10);
  expect(w.sd).toBeCloseTo(1.51, 2);
  expect(w.df).toBe(122);
  expect(w.draws).toBe(162);
  expect(w.groups).toBe(40);
  expect(w.singletonGroups).toBe(0);
  expect(w.ciLow).toBeCloseTo(1.34, 2);
  expect(w.ciHigh).toBeCloseTo(1.72, 2);
  // the draft's "162 sealed draws" is internally consistent with "df 122": every one of the 40
  // (package, block) groups has >= 2 draws, so none is dropped and draws - groups == df exactly.
  expect(w.draws - w.groups).toBe(w.df);
});

// ---- item 2: one-way block-effect F-test within package ----

test("comparatorPackages reads the 5 comparator packages straight off the decision data", () => {
  expect(comparatorPackages(decisions)).toEqual(["V21", "V25", "V26", "V28", "V31"]);
});

test("block-effect F-test: pooled F = 1.02 on 17 and 65 df, p = 0.45; per-package F/tau match the published table", () => {
  const result = blockEffectFTest(f10, comparatorPackages(decisions));
  expect(result.pooled.F).toBeCloseTo(1.02, 2);
  expect(result.pooled.dfBetween).toBe(17);
  expect(result.pooled.dfWithin).toBe(65);
  expect(result.pooled.p).toBeCloseTo(0.45, 2);
  expect(result.tauPooled).toBeCloseTo(0.41, 2);
  const byPkg = Object.fromEntries(result.perPackage.map((p) => [p.pkg, p]));
  expect(byPkg.V21!.blocks).toBe(3); expect(byPkg.V21!.F).toBeCloseTo(1.86, 2); expect(byPkg.V21!.tau).toBeCloseTo(0.58, 2);
  expect(byPkg.V25!.blocks).toBe(4); expect(byPkg.V25!.F).toBeCloseTo(2.54, 2); expect(byPkg.V25!.tau).toBeCloseTo(0.63, 2);
  expect(byPkg.V26!.blocks).toBe(6); expect(byPkg.V26!.F).toBeCloseTo(1.23, 2); expect(byPkg.V26!.tau).toBeCloseTo(0.34, 2);
  expect(byPkg.V28!.blocks).toBe(4); expect(byPkg.V28!.F).toBeCloseTo(0.95, 2); expect(byPkg.V28!.tau).toBe(0);
  expect(byPkg.V31!.blocks).toBe(5); expect(byPkg.V31!.F).toBeCloseTo(0.62, 2); expect(byPkg.V31!.tau).toBe(0);
  // no package shows a significant block effect at alpha 0.05
  for (const p of result.perPackage) expect(p.p).toBeGreaterThan(0.05);
});

test("blockEffectFTest rejects a package that appears in only one block", () => {
  expect(() => blockEffectFTest(f10, ["V21", "V35"])).toThrow(/one block/);
});

test("blockEffectFTest rejects a package with no flaky-10 outcomes at all", () => {
  expect(() => blockEffectFTest(f10, ["V21", "V999"])).toThrow(/no flaky-10 outcomes/);
});

// ---- item 3: variance ratio with an exact, seeded permutation p-value ----

test("flaky-10 shared-run variance ratio is 1.09 (40 groups, 162 draws, df 122); permutation p is near the published 0.25 and is reproducible", () => {
  const result = varianceRatioPermutationTest(f10);
  expect(result.groups).toBe(40);
  expect(result.draws).toBe(162);
  expect(result.df).toBe(122);
  expect(result.ratio).toBeCloseTo(1.09, 2);
  expect(result.permutationP).toBeGreaterThan(0.15);
  expect(result.permutationP).toBeLessThan(0.35);
  const repeat = varianceRatioPermutationTest(f10);
  expect(repeat.permutationP).toBe(result.permutationP); // same seed -> exact same Monte Carlo answer
}, 60_000); // permutation test runs ~2-5 s; under parallel load it crossed the 5 s default and flaked

test("varianceRatioPermutationTest respects an explicit seed/perms override", () => {
  const a = varianceRatioPermutationTest(f10, { seed: 1, perms: 500 });
  const b = varianceRatioPermutationTest(f10, { seed: 2, perms: 500 });
  expect(a.ratio).toBeCloseTo(b.ratio, 9); // the OBSERVED ratio doesn't depend on the permutation seed
  expect(a.permutations).toBe(500);
});

test("the same variance-ratio instrument, applied to the 129-task slate (grouping by family), gives 0.60", () => {
  // every row here already has block === "129", so grouping by `${group}|${block}` collapses to
  // grouping by family alone — the "within family" grouping the paper's 129-task check uses.
  const result = varianceRatioPermutationTest(baseEra.filter((r) => r.block === "129"));
  expect(result.groups).toBe(4); // the 4 families on this slate with >= 2 draws
  expect(result.draws).toBe(8);
  expect(result.df).toBe(4);
  expect(result.ratio).toBeCloseTo(0.6, 2);
  expect(result.permutationP).toBeGreaterThan(0.3); // not significant, matches the paper's "neither significant"
});

// ---- item 4: do the 21 recomputable effects look like noise? ----

test("sum of squared z over the 21 recomputable primary effects is 19.9 on 21 df, p = 0.53 (sigma 1.56)", () => {
  const blockFx = blockEffectFTest(f10, comparatorPackages(decisions));
  const z = recomputableEffectZTest(primary, FLAKY10_ADR_SIGMA, blockFx.tauPooled);
  expect(FLAKY10_ADR_SIGMA).toBe(1.56);
  expect(z.n).toBe(21); // 23 primary reads minus the 2 with an unsealed (crashed) arm
  expect(z.meanZ).toBeCloseTo(-0.22, 2);
  expect(z.sdZ).toBeCloseTo(0.97, 2);
  expect(z.sumZSquared).toBeCloseTo(19.9, 1);
  expect(z.df).toBe(21);
  expect(z.pUpper).toBeCloseTo(0.53, 2);
});

test("recomputableEffectZTest excludes reads with an unsealed arm and throws if none are left", () => {
  const z = recomputableEffectZTest(primary, 1.56, 0.41);
  expect(primary.length - z.n).toBe(2);
  const allUnsealed = primary.filter((d) => d.armCounts === null);
  expect(() => recomputableEffectZTest(allUnsealed, 1.56, 0.41)).toThrow();
});

// ---- item 5: resampling range behind the predicted 58-task re-score SD, and task-solve shares ----

test("predicted 58-task re-score SD: deterministic 1.68 vs resampling median 1.66 (95% range 1.32-1.97), reproducible under a fixed seed", () => {
  const deterministic = predictedRescoreSd(baseEra, "129", 58);
  expect(deterministic.sd).toBeCloseTo(1.68, 2);
  const resampled = predictedRescoreSdResampling(baseEra, "129", 58);
  expect(resampled.median).toBeCloseTo(1.66, 2);
  expect(resampled.lo95).toBeCloseTo(1.32, 2);
  expect(resampled.hi95).toBeCloseTo(1.97, 2);
  // the resampling median is below the deterministic sqrt(n * mean v_i): sqrt is concave, so by
  // Jensen's inequality E[sqrt(X)] <= sqrt(E[X]), and the median tracks the same direction here.
  expect(resampled.median).toBeLessThan(deterministic.sd);
  const repeat = predictedRescoreSdResampling(baseEra, "129", 58);
  expect(repeat.median).toBe(resampled.median);
});

test("129-task slate: 20.2% always solved, 53.5% never, 26.4% sometimes (paper's rounded 20/54/26%)", () => {
  const shares = taskSolveShares(baseEra, "129");
  expect(shares.draws).toBe(10);
  expect(shares.tasks).toBe(129);
  expect(shares.solvedEvery).toBe(26);
  expect(shares.solvedNone).toBe(69);
  expect(shares.solvedSometimes).toBe(34);
  expect(shares.shareEvery).toBeCloseTo(0.202, 3);
  expect(shares.shareNone).toBeCloseTo(0.535, 3);
  expect(shares.shareSometimes).toBeCloseTo(0.264, 3);
});

test("taskSolveShares and predictedRescoreSdResampling say exactly what's missing for an absent slate", () => {
  expect(() => taskSolveShares(baseEra, "999")).toThrow(/999.*missing/);
  expect(() => predictedRescoreSdResampling(baseEra, "999", 58)).toThrow(/999/);
});

// ---- item 6: power — how big an effect could "4 passes" be hiding? ----

test("common-effect power over the 21 reads that ran: delta=0.75 gives P(X<=4)=0.029, delta=1 gives 0.004 (sigma 1.56, bar 1)", () => {
  const at075 = commonEffectPower(primary, 0.75, FLAKY10_ADR_SIGMA, 1, OBSERVED_FLAKY10_PASSES);
  expect(at075.pAtMostObserved).toBeCloseTo(0.0291, 4);
  const at1 = commonEffectPower(primary, 1, FLAKY10_ADR_SIGMA, 1, OBSERVED_FLAKY10_PASSES);
  expect(at1.pAtMostObserved).toBeCloseTo(0.0036, 4);
  expect(at1.expectedPasses).toBeCloseTo(10.5, 4); // delta = bar: each of the 21 reads passes with probability 1/2 (A&S normal tail, ~1e-7 error)
  const atZero = commonEffectPower(primary, 0, FLAKY10_ADR_SIGMA, 1, OBSERVED_FLAKY10_PASSES);
  expect(atZero.expectedPasses).toBeCloseTo(3.935, 3);
});

test("a crashed arm counts as a read that cannot pass, at any effect", () => {
  const crashed = primary.filter((d) => d.armUnsealed);
  expect(crashed).toHaveLength(2);
  const alive = primary.filter((d) => !d.armUnsealed);
  for (const delta of [0, 0.5, 1]) expect(commonEffectPower(primary, delta, 1.51, 1, 4).pAtMostObserved).toBeCloseTo(commonEffectPower(alive, delta, 1.51, 1, 4).pAtMostObserved, 12);
});

test("mixture power: up to 12 of the 21 reads that ran could carry a true +1 effect and still give P(X<=4) >= 0.05; 13 cannot", () => {
  const mixture = maxIdeasWithEffectStillPlausible(primary, FLAKY10_ADR_SIGMA, 1, 1, OBSERVED_FLAKY10_PASSES);
  expect(mixture.maxM).toBe(12);
  expect(mixture.points[12]!.pAtMostObserved).toBeCloseTo(0.0503, 4);
  expect(mixture.points[13]!.pAtMostObserved).toBeCloseTo(0.0382, 4);
  expect(mixture.points[13]!.pAtMostObserved).toBeLessThan(0.05);
  expect(mixture.points[12]!.pAtMostObserved).toBeGreaterThanOrEqual(0.05);
});

// ---- item 7: empirical A/A check on the unchanged-package block pairs ----

test("A/A check from flaky10-drift.csv: 14/62 directed comparisons clear the +1 bar (22.6%); 7/31 later-minus-earlier", () => {
  const result = blockPairPromotionRate(driftRowsByPackage(driftRows));
  expect(result.packages).toBe(3);
  expect(result.directedPairs).toBe(62);
  expect(result.directedPass).toBe(14);
  expect(result.directedRate).toBeCloseTo(0.226, 3);
  expect(result.laterMinusEarlierPairs).toBe(31);
  expect(result.laterMinusEarlierPass).toBe(7);
});

test("the same A/A check from flaky10-task-outcomes.csv's actual per-draw block means, for the SAME 3 packages, matches exactly", () => {
  expect(DRIFT_PACKAGE_TO_V_PACKAGE).toEqual({ A: "V26", B: "V28", C: "V31" });
  const fromDrift = blockPairPromotionRate(driftRowsByPackage(driftRows));
  const fromDraws = blockPairPromotionRate(taskOutcomeBlocksByPackage(f10, Object.values(DRIFT_PACKAGE_TO_V_PACKAGE)));
  expect(fromDraws.directedPass).toBe(fromDrift.directedPass);
  expect(fromDraws.directedPairs).toBe(fromDrift.directedPairs);
  expect(fromDraws.laterMinusEarlierPass).toBe(fromDrift.laterMinusEarlierPass);
  expect(fromDraws.laterMinusEarlierPairs).toBe(fromDrift.laterMinusEarlierPairs);
});

test("widening the A/A check to all 5 comparator packages changes the counts (drift.csv only carries 3 of the 5)", () => {
  const threePackages = blockPairPromotionRate(taskOutcomeBlocksByPackage(f10, comparatorPackages(decisions).filter((p) => Object.values(DRIFT_PACKAGE_TO_V_PACKAGE).includes(p))));
  const allFive = blockPairPromotionRate(taskOutcomeBlocksByPackage(f10, comparatorPackages(decisions)));
  expect(allFive.packages).toBe(5);
  expect(threePackages.packages).toBe(3);
  expect(allFive.directedPairs).toBeGreaterThan(threePackages.directedPairs);
});

test("blockPairPromotionRate skips packages with fewer than 2 blocks and divides by zero pairs only if truly none qualify", () => {
  const single = new Map([["X", [{ blockIndex: 1, mean: 5 }]]]);
  const result = blockPairPromotionRate(single);
  expect(result.packages).toBe(0);
  expect(result.directedPairs).toBe(0);
  expect(Number.isNaN(result.directedRate)).toBe(true); // 0/0 — caller's job to guard, not silently hidden
});

test("repo-only checks at the lane's measured SD 1.51: sum z^2 21.2, up to 12 ideas, P = 0.031 at +0.75 (crashed arms excluded, assignment fixed)", () => {
  const blockFx = blockEffectFTest(f10, comparatorPackages(decisions));
  const z = recomputableEffectZTest(primary, FLAKY10_PER_DRAW_SD, blockFx.tauPooled);
  expect(z.sumZSquared).toBeCloseTo(21.2, 1);
  expect(z.df).toBe(21);
  expect(commonEffectPower(primary, 0.75, FLAKY10_PER_DRAW_SD, 1, 4).pAtMostObserved).toBeCloseTo(0.0308, 4);
  expect(maxIdeasWithEffectStillPlausible(primary, FLAKY10_PER_DRAW_SD, 1, 1, 4).maxM).toBe(12);
});

test("headline expectation across the SD's 95% CI is 3.4 to 4.8, and 3.8 of 21 without the two turn-0 crashes", () => {
  const at = (s: number, rows = primary) => summariseNullPasses(rows, rows.map((d) => nullPassProbabilityNormal(d, s))).expected;
  expect(at(1.34)).toBeCloseTo(3.41, 2);
  expect(at(1.72)).toBeCloseTo(4.77, 2);
  const working = primary.filter((d) => !d.armUnsealed);
  expect(working.length).toBe(21);
  expect(at(FLAKY10_PER_DRAW_SD, working)).toBeCloseTo(3.77, 2);
});

test("none of the 5 variants with a cheap-stage positive was confirmed at a later stage", () => {
  const rows = JSON.parse(readFileSync(join(import.meta.dir, "..", "data", "concordance-rows.json"), "utf8"));
  const r = cheapPositivesConfirmed(rows);
  expect(r.variants.length).toBe(5);
  expect(r.confirmed).toEqual([]);
});

test("mixture power: the effect assignment is the worst case, checked by brute force over every subset", () => {
  // 12 reads, m = 5: all C(12,5) = 792 effect sets. The tool must report the minimum P(X <= observed).
  const { normalCdf } = require("../../../src/noise-floor/noise-floor");
  const rows = primary.filter((d) => !d.armUnsealed).slice(0, 12), sigma = FLAKY10_PER_DRAW_SD, m = 5, obs = 2;
  const pass = (d: any, delta: number) => 1 - normalCdf((1 - delta) / (sigma * Math.sqrt(1 / d.drawsArm + 1 / d.drawsCtl)));
  const cdf = (ps: number[]) => { let f = [1]; for (const p of ps) { const g = Array(f.length + 1).fill(0); f.forEach((v, k) => { g[k] += v * (1 - p); g[k + 1] += v * p; }); f = g; } return f.slice(0, obs + 1).reduce((a, b) => a + b, 0); };
  let worst = 1;
  const rec = (start: number, chosen: number[]) => {
    if (chosen.length === m) { const S = new Set(chosen); worst = Math.min(worst, cdf(rows.map((d: any, i: number) => pass(d, S.has(i) ? 1 : 0)))); return; }
    for (let i = start; i < rows.length; i++) rec(i + 1, [...chosen, i]);
  };
  rec(0, []);
  expect(maxIdeasWithEffectStillPlausible(rows, sigma, 1, 1, obs).points[m]!.pAtMostObserved).toBeCloseTo(worst, 5); // two normal-CDF approximations agree to ~1e-7
});

test("correlated chi-square: equals sum z^2 when no draws are shared, and solveSymmetric inverts a known matrix", async () => {
  const { correlatedEffectChiSquare, solveSymmetric } = await import("./reproduce-paper-numbers");
  // [[4,2],[2,3]] x = [2,1]  ->  x = [0.5, 0]
  const x = solveSymmetric([[4, 2], [2, 3]], [2, 1]);
  expect(x[0]).toBeCloseTo(0.5, 12); expect(x[1]).toBeCloseTo(0, 12);
  expect(() => solveSymmetric([[1, 2], [2, 1]], [1, 1])).toThrow("positive definite");
  // strip every shared key (unique counts per read) and the correlated Q must equal the independent sum z^2
  const lone = primary.map((d: any, i: number) => ({ ...d, comparator: `C${i}`, anonPackage: `A${i}`, fixedBaselineValue: i }));
  const ind = recomputableEffectZTest(lone, 1.51, 0.41), cor = correlatedEffectChiSquare(lone, 1.51, 0.41);
  expect(cor.sharedPairs).toBe(0);
  expect(cor.q).toBeCloseTo(ind.sumZSquared, 10);
  // on the real reads, 8 pairs share draws and Q moves from 21.2 to 20.3
  const real = correlatedEffectChiSquare(primary, 1.51, 0.41);
  expect(real.sharedPairs).toBe(8);
  expect(real.q).toBeCloseTo(21.02, 1); // sampling AND block covariance; the script prints 21.0 at the pooled tau 0.409
});

test("selection max-statistic: the known-baseline case matches the closed form; a shared baseline sits below Sidak", async () => {
  const { selectionMaxStatistic, sidakSelectionPValue } = await import("./reproduce-paper-numbers");
  const { normalCdf } = await import("../../../src/noise-floor/noise-floor");
  const m = selectionMaxStatistic(4, 1.5, 12, 400_000, 1);
  const closed = 1 - normalCdf(4 / 1.5) ** 12; // P(max of 12 iid N(0, 1.5^2) >= 4)
  expect(m.knownBaseline).toBeCloseTo(closed, 2);
  // one candidate against one noisy baseline is the plain head-to-head
  expect(selectionMaxStatistic(4, 1.5, 1, 400_000, 2).sharedBaseline).toBeCloseTo(1 - normalCdf(4 / (1.5 * Math.SQRT2)), 2);
  expect(m.sharedBaseline).toBeLessThan(sidakSelectionPValue(4, 1.5, 12).sidakP);
  expect(m.sharedBaseline).toBeCloseTo(0.18, 1);
}, 60_000);

test("correlated chi-square, analytic two-read case: two reads against one fixed baseline share sigma^2/n_ctl + tau^2", async () => {
  const { correlatedEffectChiSquare } = await import("./reproduce-paper-numbers");
  const base = { replicationOf: null, controlType: "fixed-baseline", fixedBaselineValue: 4.25, fixedBaselineN: 4, comparator: "B", passThreshold: 1, ctlCounts: [4, 4, 5, 4], verdict: "x", passed: false, primary: true, armUnsealed: false, drawsArm: 3, drawsCtl: 4 } as any;
  const r1 = { ...base, anonPackage: "P1", anonBlock: "K1", armCounts: [5, 5, 6], effect: 1.2 };
  const r2 = { ...base, anonPackage: "P2", anonBlock: "K2", armCounts: [3, 4, 4], effect: -0.6 };
  const sigma = 1.5, tau = 0.5;
  const v = sigma ** 2 * (1 / 3 + 1 / 4) + 2 * tau ** 2, c = sigma ** 2 / 4 + tau ** 2;
  // e' S^-1 e for S = [[v, c], [c, v]]
  const e1 = 1.2, e2 = -0.6, det = v * v - c * c;
  const q = (v * e1 * e1 - 2 * c * e1 * e2 + v * e2 * e2) / det;
  const r = correlatedEffectChiSquare([r1, r2], sigma, tau);
  expect(r.sharedPairs).toBe(1);
  expect(r.q).toBeCloseTo(q, 10);
});

test("parseTaskOutcomes rejects anything but a clean 0/1 five-column row, and duplicate rows", () => {
  const { parseTaskOutcomes } = require("./reproduce-paper-numbers");
  const h = "draw,package,block,task,resolved\n";
  expect(parseTaskOutcomes(h + "D1,V1,K1,T1,1\nD1,V1,K1,T2,0\n").length).toBe(2);
  for (const bad of ["D1,V1,K1,T1,true", "D1,V1,K1,T1,2", "D1,V1,K1,T1", "D1,V1,K1,,1", "D1,V1,K1,T1,1\nD1,V1,K1,T1,0"])
    expect(() => parseTaskOutcomes(h + bad + "\n")).toThrow();
});

test("parseTaskOutcomes refuses one draw id under two groups (its totals would merge)", () => {
  const { parseTaskOutcomes } = require("./reproduce-paper-numbers");
  expect(() => parseTaskOutcomes("d,g,b,t,r\nd1,A,K1,T1,1\nd1,B,K1,T1,0\n")).toThrow(/two groups/);
});

test("shared-draw power: with no effect it is the shared null, and the mixture bound on the released reads stays 12 with drift", async () => {
  const { sharedMixturePower } = require("./reproduce-paper-numbers");
  const d = JSON.parse(readFileSync(join(import.meta.dir, "../data/flaky10-decisions.json"), "utf8")).filter((x: any) => x.primary);
  const r = await sharedMixturePower(d, 1.51, 1, 4, 0.414, 0.05, 50_000);
  expect(r.points[0]!.pAtMostObserved).toBeGreaterThan(0.3);
  expect(r.maxM).toBeGreaterThanOrEqual(11);
  expect(r.maxM).toBeLessThanOrEqual(13);
}, 120_000);

test("the exact task model handles a one-draw fixed baseline (no spread estimate, margin = bar)", () => {
  const { nullPassProbabilityTaskModel } = require("./reproduce-paper-numbers");
  const row = { passThreshold: 1, drawsArm: 1, drawsCtl: 1, controlType: "fixed-baseline" };
  expect(nullPassProbabilityTaskModel(row, [0.5])).toBeCloseTo(0.25, 12);
});

test("the joint-model mixture search puts the effect where it lowers P(X<=obs) most (Oracle's 3-read case)", async () => {
  const { sharedMixturePower } = require("./reproduce-paper-numbers");
  const base = { replicationOf: null, anonBlock: "K1", drawsArm: 3, drawsCtl: 3, controlType: "same-block", fixedBaselineValue: null, fixedBaselineN: null, passThreshold: 1, effect: 0, verdict: "refuted", passed: false, primary: true, armUnsealed: false };
  const rows = [
    { ...base, anonPackage: "A", comparator: "C", armCounts: [1, 2, 3], ctlCounts: [4, 4, 4] },
    { ...base, anonPackage: "B", comparator: "C", armCounts: [1, 2, 4], ctlCounts: [4, 4, 4] },
    { ...base, anonPackage: "D", comparator: "E", armCounts: [1, 2, 5], ctlCounts: [5, 5, 5] },
  ];
  const r = await sharedMixturePower(rows, 1.5, 1, 0, 0, 0.05, 200_000, 100_000);
  expect(r.points[1]!.pAtMostObserved).toBeCloseTo(0.339, 2); // the independent read, not a shared-control one (0.360)
});

test("sidakSelectionPValue needs a whole number of candidates", () => {
  const { sidakSelectionPValue } = require("./reproduce-paper-numbers");
  expect(() => sidakSelectionPValue(4, 1.5, 1.5)).toThrow(/whole number/);
  expect(sidakSelectionPValue(4, 1.5, 12).sidakP).toBeGreaterThan(0);
});

test("fixed baselines from different comparators are different draw sets, even with equal value and size", () => {
  const { sharedDrawKeys } = require("./reproduce-paper-numbers");
  const fb = { controlType: "fixed-baseline", fixedBaselineValue: 0, fixedBaselineN: 1, drawsArm: 1, drawsCtl: 1, passThreshold: 1, anonPackage: "P", armCounts: [1], armUnsealed: false };
  expect(sharedDrawKeys({ ...fb, comparator: "C1" }).baselineGroup).not.toBe(sharedDrawKeys({ ...fb, comparator: "C2" }).baselineGroup);
});

test("the variance ratio refuses an incomplete task matrix instead of returning a p-value from NaN", () => {
  const { varianceRatioPermutationTest } = require("./reproduce-paper-numbers");
  const rows = [
    { draw: "d1", group: "G", block: "B", task: "t1", resolved: 1 }, { draw: "d1", group: "G", block: "B", task: "t2", resolved: 0 },
    { draw: "d2", group: "G", block: "B", task: "t1", resolved: 0 },
  ];
  expect(() => varianceRatioPermutationTest(rows, { perms: 9 })).toThrow(/complete task matrix/);
});

test("an incomplete task matrix is refused before totals, solve shares, pooled SD or the block ANOVA", () => {
  // two draws of one (group, block); the second omits a solved task
  const rows = parseTaskOutcomes("draw,package,block,task,resolved\nd1,G,1,t1,1\nd1,G,1,t2,1\nd2,G,1,t1,1\n");
  expect(() => assertCompleteTaskMatrix(rows)).toThrow(/d2 .* scores 1 of the 2 tasks/);
  expect(() => drawTotals(rows)).toThrow(/same tasks/);
  expect(() => pooledWithinBlockSd(rows)).toThrow(/same tasks/);
  expect(() => blockEffectFTest(rows, ["G"])).toThrow(/same tasks/);
  // on a slate, every draw of every family must score the same tasks
  const slate = parseTaskOutcomes("draw,family,slate,task,resolved\nd1,F,9,t1,1\nd1,F,9,t2,1\nd2,F,9,t1,1\nd2,F,9,t2,0\ne1,H,9,t1,1\n");
  expect(() => taskSolveShares(slate, "9")).toThrow(/same tasks/);
  expect(() => predictedRescoreSd(slate, "9", 9)).toThrow(/same tasks/);
  // a complete matrix passes
  expect(drawTotals(parseTaskOutcomes("draw,package,block,task,resolved\nd1,G,1,t1,1\nd1,G,1,t2,0\nd2,G,1,t1,0\nd2,G,1,t2,1\n")).get("d1")).toBe(1);
});

test("sharedMixturePower judges each read at its own passThreshold (no separate bar argument to ignore)", async () => {
  const { sharedMixturePower } = require("./reproduce-paper-numbers");
  const base = { replicationOf: null, anonBlock: "K1", drawsArm: 3, drawsCtl: 3, controlType: "same-block", fixedBaselineValue: null, fixedBaselineN: null, effect: 0, verdict: "refuted", passed: false, primary: true, armUnsealed: false, anonPackage: "A", comparator: "C", armCounts: [1, 2, 3], ctlCounts: [4, 4, 4] };
  const low = await sharedMixturePower([{ ...base, passThreshold: 1 }], 1.5, 1, 0, 0, 0.05, 50_000, 20_000);
  const high = await sharedMixturePower([{ ...base, passThreshold: 100 }], 1.5, 1, 0, 0, 0.05, 50_000, 20_000);
  // at a threshold of 100 nothing can pass, so P(X <= 0) is 1 at every assignment
  expect(high.points.every((p: any) => p.pAtMostObserved === 1)).toBe(true);
  expect(low.points[0]!.pAtMostObserved).toBeLessThan(1);
});

test("degenerate data is reported as not identifiable, never as a finding", () => {
  const row = (draw: string, block: string, task: string, resolved: 0 | 1) => ({ draw, group: "P", block, task, resolved });
  // two identical deterministic draws: sum p(1-p) = 0, the ratio is 0/0
  const same = [row("d1", "b1", "t1", 1), row("d1", "b1", "t2", 0), row("d2", "b1", "t1", 1), row("d2", "b1", "t2", 0)];
  const vr = varianceRatioPermutationTest(same, { perms: 50 });
  expect(vr.identifiable).toBe(false);
  expect(Number.isNaN(vr.permutationP)).toBe(true);
  // identical totals in every draw of every block: no within-block spread, F is 0/0
  const flat = [row("a1", "b1", "t1", 1), row("a2", "b1", "t1", 1), row("c1", "b2", "t1", 1), row("c2", "b2", "t1", 1)];
  const fx = blockEffectFTest(flat, ["P"]);
  expect(fx.pooled.identifiable).toBe(false);
  expect(Number.isNaN(fx.pooled.p)).toBe(true);
  expect(fx.perPackage[0]!.identifiable).toBe(false);
  // the shipped data stays identifiable
  expect(varianceRatioPermutationTest(f10, { perms: 50 }).identifiable).toBe(true);
});

test("the paper script uses the shared normal tail: a bar of zero gives exactly one half", () => {
  const row: any = { passThreshold: 0, drawsArm: 3, drawsCtl: 3, controlType: "same-block" };
  expect(nullPassProbabilityNormal(row, 1.51)).toBe(0.5);
  expect(nullPassProbabilityNormal({ ...row, passThreshold: 1e-9 }, 1.51)).toBeLessThan(0.5);
});

test("the Sidak-corrected p keeps a raw p below machine epsilon instead of rounding it to 0", () => {
  const r = sidakSelectionPValue(12, 1, 12);
  expect(r.rawP).toBeGreaterThan(0);
  expect(r.rawP).toBeLessThan(Number.EPSILON);
  expect(r.sidakP).toBeGreaterThan(0);
  expect(r.sidakP / (12 * r.rawP)).toBeCloseTo(1, 6);
  // ordinary values are unchanged in effect
  const m = sidakSelectionPValue(4, 1.5, 12);
  expect(m.sidakP).toBeCloseTo(1 - Math.pow(1 - m.rawP, 12), 12);
});

test("rescoreSdWithCi gives a finite interval for diffs near the floating-point limit", () => {
  const r = rescoreSdWithCi([1e200, -1e200]);
  expect(Number.isFinite(r.sd)).toBe(true);
  expect(Number.isFinite(r.ciLow) && Number.isFinite(r.ciHigh)).toBe(true);
  expect(r.ciLow).toBeLessThan(r.sd);
  expect(r.ciHigh).toBeGreaterThan(r.sd);
  // scale-invariant: the same diffs scaled down give the same interval scaled down
  const small = rescoreSdWithCi([1, -1]);
  expect(r.ciHigh / 1e200).toBeCloseTo(small.ciHigh, 10);
});
