#!/usr/bin/env bun
// Figure 7 of the paper: every decided flaky-10 read against its own null. Grey: the 90% range of the effect
// if the idea did nothing (per-draw SD 1.51); filled: promoted. Data: data/flaky10-decisions.json only.
// usage: bun competitions/gemma4-swe-agent/scripts/fig-decisions.ts [out.svg]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DecisionRow { anonPackage: string; controlType: string; drawsArm: number; drawsCtl: number; effect: number; passed: boolean; armUnsealed: boolean; primary: boolean }

export function decisionsSvg(all: DecisionRow[], sd = 1.51, bar = 1): { svg: string; reads: number; promoted: number } {
  const Z90 = 1.645;
  const rows = all.filter((r) => r.primary).sort((a, b) => (a.armUnsealed === b.armUnsealed ? b.effect - a.effect : a.armUnsealed ? 1 : -1));
  const W = 760, rowH = 18, T = 64, B = 44, L = 150, R = 30, H = T + rows.length * rowH + B, lo = -3, hi = 3;
  const x = (v: number) => L + ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (W - L - R);
  const o: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Helvetica, Arial, sans-serif" font-size="12"><rect width="100%" height="100%" fill="white"/>`];
  for (let g = lo; g <= hi; g++) o.push(`<line x1="${x(g)}" x2="${x(g)}" y1="${T - 6}" y2="${H - B}" stroke="#e5e7eb"/><text x="${x(g)}" y="${H - B + 16}" text-anchor="middle" fill="#374151">${g > 0 ? "+" : ""}${g}</text>`);
  o.push(`<line x1="${x(bar)}" x2="${x(bar)}" y1="${T - 6}" y2="${H - B}" stroke="#dc2626" stroke-width="2"/>`);
  rows.forEach((r, i) => {
    const cy = T + i * rowH + rowH / 2, se = sd * Math.sqrt(1 / r.drawsArm + 1 / r.drawsCtl);
    const label = `${r.controlType === "same-block" ? "same block" : r.controlType === "fixed-baseline" ? "4-draw baseline" : "historical mean"}, ${r.drawsArm}v${r.drawsCtl}`;
    o.push(`<text x="${L - 8}" y="${cy + 4}" text-anchor="end" fill="#6b7280" font-size="11">${label}</text>`);
    o.push(`<rect x="${x(-Z90 * se)}" y="${cy - 4}" width="${x(Z90 * se) - x(-Z90 * se)}" height="8" fill="#d1d5db"/>`);
    if (r.armUnsealed) o.push(`<text x="${x(lo) + 4}" y="${cy + 4}" fill="#9ca3af" font-size="11">× crashed at turn 0</text>`);
    else o.push(`<circle cx="${x(r.effect)}" cy="${cy}" r="5" fill="${r.passed ? "#1d4ed8" : "white"}" stroke="#1d4ed8" stroke-width="2"/>`);
  });
  const promoted = rows.filter((r) => r.passed).length;
  o.push(`<text x="${x(bar) + 4}" y="${T - 10}" fill="#dc2626">+1 bar</text>`);
  o.push(`<text x="${L}" y="${H - 10}" fill="#374151">effect: arm minus control, solves per 10-task draw</text>`);
  o.push(`<text x="10" y="22" font-size="15" font-weight="bold">The ${rows.length} decided flaky-10 reads, each against its own null</text>`);
  o.push(`<text x="10" y="40" fill="#6b7280">Grey: 90% range of the effect if the idea did nothing (per-run SD ${sd}, no between-block drift). Filled: promoted (${promoted}).</text></svg>`);
  return { svg: o.join("\n"), reads: rows.length, promoted };
}

if (import.meta.main) {
  (await import("../../../src/cli-args.ts")).strictArgs(process.argv.slice(2), { positionals: [0, 1] }, "usage: bun competitions/gemma4-swe-agent/scripts/fig-decisions.ts [out.svg]   (default decisions.svg; reads data/flaky10-decisions.json)");
  const rows: DecisionRow[] = JSON.parse(readFileSync(join(import.meta.dir, "..", "data/flaky10-decisions.json"), "utf8"));
  const r = decisionsSvg(rows);
  if (process.argv[2]?.startsWith("-")) { console.log("usage: bun competitions/gemma4-swe-agent/scripts/fig-decisions.ts [out.svg]   (default decisions.svg; reads data/flaky10-decisions.json)"); process.exit(0); }
  const out = process.argv[2] ?? "decisions.svg";
  writeFileSync(out, r.svg);
  console.log(`wrote ${out}: ${r.reads} reads, ${r.promoted} promoted`);
}
