#!/usr/bin/env bun
// aa-hindsight: the +1 gate's false-pass rate FP(4,3) measured on every unchanged package that has at least
// 7 flaky-10 draws, using all of its draws across blocks (so block drift is inside the estimate). Hindsight:
// these draws were run and read before this analysis existed. A pre-registered A/A study, when present as
// data/aa-study.csv (anon_draw,resolved_count), is reported on its own line by the same estimator.
// usage: bun competitions/gemma4-swe-agent/scripts/aa-hindsight.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { falsePass, bootstrapFp, mean, sampleSd } from "../../../src/noise-floor/aa-splits";

const ROOT = join(import.meta.dir, "..");
export const MIN_DRAWS = 7, SEED = 20261111;

export function drawCountsByPackage(csv: string): Map<string, number[]> {
  const per = new Map<string, Map<string, number>>();
  for (const line of csv.trim().split("\n").slice(1)) {
    const [draw, pkg, , , resolved] = line.split(",");
    const m = per.get(pkg!) ?? new Map<string, number>();
    m.set(draw!, (m.get(draw!) ?? 0) + Number(resolved));
    per.set(pkg!, m);
  }
  return new Map([...per].map(([p, m]) => [p, [...m.values()]]));
}

// the pre-registered study's draw counts: a header, then anon_draw,resolved_count rows with whole non-negative counts
export function aaStudyCounts(csv: string): number[] {
  const lines = csv.trim().split("\n");
  if (lines[0]?.trim() !== "anon_draw,resolved_count") throw new Error("aa-study.csv: header must be anon_draw,resolved_count");
  const seen = new Set<string>();
  return lines.slice(1).map((l, i) => {
    const [draw, n, ...rest] = l.split(",");
    const c = Number(n);
    if (!draw || rest.length || n?.trim() === "" || !Number.isSafeInteger(c) || c < 0) throw new Error(`aa-study.csv line ${i + 2}: expected anon_draw,whole count, got "${l}"`);
    if (seen.has(draw)) throw new Error(`aa-study.csv line ${i + 2}: duplicate draw ${draw}`);
    seen.add(draw);
    return c;
  });
}

export interface AaRow { label: string; draws: number; mean: number; sd: number; fp: number; ci: number[] }
export function aaRow(label: string, counts: number[], resamples = 2000, splits = 2000): AaRow {
  return { label, draws: counts.length, mean: mean(counts), sd: sampleSd(counts), fp: falsePass(counts, 4, 3).fp, ci: bootstrapFp(counts, 4, 3, resamples, splits, SEED) };
}

if (import.meta.main) {
  (await import("../../../src/cli-args.ts")).strictArgs(process.argv.slice(2), {}, "usage: bun competitions/gemma4-swe-agent/scripts/aa-hindsight.ts   (reads data/flaky10-task-outcomes.csv, and data/aa-study.csv when present)");
  const pk = drawCountsByPackage(readFileSync(join(ROOT, "data/flaky10-task-outcomes.csv"), "utf8"));
  const rows = [...pk].filter(([, c]) => c.length >= MIN_DRAWS).map(([p, c]) => aaRow(`hindsight ${p}`, c));
  const aa = join(ROOT, "data/aa-study.csv");
  if (existsSync(aa)) rows.push(aaRow("pre-registered A/A", aaStudyCounts(readFileSync(aa, "utf8"))));
  for (const r of rows) console.log(`${r.label}: ${r.draws} draws, mean ${r.mean.toFixed(2)}, sd ${r.sd.toFixed(2)}, FP(4,3) ${(100 * r.fp).toFixed(1)}% (draw bootstrap 95% ${(100 * r.ci[0]!).toFixed(1)}-${(100 * r.ci[1]!).toFixed(1)}%)`);
}
