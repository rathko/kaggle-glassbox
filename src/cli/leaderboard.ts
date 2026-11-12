#!/usr/bin/env bun
// leaderboard: the noise questions every small, noisy leaderboard raises, answered from the command
// line with no data from this campaign. Works for any competition that scores a fixed set of n
// pass/fail tasks (or any score you can express as "solved out of n").
//
//   bun src/cli/leaderboard.ts noise    --tasks 50 --rate 0.30
//   bun src/cli/leaderboard.ts compare  --tasks 50 --a 15 --b 19
//   bun src/cli/leaderboard.ts paired   --a-only 2 --b-only 8
//   bun src/cli/leaderboard.ts rescore  --diffs 2,-1,0,3
//   bun src/cli/leaderboard.ts draws    --sd 1.5 --bar 1 [--alpha 0.05] [--effect 2]
//   bun src/cli/leaderboard.ts aa       --scores 5,4,6,5,3,5,6,4 [--base 4 --idea 3 --bar 1]
//   bun src/cli/leaderboard.ts quant    --score 0.1724 --tasks 58 [--decimals 4] [--mode floor|round]
//
// Every subcommand prints plain text; add --json for a machine-readable object.
import { noiseFloor, twoProportionTest, headToHeadBinomial, perDrawSdFromPairedRescores, scaledSumOfSquares, mcNemarExact, MCNEMAR_MAX_DISCORDANT, heterogeneousCountSd } from "../noise-floor/noise-floor";
import { falsePass, jackknifeSe, mean, sampleSd, gatePasses, randomSplit, mulberry32 } from "../noise-floor/aa-splits";

const EXHAUSTIVE_LIMIT = 2_000_000, SAMPLED_SPLITS = 400_000;
const choose = (n: number, k: number) => { let c = 1; for (let i = 1; i <= k; i++) c = (c * (n - k + i)) / i; return Math.round(c); };
import { inferKRange, type QuantMode } from "../score-quant/score-quantisation";
import { chiSquareQuantile } from "../stats/chi-square";
import { drawsNeeded, falsePassRate as tieFalsePass, passRate } from "../stats/draws-needed";

const USAGE = `usage: bun src/cli/leaderboard.ts <command> [options] [--json]

commands:
  noise    --tasks N --rate P            how far two runs of the SAME agent drift apart by chance (all tasks
                                         equally hard: conservative)
           --rates p1,p2,...             the same from per-task solve rates (tasks of different difficulty)
  compare  --tasks N --a K1 --b K2       is run B's score really different from run A's? (independent task samples)
  paired   --a-only X --b-only Y         same question for two runs on the SAME tasks: X = tasks only A solved,
                                         Y = tasks only B solved (exact McNemar test)
  rescore  --diffs d1,d2,...             per-run SD from re-scoring identical submissions (B minus A, in tasks)
  draws    --sd S --bar B [--alpha A] [--effect E] [--scale counts|continuous]
                                        runs per arm before a no-effect change rarely clears "+B tasks";
                                        --effect E adds the pass rate (power) for a real +E change;
                                        --scale continuous for a non-count score (no continuity correction);
                                        bar and effect are improvements, so for a lower-is-better metric
                                        give them as positive amounts of reduction
  aa       --scores s1,s2,...            false-pass rate of a mean-difference gate on your own repeat runs
           [--base 4 --idea 3 --bar 1]   (A/A study: every split of the runs, baseline vs "idea");
           [--direction higher|lower]    lower for a lower-is-better metric (RMSE, loss)
  quant    --score X --tasks N           which solved-task counts a displayed (rounded) score can mean
           [--decimals 2] [--mode floor|round]
`;

export class UsageError extends Error {}

/** quant --json lists the matching solved counts in `k` only up to this many; beyond it `k` is null and kRange is the answer. */
export const K_LIST_MAX = 1000;

function parse(argv: string[]): { cmd: string; opt: Map<string, string>; json: boolean } {
  const [cmd = "", ...rest] = argv;
  const opt = new Map<string, string>();
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--json") { if (json) throw new UsageError("--json given twice"); json = true; continue; }
    if (!a.startsWith("--")) throw new UsageError(`unexpected argument: ${a}`);
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
    if (opt.has(a.slice(2))) throw new UsageError(`${a} given twice`);
    opt.set(a.slice(2), v); i++;
  }
  return { cmd, opt, json };
}

