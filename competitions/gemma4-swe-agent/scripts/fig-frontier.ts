#!/usr/bin/env bun
// The failure frontier, from released data: how every attempt of each group ended. The paper's Figure 6 is a
// screenshot of one early run's private failure summary; this is the public counterpart, drawn from
// data/attempts.csv only. Groups whose process columns are withheld (stop = "withheld") are left out and counted
// in the subtitle. "Resolved" counts every solved attempt whatever its stop; the other segments split the
// unsolved ones by how they stopped ("finished" = the agent stopped on its own with a fix that did not pass).
// usage: bun competitions/gemma4-swe-agent/scripts/fig-frontier.ts [out.svg]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Attempt { group: string; slate: string; resolved: boolean; stop: string }
export const ENDINGS = ["resolved", "finished", "call_limit", "turn_limit", "time_limit", "context_limit", "error"] as const;
const COLOURS: Record<string, string> = { resolved: "#16a34a", finished: "#dc2626", call_limit: "#7c3aed", turn_limit: "#a78bfa", time_limit: "#d97706", context_limit: "#0891b2", error: "#6b7280" };
const LABELS: Record<string, string> = { resolved: "resolved", finished: "stopped with a wrong fix", call_limit: "call limit", turn_limit: "turn limit", time_limit: "time limit", context_limit: "context limit", error: "error" };

export function parseAttempts(csv: string): Attempt[] {
  const [head, ...lines] = csv.trim().split("\n");
  const cols = head!.split(","), gi = cols.indexOf("group"), si = cols.indexOf("slate"), ri = cols.indexOf("resolved"), ti = cols.indexOf("stop");
  if ([gi, si, ri, ti].includes(-1)) throw new Error("attempts.csv: expected columns group, slate, resolved, stop");
  return lines.map((l) => { const c = l.split(","); return { group: c[gi]!, slate: c[si]!, resolved: c[ri] === "1", stop: c[ti]! }; });
}

/** Per group: attempts by ending, in group order (F## families first, then V## packages). Withheld groups excluded. */
export function endings(rows: Attempt[]): { groups: { group: string; slate: string; n: number; counts: Record<string, number> }[]; withheld: number } {
  const m = new Map<string, { group: string; slate: string; n: number; counts: Record<string, number> }>();
  let withheld = 0;
  for (const r of rows) {
    if (r.stop === "withheld") { withheld++; continue; }
    const key = r.resolved ? "resolved" : r.stop;
    if (!(ENDINGS as readonly string[]).includes(key)) throw new Error(`attempts.csv: unknown stop '${r.stop}'`);
    const g = m.get(r.group) ?? { group: r.group, slate: r.slate, n: 0, counts: {} };
    g.n++; g.counts[key] = (g.counts[key] ?? 0) + 1;
    m.set(r.group, g);
  }
  return { groups: [...m.values()].sort((a, b) => a.group.localeCompare(b.group)), withheld };
}

export function frontierSvg(rows: Attempt[]): { svg: string; groups: number; withheld: number; shares: Record<string, number> } {
  const { groups, withheld } = endings(rows);
  const W = 760, rowH = 18, T = 84, B = 40, L = 120, R = 30, H = T + groups.length * rowH + B;
  const x = (f: number) => L + f * (W - L - R);
  const o: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Helvetica, Arial, sans-serif" font-size="12"><rect width="100%" height="100%" fill="white"/>`];
  for (const g of [0, 0.25, 0.5, 0.75, 1]) o.push(`<line x1="${x(g)}" x2="${x(g)}" y1="${T - 4}" y2="${H - B}" stroke="#e5e7eb"/><text x="${x(g)}" y="${H - B + 16}" text-anchor="middle" fill="#374151">${g * 100}%</text>`);
  groups.forEach((g, i) => {
    const cy = T + i * rowH;
    o.push(`<text x="${L - 8}" y="${cy + 12}" text-anchor="end" fill="#374151" font-size="11">${g.group} · ${g.slate === "flaky10" ? "flaky-10" : `${g.slate}-task`} · n=${g.n}</text>`);
    let acc = 0;
    for (const e of ENDINGS) {
      const c = g.counts[e] ?? 0;
      if (!c) continue;
      const w = c / g.n;
      o.push(`<rect x="${x(acc).toFixed(1)}" y="${cy + 2}" width="${(x(acc + w) - x(acc)).toFixed(1)}" height="${rowH - 4}" fill="${COLOURS[e]}"><title>${g.group}: ${LABELS[e]} ${c}/${g.n}</title></rect>`);
      acc += w;
    }
  });
  let lx = 10;
  for (const e of ENDINGS) {
    o.push(`<rect x="${lx}" y="56" width="10" height="10" fill="${COLOURS[e]}"/><text x="${lx + 14}" y="65" fill="#374151" font-size="11">${LABELS[e]}</text>`);
    lx += 24 + LABELS[e]!.length * 6;
  }
  const tot = groups.reduce((s, g) => s + g.n, 0), shares: Record<string, number> = {};
  for (const e of ENDINGS) shares[e] = groups.reduce((s, g) => s + (g.counts[e] ?? 0), 0) / tot;
  o.push(`<text x="10" y="22" font-size="15" font-weight="bold">How every attempt ended, per group</text>`);
  o.push(`<text x="10" y="40" fill="#6b7280">${tot} attempts with a released stop reason (${withheld} withheld left out): ${(shares.finished! * 100).toFixed(0)}% stopped with a wrong fix, ${(shares.call_limit! * 100).toFixed(0)}% hit the call limit.</text></svg>`);
  return { svg: o.join("\n"), groups: groups.length, withheld, shares };
}

if (import.meta.main) {
  const usage = "usage: bun competitions/gemma4-swe-agent/scripts/fig-frontier.ts [out.svg]   (default frontier.svg; reads data/attempts.csv)";
  (await import("../../../src/cli-args.ts")).strictArgs(process.argv.slice(2), { positionals: [0, 1] }, usage);
  if (process.argv[2]?.startsWith("-")) { console.log(usage); process.exit(0); }
  const r = frontierSvg(parseAttempts(readFileSync(join(import.meta.dir, "..", "data/attempts.csv"), "utf8")));
  const out = process.argv[2] ?? "frontier.svg";
  writeFileSync(out, r.svg);
  console.log(`wrote ${out}: ${r.groups} groups, ${r.withheld} withheld attempts left out`);
}
