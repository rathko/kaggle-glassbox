import { test, expect } from "bun:test";
import { run, UsageError } from "./leaderboard";

const j = (args: string) => run(args.split(" ")).data as any;

// every expected value below was computed by hand from the textbook formula, not read off the tool
test("noise: binomial SD of one run and of the difference of two runs", () => {
  const d = j("noise --tasks 50 --rate 0.3");
  expect(d.sdOfRate).toBeCloseTo(Math.sqrt(0.21 / 50), 12); // 0.0648
  expect(d.sdOfSingleDrawDifference).toBeCloseTo(Math.sqrt(2 * 0.21 / 50), 12);
  expect(d.sdOfRunTasks).toBeCloseTo(3.24, 2);
});

test("compare: pooled two-proportion z and a head-to-head that sums to 1", () => {
  const d = j("compare --tasks 50 --a 15 --b 19");
  const se = Math.sqrt(0.34 * 0.66 * (2 / 50));
  expect(d.z).toBeCloseTo(0.08 / se, 10); // 0.845
  expect(d.pValue).toBeCloseTo(0.398, 3);
  const h = d.rerunIfObservedIsTrue;
  expect(h.win + h.tie + h.loss).toBeCloseTo(1, 10);
  expect(h.win).toBeGreaterThan(h.loss);
});

test("paired: exact McNemar on the discordant tasks", () => {
  expect(j("paired --a-only 2 --b-only 8").pValue).toBeCloseTo(2 * (1 + 10 + 45) / 1024, 12);
  expect(j("paired --a-only 0 --b-only 0").pValue).toBe(1);
});

test("rescore: RMS/sqrt(2) and a chi-square interval with df = pairs", () => {
  const d = j("rescore --diffs 2,-1,0,3");
  expect(d.perRunSd).toBeCloseTo(Math.sqrt(14 / 4) / Math.SQRT2, 12); // 1.32
  // chi-square(4) quantiles: 0.4844 and 11.1433 (standard tables)
  expect(d.ci95[0]).toBeCloseTo(Math.sqrt(14 / (2 * 11.1433)), 3);
  expect(d.ci95[1]).toBeCloseTo(Math.sqrt(14 / (2 * 0.4844)), 2);
  expect(j("rescore --diffs 0,0").ci95).toBeNull();
});

test("draws: the first n whose continuity-corrected false-pass is under alpha", () => {
  const d = j("draws --sd 1.5 --bar 1 --alpha 0.05");
  // 1 - Phi((n*1 - 0.5) / (1.5 * sqrt(2n))) < 0.05  <=>  (n - 0.5) / (1.5 sqrt(2n)) > 1.6449
  const ok = (n: number) => (n - 0.5) / (1.5 * Math.sqrt(2 * n)) > 1.6449;
  expect(ok(d.runsPerArm)).toBe(true);
  expect(ok(d.runsPerArm - 1)).toBe(false);
});

test("aa: exhaustive split count and a hand-checkable tiny case", () => {
  const d = j("aa --scores 5,4,6,5,3,5,6,4,5,7");
  expect(d.pairs).toBe(210 * 20); // C(10,4) * C(6,3)
  // six zeros and one 9: the baseline of four zeros has SD 0, so the margin is the bar (1). The idea (the other three)
  // passes exactly when it holds the 9 (mean 3). Pairs = C(7,4) * C(3,3) = 35; passes = bases without the 9 = C(6,4) = 15.
  const t = j("aa --scores 0,0,0,0,0,0,9");
  expect(t.pairs).toBe(35);
  expect(t.passes).toBe(15);
  // a larger bar blocks it
  expect(j("aa --scores 0,0,0,0,0,0,9 --bar 4").passes).toBe(0);
});

test("quant --json: k is complete or null, never a list cut at the cap", () => {
  const big = j("quant --score 0 --tasks 1000000 --decimals 2");
  expect(big.k).toBeNull();
  expect(big.kRange).toEqual({ min: 0, max: 9999 });
  const at = j("quant --score 0 --tasks 100000 --decimals 2"); // 0..999: exactly the cap
  expect(at.k.length).toBe(1000);
  expect(at.k[999]).toBe(999);
});

test("quant: decimals and mode; an impossible score returns no count", () => {
  expect(j("quant --score 0.17 --tasks 58").k).toEqual([10]);
  expect(j("quant --score 0.1724 --tasks 58 --decimals 4").k).toEqual([10]); // 10/58 = 0.172413...
  expect(j("quant --score 0.1725 --tasks 58 --decimals 4").k).toEqual([]);
  expect(j("quant --score 0.1724 --tasks 58 --decimals 4 --mode round").k).toEqual([10]);
  expect(j("quant --score 0.67 --tasks 3 --mode round").k).toEqual([2]); // 0.6667 rounds up
  expect(j("quant --score 0.66 --tasks 3").k).toEqual([2]); // and floors down
});

test("bad input is a UsageError with a reason, never a stack trace", () => {
  for (const a of ["bogus", "noise --tasks 50 --rate 30", "noise --tasks 0 --rate 0.3", "compare --tasks 5 --a 6 --b 1",
    "aa --scores 1,2", "rescore --diffs a,b", "draws --sd 0 --bar 1", "quant --score 0.1 --tasks 10 --mode up", "noise --tasks"]) {
    expect(() => run(a.split(" "))).toThrow(UsageError);
  }
  expect(run([]).text).toContain("usage:");
});