function num(opt: Map<string, string>, k: string, dflt?: number): number {
  const s = opt.get(k);
  if (s === undefined) { if (dflt !== undefined) return dflt; throw new UsageError(`missing --${k}`); }
  const x = Number(s);
  if (!Number.isFinite(x)) throw new UsageError(`--${k} must be a number, got "${s}"`);
  return x;
}
function int(opt: Map<string, string>, k: string, dflt?: number): number {
  const x = num(opt, k, dflt);
  if (!Number.isSafeInteger(x)) throw new UsageError(`--${k} must be a whole number below 2^53, got ${x}`);
  return x;
}
function list(opt: Map<string, string>, k: string): number[] {
  const s = opt.get(k);
  if (!s) throw new UsageError(`missing --${k}`);
  const toks = s.split(",").map((t) => t.trim());
  if (toks.some((t) => t === "")) throw new UsageError(`--${k} has an empty value (check for a doubled or trailing comma)`);
  const xs = toks.map(Number);
  if (xs.some((x) => !Number.isFinite(x))) throw new UsageError(`--${k} must be comma-separated numbers`);
  return xs;
}
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

/** Runs one subcommand; returns [text, json]. Throws UsageError on bad input. */
// the options each command reads: anything else is a typo that would silently fall back to a default
const OPTIONS: Record<string, string[]> = {
  noise: ["tasks", "rate", "rates"], compare: ["tasks", "a", "b"], paired: ["a-only", "b-only"], rescore: ["diffs"],
  draws: ["sd", "bar", "alpha", "effect", "scale"], aa: ["scores", "base", "idea", "bar", "direction"], quant: ["score", "tasks", "decimals", "mode"],
};

