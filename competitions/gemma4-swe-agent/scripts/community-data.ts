#!/usr/bin/env bun
// community-data: summarise the per-attempt release (data/attempts.csv, data/task-solve-rates.csv,
// data/interventions.csv) and recompute the process numbers it backs. Every number is derived from the
// CSVs; nothing is typed in by hand.
//
// usage: bun competitions/gemma4-swe-agent/scripts/community-data.ts [--json]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quantile7 } from "../../../src/noise-floor/aa-splits";

const ROOT = join(import.meta.dir, "..");

export interface Attempt {
  draw: string; group: string; slate: string; task: string; resolved: number;
  // process columns are null (stop "withheld") for some later packages: their outcome
  // is released, how they spend calls, tokens and time is not
  toolCalls: number | null; llmCalls: number | null; wallS: number | null; patchBytes: number | null; stop: string;
  completionTokens: number | null; peakPromptTokens: number | null; editCalls: number | null; editErrors: number | null;
}

const num = (s: string) => (s === "" ? null : Number(s));

export function parseAttempts(csv: string): Attempt[] {
  const [head, ...rows] = csv.trim().split("\n");
  const want = "anon_draw,group,slate,anon_task,resolved,tool_calls,llm_calls,wall_s,patch_bytes,stop,completion_tokens,peak_prompt_tokens,edit_calls,edit_errors";
  if (head !== want) throw new Error(`attempts.csv header changed: ${head}`);
  return rows.map((r) => {
    const c = r.split(",");
    return {
      draw: c[0]!, group: c[1]!, slate: c[2]!, task: c[3]!, resolved: Number(c[4]),
      toolCalls: num(c[5]!), llmCalls: num(c[6]!), wallS: num(c[7]!), patchBytes: num(c[8]!), stop: c[9]!,
      completionTokens: num(c[10]!), peakPromptTokens: num(c[11]!), editCalls: num(c[12]!), editErrors: num(c[13]!),
    };
  });
}

export function pearson(xs: number[], ys: number[]): number {
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i]! - mx, dy = ys[i]! - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxy / Math.sqrt(sxx * syy);
}

export interface Summary {
  attempts: number; draws: number; tasks: number; resolvedRate: number; withheldAttempts: number;
  /** shares over attempts whose process columns are released */
  stopShares: Record<string, number>;
  editCalls: number; editErrors: number; editFailureRate: number;
  tokensWallCorr: { pooled: number; perDrawMedian: number; perDrawQ1: number; perDrawQ3: number; perDrawMin: number; perDrawMax: number; drawsUsed: number };
}

export function summarise(a: Attempt[]): Summary {
  const open = a.filter((x) => x.stop !== "withheld");
  const stopShares: Record<string, number> = {};
  for (const x of open) stopShares[x.stop] = (stopShares[x.stop] ?? 0) + 1;
  for (const k of Object.keys(stopShares)) stopShares[k] = stopShares[k]! / open.length;
  const withCap = a.filter((x) => x.editCalls !== null);
  const editCalls = withCap.reduce((s, x) => s + x.editCalls!, 0), editErrors = withCap.reduce((s, x) => s + x.editErrors!, 0);
  // tokens-to-time: completion tokens vs wall seconds, Pearson r within each draw (one serving setup)
  // and pooled over all draws (mixes decode speeds, so it is much lower)
  const tok = a.filter((x) => x.completionTokens !== null);
  const byDraw = new Map<string, Attempt[]>();
  for (const x of tok) byDraw.set(x.draw, [...(byDraw.get(x.draw) ?? []), x]);
  const per = [...byDraw.values()].filter((xs) => xs.length >= 8).map((xs) => pearson(xs.map((x) => x.completionTokens!), xs.map((x) => x.wallS!))).filter(Number.isFinite).sort((p, q) => p - q);
  return {
    attempts: a.length, draws: new Set(a.map((x) => x.draw)).size, tasks: new Set(a.map((x) => x.task)).size,
    resolvedRate: a.reduce((s, x) => s + x.resolved, 0) / a.length, withheldAttempts: a.length - open.length,
    stopShares, editCalls, editErrors, editFailureRate: editErrors / editCalls,
    tokensWallCorr: {
      pooled: pearson(tok.map((x) => x.completionTokens!), tok.map((x) => x.wallS!)),
      perDrawMedian: quantile7(per, 0.5), perDrawQ1: quantile7(per, 0.25), perDrawQ3: quantile7(per, 0.75),
      perDrawMin: per[0]!, perDrawMax: per[per.length - 1]!, drawsUsed: per.length,
    },
  };
}

