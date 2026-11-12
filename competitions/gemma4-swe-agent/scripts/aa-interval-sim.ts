#!/usr/bin/env bun
// aa-interval-sim: how good are the intervals around an A/A false-pass estimate FP(4,3)? Simulates whole A/A
// studies (N draws of a 10-task slate under a per-task Bernoulli model), and for each one records the
// exhaustive FP(4,3), its jackknife SE, and the draw-bootstrap percentile interval; then reports bias and the
// coverage of the true FP (itself estimated from a large direct Monte Carlo of the gate).
// Defaults reproduce the ADR amendment's setting (N = 16, Budget-Fit-like task rates). Seeded; parallelise by
// running several seeds and merging the JSON lines.
// usage: bun competitions/gemma4-swe-agent/scripts/aa-interval-sim.ts [--workers 48] [--studies 20] [--n 16] [--seed 1] [--truth-trials 1000000]
//   --workers W runs W child processes (seeds seed..seed+W-1, --studies each) and pools every study; the
//   README numbers come from: bun competitions/gemma4-swe-agent/scripts/aa-interval-sim.ts --workers 48 --studies 20   (960 studies)
import { falsePass, bootstrapFp, gatePasses, jackknifeSe, mulberry32 } from "../../../src/noise-floor/aa-splits";

export const TASK_RATES = [0.36, 0.27, 0.55, 0.64, 0.36, 0.45, 0.64, 0.36, 0.09, 0.82];

export function trueFp(rates: number[], trials: number, seed: number): number {
  const rnd = mulberry32(seed);
  const draw = () => rates.reduce((s, p) => s + (rnd() < p ? 1 : 0), 0);
  let pass = 0;
  for (let i = 0; i < trials; i++) if (gatePasses([draw(), draw(), draw(), draw()], [draw(), draw(), draw()])) pass++;
  return pass / trials;
}

export interface SimStudy { fp: number; se: number; bootLo: number; bootHi: number }
export function simulateStudies(rates: number[], n: number, studies: number, seed: number, boot = { resamples: 300, splits: 500 }): SimStudy[] {
  const rnd = mulberry32(seed);
  const draw = () => rates.reduce((s, p) => s + (rnd() < p ? 1 : 0), 0);
  return Array.from({ length: studies }, (_, r) => {
    const d = Array.from({ length: n }, draw);
    const [bootLo, bootHi] = bootstrapFp(d, 4, 3, boot.resamples, boot.splits, seed * 100_003 + r);
    return { fp: falsePass(d, 4, 3).fp, se: jackknifeSe(d, 4, 3), bootLo: bootLo!, bootHi: bootHi! };
  });
}

/** A coverage rate with its Monte Carlo standard error (binomial over studies). */
const rate = (hits: number, n: number) => ({ rate: hits / n, mcSe: Math.sqrt((hits / n) * (1 - hits / n) / n) });

export function coverage(xs: SimStudy[], truth: number) {
  const n = xs.length, mean = xs.reduce((a, x) => a + x.fp, 0) / n;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x.fp - mean) ** 2, 0) / (n - 1));
  return {
    studies: n, truth, meanFp: mean, meanFpMcSe: sd / Math.sqrt(n), sdFp: sd, meanJackSe: xs.reduce((a, x) => a + x.se, 0) / n,
    jackknife196: rate(xs.filter((x) => Math.abs(x.fp - truth) <= 1.96 * x.se).length, n),
    drawBootstrap: rate(xs.filter((x) => x.bootLo <= truth && truth <= x.bootHi).length, n),
    drawBootstrapUpperBelowTruth: rate(xs.filter((x) => x.bootHi < truth).length, n),
  };
}

if (import.meta.main) {
  (await import("../../../src/cli-args.ts")).strictArgs(process.argv.slice(2), { valued: ["n", "studies", "workers", "seed", "truth-trials"], bool: ["raw"] }, "usage: bun competitions/gemma4-swe-agent/scripts/aa-interval-sim.ts [--n 16] [--studies 20] [--workers 0] [--seed 1] [--truth-trials N] [--raw]\n(simulates A/A studies from data/ per-task rates; studies x max(1, workers) studies in total)");
  const a = process.argv.slice(2);
  const f = (k: string, d: number, min: number) => {
    const i = a.indexOf(`--${k}`), x = i >= 0 ? Number(a[i + 1]) : d;
    if (!Number.isSafeInteger(x) || x < min) { console.error(`--${k} must be a whole number >= ${min}, got ${a[i + 1]}`); process.exit(2); }
    return x;
  };
  // n >= 8: FP(4,3) plus one draw for the jackknife; coverage needs at least two studies; the truth needs trials
  const seed = f("seed", 1, 0), n = f("n", 16, 8), studies = f("studies", 20, 2), workers = f("workers", 0, 0), truthTrials = f("truth-trials", 4_000_000, 1);
  if (a.includes("--raw")) { console.log(JSON.stringify(simulateStudies(TASK_RATES, n, studies, seed))); process.exit(0); }
  let xs: SimStudy[];
  if (workers > 0) {
    const kids = Array.from({ length: workers }, (_, w) => Bun.spawn(["bun", import.meta.path, "--raw", "--seed", String(seed + w), "--n", String(n), "--studies", String(studies)], { stdout: "pipe" }));
    xs = (await Promise.all(kids.map(async (k) => JSON.parse(await new Response(k.stdout).text()) as SimStudy[]))).flat();
  } else xs = simulateStudies(TASK_RATES, n, studies, seed);
  const truth = trueFp(TASK_RATES, truthTrials, 7919);
  console.log(JSON.stringify(coverage(xs, truth), null, 1));
}
