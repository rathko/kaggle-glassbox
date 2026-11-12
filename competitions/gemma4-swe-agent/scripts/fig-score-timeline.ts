#!/usr/bin/env bun
// Figure 1 of the paper: the public score of every upload, identical-bytes pairs joined by arcs, and a band
// of +/- one measured re-score SD around the mean of the uploads on the public base.
// Data: data/platform-history.csv only. usage: bun competitions/gemma4-swe-agent/scripts/fig-score-timeline.ts [out.svg]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePlatformHistory, pairedDiffs, rescoreSdWithCi, type PlatformRow } from "./reproduce-paper-numbers";

export const PUBLIC_BASE_FROM = "10-28"; // first upload built on the public base bundle
export const CANARY = "V20"; // a deliberately broken scorer canary, scored 0 by design

export function scoreTimelineSvg(rows: PlatformRow[]): { svg: string; mean: number; sdScore: number; points: number; arcs: number } {
  const sdTasks = rescoreSdWithCi(pairedDiffs(rows)).sd; // measured same-bytes re-score SD, in tasks of 58
  const sd = sdTasks / 58;
  const W = 900, H = 420, L = 60, R = 20, T = 40, B = 70;
  const x = (i: number) => L + (i * (W - L - R)) / (rows.length - 1);
  const y = (s: number) => T + (1 - s / 0.3) * (H - T - B);
  const bf = rows.filter((r) => r.date >= PUBLIC_BASE_FROM);
  const m = bf.reduce((a, r) => a + r.score, 0) / bf.length;
  const i0 = rows.findIndex((r) => r.date >= PUBLIC_BASE_FROM);
  const o: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Helvetica, Arial, sans-serif" font-size="12">`, `<rect width="100%" height="100%" fill="white"/>`];
  o.push(`<rect x="${x(i0)}" y="${y(m + sd)}" width="${x(rows.length - 1) - x(i0)}" height="${y(m - sd) - y(m + sd)}" fill="#3B82F6" opacity="0.12"/>`);
  o.push(`<line x1="${x(i0)}" x2="${x(rows.length - 1)}" y1="${y(m)}" y2="${y(m)}" stroke="#3B82F6" stroke-dasharray="4 3"/>`);
  o.push(`<text x="${x(i0) + 30}" y="${y(m - sd) + 18}" fill="#1e40af">mean ± 1 measured re-score SD</text>`);
  for (const g of [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3]) {
    o.push(`<line x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}" stroke="#e5e7eb"/>`);
    o.push(`<text x="${L - 8}" y="${y(g) + 4}" text-anchor="end" fill="#374151">${g.toFixed(2)}</text>`);
  }
  const byPair = new Map<number, number[]>();
  rows.forEach((r, i) => { if (r.pairId !== null) byPair.set(r.pairId, [...(byPair.get(r.pairId) ?? []), i]); });
  let arcs = 0;
  for (const [ia, ib] of byPair.values()) {
    if (ib === undefined) continue;
    arcs++;
    o.push(`<path d="M${x(ia!)},${y(rows[ia!]!.score)} Q${(x(ia!) + x(ib)) / 2},${y(0.27)} ${x(ib)},${y(rows[ib]!.score)}" fill="none" stroke="#dc2626" stroke-width="1.5"/>`);
  }
  rows.forEach((r, i) => {
    o.push(`<circle cx="${x(i)}" cy="${y(r.score)}" r="4.5" fill="${r.date >= PUBLIC_BASE_FROM ? "#1d4ed8" : "#6b7280"}"/>`);
    o.push(`<text x="${x(i)}" y="${H - B + 16}" transform="rotate(60 ${x(i)} ${H - B + 16})" fill="#374151" font-size="10">${r.anonVariant}${r.anonVariant === CANARY ? "*" : ""}</text>`);
  });
  o.push(`<text x="${L}" y="22" font-size="15" font-weight="bold">Public score per upload (${rows.length} scored uploads, ${rows[0]!.date} to ${rows[rows.length - 1]!.date})</text>`);
  o.push(`<text x="${W - R}" y="22" text-anchor="end" fill="#dc2626">red arcs: identical bytes uploaded twice</text>`);
  o.push(`<text x="${W - R}" y="36" text-anchor="end" fill="#6b7280">grey: own lineage · blue: public base + changes · *deliberate canary</text>`);
  o.push(`</svg>`);
  return { svg: o.join("\n"), mean: m, sdScore: sd, points: rows.length, arcs };
}

if (import.meta.main) {
  (await import("../../../src/cli-args.ts")).strictArgs(process.argv.slice(2), { positionals: [0, 1] }, "usage: bun competitions/gemma4-swe-agent/scripts/fig-score-timeline.ts [out.svg]   (default score-timeline.svg; reads data/platform-history.csv)");
  const rows = parsePlatformHistory(readFileSync(join(import.meta.dir, "..", "data/platform-history.csv"), "utf8"));
  const r = scoreTimelineSvg(rows);
  if (process.argv[2]?.startsWith("-")) { console.log("usage: bun competitions/gemma4-swe-agent/scripts/fig-score-timeline.ts [out.svg]   (default score-timeline.svg; reads data/platform-history.csv)"); process.exit(0); }
  const out = process.argv[2] ?? "score-timeline.svg";
  writeFileSync(out, r.svg);
  console.log(`wrote ${out}: ${r.points} uploads, ${r.arcs} same-bytes arcs, public-base mean ${r.mean.toFixed(4)}, re-score SD ${r.sdScore.toFixed(4)} (score units)`);
}