export interface ForkSummary { experiments: number; rollouts: number; forcedSteps: number; divergentSteps: number; zeroDivergenceRollouts: number; byKind: Record<string, number>; selftests: string[] }

export function summariseForks(csv: string): ForkSummary {
  const [head, ...rows] = csv.trim().split("\n");
  if (head !== "anon_id,kind,source_group,anon_task,fork_step,variant,rollouts,resolved,forced_steps,divergent_steps,live_steps,rollouts_zero_divergence") throw new Error(`fork-ledger.csv header changed: ${head}`);
  const r = rows.map((l) => l.split(","));
  const n = (i: number) => r.reduce((a, c) => a + Number(c[i]), 0);
  const byKind: Record<string, number> = {};
  for (const c of r) byKind[c[1]!] = (byKind[c[1]!] ?? 0) + Number(c[6]);
  const selftests = r.filter((c) => c[1] === "selftest").map((c) => `${c[3]} fork step ${c[4]}: ${c[9]} of ${c[8]} forced steps diverged`);
  return { experiments: r.length, rollouts: n(6), forcedSteps: n(8), divergentSteps: n(9), zeroDivergenceRollouts: n(11), byKind, selftests };
}

if (import.meta.main) {
  (await import("../../../src/cli-args.ts")).strictArgs(process.argv.slice(2), { bool: ["json"] }, "usage: bun competitions/gemma4-swe-agent/scripts/community-data.ts [--json]   (summarises data/attempts.csv and data/fork-ledger.csv)");
  const a = parseAttempts(readFileSync(join(ROOT, "data/attempts.csv"), "utf8"));
  const s = summarise(a);
  if (process.argv.includes("--json")) { console.log(JSON.stringify(s, null, 1)); process.exit(0); }
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  console.log(`attempts.csv: ${s.attempts} attempts, ${s.draws} draws, ${s.tasks} tasks, ${pct(s.resolvedRate)} resolved`);
  console.log(`process columns withheld on ${s.withheldAttempts} attempts; over the other ${s.attempts - s.withheldAttempts}:`);
  console.log(`stop reasons: ${Object.entries(s.stopShares).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${pct(v)}`).join(", ")}`);
  console.log(`edit_file: ${s.editErrors} failed of ${s.editCalls} calls = ${pct(s.editFailureRate)}`);
  const c = s.tokensWallCorr;
  const f = summariseForks(readFileSync(join(ROOT, "data/fork-ledger.csv"), "utf8"));
  console.log(`fork ledger: ${f.experiments} experiments, ${f.rollouts} rollouts (${Object.entries(f.byKind).map(([k, v]) => `${k} ${v}`).join(", ")}); ${f.zeroDivergenceRollouts} rollouts replayed every forced step identically; ${f.divergentSteps} of ${f.forcedSteps} forced steps diverged overall`);
  for (const t of f.selftests) console.log(`  self-test ${t}`);
  console.log(`completion tokens vs wall seconds: pooled r = ${c.pooled.toFixed(2)}; per draw median ${c.perDrawMedian.toFixed(2)} (IQR ${c.perDrawQ1.toFixed(3)} to ${c.perDrawQ3.toFixed(3)}, range ${c.perDrawMin.toFixed(2)} to ${c.perDrawMax.toFixed(2)}, ${c.drawsUsed} draws)`);
}