test("the CLI exits 2 with usage on stderr for bad input, and 0 with --json output for good input", () => {
  const bad = Bun.spawnSync(["bun", import.meta.dir + "/leaderboard.ts", "noise", "--tasks", "x"]);
  expect(bad.exitCode).toBe(2);
  expect(bad.stderr.toString()).toContain("--tasks must be a number");
  const good = Bun.spawnSync(["bun", import.meta.dir + "/leaderboard.ts", "noise", "--tasks", "50", "--rate", "0.3", "--json"]);
  expect(good.exitCode).toBe(0);
  expect(JSON.parse(good.stdout.toString()).tasks).toBe(50);
});

test("a misspelt or foreign option is a usage error, not a silent default", () => {
  expect(() => run(["draws", "--sd", "1", "--bar", "1", "--alhpa", "0.2"])).toThrow(/does not take --alhpa/);
  expect(() => run(["noise", "--tasks", "50", "--rate", "0.3", "--bar", "1"])).toThrow(UsageError);
  expect(() => run(["draws", "--sd", "1", "--sd", "2", "--bar", "1"])).toThrow(/given twice/);
});

test("an empty field in a number list is an error, not a zero", () => {
  expect(() => run(["rescore", "--diffs", "2,,2"])).toThrow(/empty value/);
});

test("noise --rates uses per-task rates: two certain tasks have no noise, unlike the common-rate binomial", () => {
  const r = run(["noise", "--rates", "0,1"]);
  expect(r.data.sdOfRunTasks).toBe(0);
  expect(r.data.homogeneousSdOfRunTasks).toBeCloseTo(Math.SQRT1_2, 10);
  expect(() => run(["noise", "--rates", "0.5", "--tasks", "2"])).toThrow(/either/);
});

test("draws --scale continuous drops the whole-task rounding and the continuity correction", () => {
  const d = run(["draws", "--sd", "1", "--bar", "0.5", "--scale", "continuous", "--json"]).data as any;
  const c = run(["draws", "--sd", "1", "--bar", "0.5"]).data as any;
  expect(d.scale).toBe("continuous");
  expect(d.runsPerArm).not.toBe(c.runsPerArm);
  expect(() => run(["draws", "--sd", "1", "--bar", "1", "--scale", "x"])).toThrow(/counts or continuous/);
});

test("aa --direction lower runs the gate on a lower-is-better metric, and a non-positive bar is refused", () => {
  const scores = "0.30,0.31,0.29,0.30,0.32,0.28,0.30";
  const hi = run(["aa", "--scores", scores, "--bar", "0.01", "--json"]).data as any;
  const lo = run(["aa", "--scores", scores, "--bar", "0.01", "--direction", "lower", "--json"]).data as any;
  expect(lo.direction).toBe("lower");
  expect(lo.pairs).toBe(hi.pairs);
  // mirror the scores around their mean: "lower" on the mirror equals "higher" on the original
  const mirrored = scores.split(",").map((x) => (0.6 - Number(x)).toFixed(2)).join(",");
  const loMirror = run(["aa", "--scores", mirrored, "--bar", "0.01", "--direction", "lower", "--json"]).data as any;
  expect(loMirror.passes).toBe(hi.passes);
  expect(() => run(["aa", "--scores", scores, "--bar", "-1"])).toThrow(/positive/);
  expect(() => run(["aa", "--scores", scores, "--direction", "down"])).toThrow(/higher or lower/);
});

test("--json given twice is a usage error, like any repeated option", () => {
  expect(() => run(["noise", "--tasks", "10", "--rate", "0.5", "--json", "--json"])).toThrow(UsageError);
});

test("rescore: huge diffs give a finite SD and interval, or a usage error, never a JSON null", () => {
  const r = j("rescore --diffs 1e200 --json");
  expect(r.perRunSd).toBeCloseTo(7.071067811865474e199, -186);
  expect(r.ci95.every(Number.isFinite)).toBe(true);
  expect(JSON.stringify(run(["rescore", "--diffs", "1e200", "--json"]).data)).not.toContain("null");
  expect(() => run(["rescore", "--diffs", "1e300,1e308"])).toThrow(UsageError);
  expect(j("rescore --diffs 1e-200,2e-200 --json").perRunSd).toBeGreaterThan(0);
});

test("aa with finite scores near the float limit reports finite mean and SD (never null) and the rescaled false-pass rate", () => {
  const d = j("aa --scores 1e308,1e308,1e308,1e308,1.1e308,1.1e308,1.1e308 --base 4 --idea 3 --bar 1e306");
  expect(Number.isFinite(d.mean)).toBe(true);
  expect(Number.isFinite(d.sd)).toBe(true);
  expect(d.passes).toBe(13);
  expect(d.fp).toBeCloseTo(13 / 35, 15);
});

test("lb aa: a gate decided by rounding is a usage error, not a verdict", () => {
  const { run, UsageError } = require("./leaderboard");
  expect(() => run(["aa", "--scores", "0,0,0,0,1e15,1e15,1e15", "--base", "4", "--idea", "3", "--bar", "0.001"])).toThrow(UsageError);
});