export function run(argv: string[]): { text: string; data: Record<string, unknown> } {
  const { cmd, opt } = parse(argv);
  const known = OPTIONS[cmd];
  if (known) for (const k of opt.keys()) if (!known.includes(k)) throw new UsageError(`${cmd} does not take --${k} (it takes ${known.map((x) => "--" + x).join(", ")})`);
  switch (cmd) {
    case "noise": {
      if (opt.has("rates")) {
        // per-task solve rates (from repeated runs on a fixed slate): the count SD is sqrt(sum p(1-p)), smaller than
        // the common-rate binomial whenever tasks differ in difficulty
        if (opt.has("tasks") || opt.has("rate")) throw new UsageError("give either --rates or --tasks with --rate, not both");
        const rates = list(opt, "rates");
        if (rates.some((p) => p < 0 || p > 1)) throw new UsageError("every --rates value must be in [0, 1]");
        const sd = heterogeneousCountSd(rates), mean = rates.reduce((a, b) => a + b, 0), homo = Math.sqrt(rates.length * (mean / rates.length) * (1 - mean / rates.length));
        return {
          data: { tasks: rates.length, expectedSolved: mean, sdOfRunTasks: sd, sdOfDifferenceTasks: sd * Math.SQRT2, homogeneousSdOfRunTasks: homo },
          text: [
            `one run of these ${rates.length} tasks: expected ${mean.toFixed(2)} solved, SD ${sd.toFixed(2)} tasks (a common-rate binomial would say ${homo.toFixed(2)})`,
            `two runs of the same agent differ by SD ${(sd * Math.SQRT2).toFixed(2)} tasks; under ${(2 * sd * Math.SQRT2).toFixed(2)} tasks is within 2 SD of chance`,
            `this counts only which tasks the agent happens to solve; measure grader noise with "rescore"`,
          ].join("\n"),
        };
      }
      const n = int(opt, "tasks"), p = num(opt, "rate");
      if (n <= 0 || !Number.isSafeInteger(n)) throw new UsageError("--tasks must be a positive whole number below 2^53");
      if (p < 0 || p > 1) throw new UsageError("--rate must be in [0, 1] (a fraction, not a percentage)");
      const f = noiseFloor(n, p);
      const tasks = (x: number) => (x * n).toFixed(2);
      return {
        data: { tasks: n, rate: p, ...f, sdOfRunTasks: f.sdOfRate * n, sdOfDifferenceTasks: f.sdOfSingleDrawDifference * n, minDetectableTasks: f.minDetectableDifference * n },
        text: [
          `one run of ${n} tasks at a true rate of ${pct(p)}: SD ${pct(f.sdOfRate)} (${tasks(f.sdOfRate)} tasks)`,
          `two runs of the same agent differ by SD ${pct(f.sdOfSingleDrawDifference)} (${tasks(f.sdOfSingleDrawDifference)} tasks)`,
          `a single-run difference under ${pct(f.minDetectableDifference)} (${tasks(f.minDetectableDifference)} tasks) is within 2 SD of chance`,
          `this counts only which tasks the agent happens to solve; measure grader noise with "rescore"`,
        ].join("\n"),
      };
    }
    case "compare": {
      const n = int(opt, "tasks"), k1 = int(opt, "a"), k2 = int(opt, "b");
      if (n <= 0 || !Number.isSafeInteger(n)) throw new UsageError("--tasks must be a positive whole number below 2^53");
      // the rerun odds below are exact and O(tasks): far past any leaderboard slate, refuse rather than hang
      if (n > 1_000_000) throw new UsageError("--tasks must be at most 1,000,000 for compare");
      for (const [nm, k] of [["a", k1], ["b", k2]] as const) if (k < 0 || k > n) throw new UsageError(`--${nm} must be a solved count in [0, ${n}]`);
      const t = twoProportionTest(k2, n, k1, n);
      // what a rerun would show if B's true rate were exactly what it scored (an optimistic read)
      const h = headToHeadBinomial(n, k1 / n, k2 - k1);
      return {
        data: { tasks: n, a: k1, b: k2, z: t.z, pValue: t.pValue, rerunIfObservedIsTrue: h },
        text: [
          `A ${k1}/${n} (${pct(k1 / n)}) vs B ${k2}/${n} (${pct(k2 / n)}): difference ${k2 - k1 >= 0 ? "+" : ""}${k2 - k1} tasks`,
          `two-proportion z = ${t.z.toFixed(2)}, two-sided p = ${t.pValue.toFixed(3)}${t.pValue < 0.05 ? "" : " (not distinguishable from chance)"}`,
          `if those were the true rates, a fresh pair of runs would have B ahead ${pct(h.win)}, tied ${pct(h.tie)}, behind ${pct(h.loss)}`,
          `assumes two independent task samples; for two runs on the same tasks use "paired" instead`,
        ].join("\n"),
      };
    }
    case "paired": {
      const a = int(opt, "a-only"), b = int(opt, "b-only");
      if (a < 0 || b < 0) throw new UsageError("--a-only and --b-only are counts of tasks, >= 0");
      if (a + b > MCNEMAR_MAX_DISCORDANT) throw new UsageError(`--a-only plus --b-only must be at most ${MCNEMAR_MAX_DISCORDANT}`);
      const m = mcNemarExact(a, b);
      return {
        data: { aOnly: a, bOnly: b, ...m },
        text: [
          `${m.discordant} task(s) where the runs disagree: A alone solved ${a}, B alone solved ${b}`,
          `exact McNemar two-sided p = ${m.pValue.toFixed(3)}${m.pValue < 0.05 ? "" : " (not distinguishable from chance)"}`,
          `tasks both runs solved, or both missed, say nothing about which run is better`,
        ].join("\n"),
      };
    }
    case "rescore": {
      const d = list(opt, "diffs");
      if (d.length < 1) throw new UsageError("--diffs needs at least one value");
      const sd = perDrawSdFromPairedRescores(d);
      // the sum of squares is kept as scale^2 * sumSq so a huge or tiny diff neither overflows nor vanishes
      const { scale, sumSq } = scaledSumOfSquares(d);
      // per-run variance = sumSq / (2 df); chi-square interval on df = number of pairs (the mean is known: 0)
      const ci = sumSq === 0 ? null : [scale * Math.sqrt(sumSq / (2 * chiSquareQuantile(0.975, d.length))), scale * Math.sqrt(sumSq / (2 * chiSquareQuantile(0.025, d.length)))];
      // JSON would turn an infinity into null and print a number-shaped hole; refuse instead
      if (!Number.isFinite(sd) || (ci && !ci.every(Number.isFinite))) throw new UsageError("--diffs are too large for a finite SD interval");
      return {
        data: { pairs: d.length, perRunSd: sd, ci95: ci },
        text: [
          `${d.length} re-score pair(s): per-run SD ${sd.toFixed(2)} (in the units of --diffs)` + (ci ? ` (95% CI ${ci[0]!.toFixed(2)}-${ci[1]!.toFixed(2)})` : ""),
          d.length < 4 ? `few pairs: the interval is wide; each extra identical resubmission narrows it` : `use this SD with "draws" and "aa"`,
        ].join("\n"),
      };
    }
    case "draws": {
      const sd = num(opt, "sd"), bar = num(opt, "bar"), alpha = num(opt, "alpha", 0.05);
      const effect = opt.has("effect") ? num(opt, "effect") : null;
      const scale = opt.get("scale") ?? "counts";
      if (scale !== "counts" && scale !== "continuous") throw new UsageError("--scale must be counts or continuous");
      const cont = scale === "continuous";
      if (sd <= 0) throw new UsageError("--sd must be positive");
      if (bar <= 0) throw new UsageError("--bar must be positive");
      if (alpha <= 0 || alpha >= 1) throw new UsageError("--alpha must be in (0, 1)");
      let n: number;
      try { n = drawsNeeded(sd, bar, alpha, 1000, cont); }
      catch { throw new UsageError(`more than 1000 runs per arm would be needed at SD ${sd} and bar ${bar}: raise the bar or reduce the noise first`); }
      const rows = [1, 2, 3, 4, 6, 8, n].filter((x, i, a) => a.indexOf(x) === i).sort((x, y) => x - y)
        .map((k) => `  ${String(k).padStart(3)} runs per arm: false-pass ${pct(tieFalsePass(k, sd, bar, cont))}` + (effect !== null ? `, pass at +${effect}: ${pct(passRate(k, sd, bar, effect, cont))}` : ""));
      return {
        data: { sd, bar, alpha, scale, runsPerArm: n, effect, powerAtRunsPerArm: effect !== null ? passRate(n, sd, bar, effect, cont) : null },
        text: [`a change with NO effect clears "+${bar} ${cont ? "score units" : "tasks"} per run" (${cont ? "" : "ties pass, "}same-block control, per-run SD ${sd}):`, ...rows,
          `=> ${n} runs per arm keep the false-pass rate under ${pct(alpha)} (normal approximation${cont ? ", no continuity correction" : ", continuity-corrected"})`,
          effect === null ? `this sizes false passes only; a real change exactly at +${bar} still passes about half the time (add --effect to see power)` : `a real +${effect} change passes ${pct(passRate(n, sd, bar, effect, cont))} of the time at ${n} runs per arm`,
          `use a conservative SD: the upper end of the "rescore" interval, or your A/A spread`].join("\n"),
      };
    }
    case "aa": {
      const raw = list(opt, "scores"), b = int(opt, "base", 4), k = int(opt, "idea", 3), bar = num(opt, "bar", 1);
      const direction = opt.get("direction") ?? "higher";
      if (direction !== "higher" && direction !== "lower") throw new UsageError("--direction must be higher or lower");
      // lower-is-better (RMSE, loss): the gate promotes a LOWER mean, so run it on negated scores
      const s = direction === "lower" ? raw.map((x) => -x) : raw;
      if (b < 2 || k < 1) throw new UsageError("--base must be >= 2 and --idea >= 1");
      if (!(bar > 0)) throw new UsageError("--bar must be positive");
      if (s.length < b + k) throw new UsageError(`need at least ${b + k} repeat runs for --base ${b} --idea ${k}; got ${s.length}`);
      const total = choose(s.length, b) * choose(s.length - b, k);
      let fp: { pairs: number; passes: number; fp: number }, sampled = false;
      // a gate decided by rounding (a huge spread of scores against a tiny bar) is a usage error, not a verdict
      const settled = <T,>(f: () => T): T => { try { return f(); } catch (e) { if (e instanceof RangeError) throw new UsageError(`aa: ${e.message}`); throw e; } };
      if (total <= EXHAUSTIVE_LIMIT) fp = settled(() => falsePass(s, b, k, bar));
      else {
        // too many splits to enumerate: a seeded random sample of splits (Monte Carlo SE about 0.07 points)
        const rnd = mulberry32(20261112);
        let passes = 0;
        for (let t = 0; t < SAMPLED_SPLITS; t++) { const [A, B] = randomSplit(s.length, b, k, rnd); if (settled(() => gatePasses(A.map((i) => s[i]!), B.map((i) => s[i]!), bar))) passes++; }
        fp = { pairs: SAMPLED_SPLITS, passes, fp: passes / SAMPLED_SPLITS };
        sampled = true;
      }
      const se = !sampled && s.length >= b + k + 1 && total * s.length <= 4 * EXHAUSTIVE_LIMIT ? settled(() => jackknifeSe(s, b, k, bar)) : null;
      // every derived number must be finite before it is printed: JSON would turn an infinity into null
      const derived = { mean: mean(raw), sd: sampleSd(raw), fp: fp.fp, ...(se === null ? {} : { jackknifeSe: se }) };
      const bad = Object.entries(derived).filter(([, v]) => !Number.isFinite(v)).map(([k]) => k);
      if (bad.length) throw new UsageError(`aa: ${bad.join(", ")} is not a finite number for these scores; rescale them`);
      return {
        data: { runs: s.length, mean: mean(raw), sd: sampleSd(raw), base: b, idea: k, bar, direction, ...fp, sampled, jackknifeSe: se },
        text: [
          `${s.length} runs of one unchanged agent: mean ${mean(raw).toFixed(2)}, SD ${sampleSd(raw).toFixed(2)}`,
          direction === "lower"
            ? `gate (lower is better): idea passes if mean(idea runs) <= mean(baseline runs) - max(${bar}, SD(baseline)/sqrt(${k}))`
            : `gate: idea passes if mean(idea runs) >= mean(baseline runs) + max(${bar}, SD(baseline)/sqrt(${k}))`,
          (sampled ? `over ${fp.pairs} random splits of ${total} possible` : `over all ${fp.pairs} splits`) + ` (${b} baseline vs ${k} idea runs), the agent "beat itself" in ${fp.passes}: false-pass ${pct(fp.fp)}` + (se === null ? "" : ` (jackknife SE ${pct(se)})`),
          `that is how often this gate promotes a change with no effect at all`,
        ].join("\n"),
      };
    }
    case "quant": {
      const score = num(opt, "score"), n = int(opt, "tasks"), dec = int(opt, "decimals", 2);
      const mode = (opt.get("mode") ?? "floor") as QuantMode;
      if (mode !== "floor" && mode !== "round") throw new UsageError("--mode must be floor or round");
      if (n <= 0 || !Number.isSafeInteger(n)) throw new UsageError("--tasks must be a positive whole number below 2^53");
      if (dec < 0 || dec > 8) throw new UsageError("--decimals must be in [0, 8]");
      if (score < 0 || score > 1) throw new UsageError("--score must be a fraction in [0, 1] (0.17, not 17)");
      if (Math.abs(score * 10 ** dec - Math.round(score * 10 ** dec)) > 1e-6) throw new UsageError(`--score ${score} has more than ${dec} decimal places; set --decimals`);
      const r1 = inferKRange(score, n, mode, dec), r2 = inferKRange(score, n, mode === "floor" ? "round" : "floor", dec);
      const show = (r: { min: number; max: number } | null) => !r ? "none" : r.max - r.min < 5 ? Array.from({ length: r.max - r.min + 1 }, (_, i) => r.min + i).join(" or ") : `${r.min} to ${r.max} (${r.max - r.min + 1} counts)`;
      const ks = r1 ? [r1.min, r1.max] : [], other = r2 ? [r2.min, r2.max] : [];
      return {
        // k lists every matching count, or is null when there are more than K_LIST_MAX of them (read kRange then):
        // a list cut at the cap would look complete
        data: { score, tasks: n, decimals: dec, mode, k: !r1 ? [] : r1.max - r1.min + 1 > K_LIST_MAX ? null : Array.from({ length: r1.max - r1.min + 1 }, (_, i) => r1.min + i), kRange: r1, kOtherModeRange: r2 },
        text: [
          `score ${score} on ${n} tasks, ${mode}ed to ${dec} decimals: solved count ${r1 ? show(r1) : "none (check --tasks, --decimals or --mode)"}`,
          `under ${mode === "floor" ? "round" : "floor"}ing instead: ${show(r2)}`,
        ].join("\n"),
      };
    }
    case "":
    case "help":
    case "--help":
    case "-h":
      return { text: USAGE, data: { usage: USAGE } };
    default:
      throw new UsageError(`unknown command: ${cmd}`);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  try {
    const { text, data } = run(argv);
    console.log(argv.includes("--json") ? JSON.stringify(data, null, 1) : text);
  } catch (e) {
    if (e instanceof UsageError) { console.error(`error: ${e.message}\n\n${USAGE}`); process.exit(2); }
    throw e;
  }
}
