#!/usr/bin/env bun
// The false-pass curve behind the paper's sizing numbers (13-21% at 3-6 draws, ~14 draws for < 5%): the chance
// that a +1-solve bar promotes an idea with zero true effect, against draws per arm, for a control drawn in the same block and for a baseline with no sampling error. Inputs: the flaky-10
// per-draw SD (1.51 solves, FLAKY10_PER_DRAW_SD, pooled from data/flaky10-task-outcomes.csv by
// reproduce-paper-numbers.ts) and the +1 bar. Normal approximation, no continuity correction (as in the paper).
// usage: bun competitions/gemma4-swe-agent/scripts/fig-false-pass.ts [out.svg]
import { writeFileSync } from "node:fs";
import { normalSurvival } from "../../../src/noise-floor/noise-floor.ts";
import { FLAKY10_PER_DRAW_SD } from "./reproduce-paper-numbers.ts";

/** P(an idea that does nothing clears the bar) at n draws per arm; a same-block control doubles the variance. */
export const passNull = (n: number, sameBlock: boolean, sd = FLAKY10_PER_DRAW_SD, bar = 1) =>
  normalSurvival(bar / (sd * Math.sqrt((sameBlock ? 2 : 1) / n)));

export function falsePassSvg(sd = FLAKY10_PER_DRAW_SD, bar = 1, used: [number, number] = [3, 6]): { svg: string; atUsed: [number, number] } {
  const W = 760, H = 380, L = 64, R = 30, T = 56, B = 52;
  const x = (n: number) => L + ((n - 1) / 19) * (W - L - R);
  const y = (p: number) => T + (1 - Math.min(p, 0.4) / 0.4) * (H - T - B);
  const o: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Helvetica, Arial, sans-serif" font-size="12"><rect width="100%" height="100%" fill="white"/>`];
  for (const g of [0, 0.1, 0.2, 0.3, 0.4]) o.push(`<line x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}" stroke="#e5e7eb"/><text x="${L - 8}" y="${y(g) + 4}" text-anchor="end" fill="#374151">${Math.round(g * 100)}%</text>`);
  for (const n of [1, 5, 10, 15, 20]) o.push(`<text x="${x(n)}" y="${H - B + 18}" text-anchor="middle" fill="#374151">${n}</text>`);
  o.push(`<text x="${(L + W - R) / 2}" y="${H - 10}" text-anchor="middle" fill="#111827">draws per arm</text>`);
  o.push(`<rect x="${x(used[0])}" y="${T}" width="${x(used[1]) - x(used[0])}" height="${H - T - B}" fill="#fde68a" opacity="0.5"/><text x="${x((used[0] + used[1]) / 2)}" y="${T + 14}" text-anchor="middle" fill="#92400e">draws I used</text>`);
  const line = (same: boolean, col: string) => {
    const pts = Array.from({ length: 191 }, (_, i) => 1 + i / 10).map((n) => `${x(n).toFixed(1)},${y(passNull(n, same, sd, bar)).toFixed(1)}`);
    o.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${col}" stroke-width="2.5"/>`);
  };
  line(true, "#dc2626"); line(false, "#1d4ed8");
  o.push(`<text x="${x(7)}" y="${y(passNull(7, true, sd, bar)) - 8}" fill="#dc2626">control in the same block</text>`);
  o.push(`<text x="${x(9)}" y="${y(passNull(9, false, sd, bar)) + 18}" fill="#1d4ed8">baseline with no sampling error</text>`);
  o.push(`<text x="${L}" y="24" font-size="15" font-weight="bold">Chance a +${bar}-solve bar promotes an idea that does nothing</text>`);
  o.push(`<text x="${L}" y="42" fill="#6b7280">10-task stage, per-draw SD ${sd} solves, normal approximation</text></svg>`);
  return { svg: o.join("\n"), atUsed: [passNull(used[1], true, sd, bar), passNull(used[0], true, sd, bar)] };
}

if (import.meta.main) {
  const usage = "usage: bun competitions/gemma4-swe-agent/scripts/fig-false-pass.ts [out.svg]   (default false-pass.svg; SD 1.51 from the paper's flaky-10 draws)";
  (await import("../../../src/cli-args.ts")).strictArgs(process.argv.slice(2), { positionals: [0, 1] }, usage);
  if (process.argv[2]?.startsWith("-")) { console.log(usage); process.exit(0); }
  const r = falsePassSvg();
  const out = process.argv[2] ?? "false-pass.svg";
  writeFileSync(out, r.svg);
  console.log(`wrote ${out}: same-block false-pass ${(r.atUsed[0] * 100).toFixed(1)}-${(r.atUsed[1] * 100).toFixed(1)}% at 3-6 draws per arm`);
}
