#!/usr/bin/env bun
// Same bytes, different blocks (the drift behind the paper's A/A check): identical bytes re-run as arm or control
// in different flaky-10 blocks. Each dot is one block's mean solves per 10-task draw; grey is each package's spread, red is the +1 promotion bar to scale.
// Data: data/flaky10-drift.csv only.
// usage: bun competitions/gemma4-swe-agent/scripts/fig-flaky10-drift.ts [out.svg]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFlaky10Drift, type DriftRow } from "./reproduce-paper-numbers.ts";

export function driftSvg(rows: DriftRow[], bar = 1): { svg: string; packages: number; ranges: Record<string, number> } {
  const byPkg = new Map<string, number[]>();
  for (const r of [...rows].sort((a, b) => a.blockIndex - b.blockIndex)) {
    if (!byPkg.has(r.anonPackage)) byPkg.set(r.anonPackage, []);
    byPkg.get(r.anonPackage)!.push(r.meanSolvesPerDraw);
  }
  const series = [...byPkg].sort(([a], [b]) => a.localeCompare(b));
  const all = rows.map((r) => r.meanSolvesPerDraw);
  const lo = Math.floor(Math.min(...all)), hi = Math.ceil(Math.max(...all));
  const W = 760, H = 360, L = 60, R = 30, T = 50, B = 50;
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const colW = (W - L - R) / series.length;
  const o: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Helvetica, Arial, sans-serif" font-size="12"><rect width="100%" height="100%" fill="white"/>`];
  for (let g = lo; g <= hi; g++) o.push(`<line x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}" stroke="#e5e7eb"/><text x="${L - 8}" y="${y(g) + 4}" text-anchor="end" fill="#374151">${g}</text>`);
  const ranges: Record<string, number> = {};
  series.forEach(([name, pts], si) => {
    const x0 = L + si * colW + colW * 0.15, x1 = L + (si + 1) * colW - colW * 0.15;
    pts.forEach((v, i) => o.push(`<circle cx="${x0 + (i * (x1 - x0)) / Math.max(1, pts.length - 1)}" cy="${y(v)}" r="5" fill="#1d4ed8"/>`));
    const mn = Math.min(...pts), mx = Math.max(...pts);
    ranges[name] = Math.round((mx - mn) * 100) / 100;
    o.push(`<line x1="${x1 + 14}" x2="${x1 + 14}" y1="${y(mx)}" y2="${y(mn)}" stroke="#6b7280" stroke-width="2"/>`);
    o.push(`<line x1="${x1 + 26}" x2="${x1 + 26}" y1="${y(mn + bar)}" y2="${y(mn)}" stroke="#dc2626" stroke-width="4"/>`);
    o.push(`<text x="${(x0 + x1) / 2}" y="${H - B + 22}" text-anchor="middle" fill="#111827">package ${name}: ${mn}–${mx}</text>`);
  });
  o.push(`<text x="${L}" y="24" font-size="15" font-weight="bold">Same bytes, different blocks: mean solves per 10-task draw</text>`);
  o.push(`<text x="${L}" y="40" fill="#6b7280">Grey bar: each package's spread across blocks. Red bar: the ${bar}-solve promotion bar, to scale.</text></svg>`);
  return { svg: o.join("\n"), packages: series.length, ranges };
}

if (import.meta.main) {
  const usage = "usage: bun competitions/gemma4-swe-agent/scripts/fig-flaky10-drift.ts [out.svg]   (default flaky10-drift.svg; reads data/flaky10-drift.csv)";
  (await import("../../../src/cli-args.ts")).strictArgs(process.argv.slice(2), { positionals: [0, 1] }, usage);
  if (process.argv[2]?.startsWith("-")) { console.log(usage); process.exit(0); }
  const r = driftSvg(parseFlaky10Drift(readFileSync(join(import.meta.dir, "..", "data/flaky10-drift.csv"), "utf8")));
  const out = process.argv[2] ?? "flaky10-drift.svg";
  writeFileSync(out, r.svg);
  console.log(`wrote ${out}: ${r.packages} packages, spread ${Object.entries(r.ranges).map(([k, v]) => `${k} ${v}`).join(", ")}`);
}
