import { test, expect, setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000); // statistical tests can take seconds on a loaded machine (the bunfig preload alone did not always apply)
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseAttempts, summarise, pearson, summariseForks } from "./community-data";

const ROOT = join(import.meta.dir, "..");          // this competition's folder (data/ lives here)
const REPO = join(import.meta.dir, "..", "..", "..");  // the repository root (the private patterns and the repo-wide scan)
const read = (f: string) => readFileSync(join(ROOT, "data", f), "utf8");
const attempts = parseAttempts(read("attempts.csv"));

function rows(f: string): Record<string, string>[] {
  const [h, ...rs] = read(f).trim().split("\n");
  const cols = h!.split(",");
  return rs.map((r) => Object.fromEntries(r.split(",").map((v, i) => [cols[i]!, v])));
}

test("attempts.csv agrees with flaky10-task-outcomes.csv and base-era-task-outcomes.csv, row for row", () => {
  const key = (d: string, t: string) => `${d}|${t}`;
  const a = new Map(attempts.map((x) => [key(x.draw, x.task), x.resolved]));
  const others = [...rows("flaky10-task-outcomes.csv"), ...rows("base-era-task-outcomes.csv")];
  expect(a.size).toBe(attempts.length); // no duplicate (draw, task)
  expect(others.length).toBe(attempts.length);
  for (const r of others) expect(a.get(key(r.anon_draw!, r.anon_task!))).toBe(Number(r.resolved));
});

test("per-draw solve counts and their SD match the outcome files", () => {
  const per = (xs: { d: string; r: number }[]) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x.d, (m.get(x.d) ?? 0) + x.r);
    return m;
  };
  const a = per(attempts.map((x) => ({ d: x.draw, r: x.resolved })));
  const b = per(rows("flaky10-task-outcomes.csv").map((x) => ({ d: x.anon_draw!, r: Number(x.resolved) })));
  for (const [d, n] of b) expect(a.get(d)).toBe(n);
  expect([...a.keys()].filter((d) => b.has(d)).length).toBe(b.size); // every flaky-10 draw is in attempts.csv
});

test("task-solve-rates.csv is recomputable from attempts.csv", () => {
  const per = new Map<string, { n: number; s: number }>();
  for (const x of attempts) { const v = per.get(x.task) ?? { n: 0, s: 0 }; v.n++; v.s += x.resolved; per.set(x.task, v); }
  const rs = rows("task-solve-rates.csv");
  expect(rs.length).toBe(per.size);
  expect(new Set(rs.map((r) => r.anon_task)).size).toBe(rs.length); // no task twice, so none is missing either
  const cls = (r: number) => (r === 0 ? "never" : r === 1 ? "always" : r < 0.2 ? "rare" : r > 0.8 ? "usual" : "coin_flip");
  for (const r of rs) {
    const v = per.get(r.anon_task!)!;
    expect(Number(r.draws)).toBe(v.n);
    expect(Number(r.solved)).toBe(v.s);
    expect(Number(r.rate)).toBeCloseTo(v.s / v.n, 3);
    expect(r.class).toBe(cls(v.s / v.n));
  }
});

test("attempt rows are internally consistent", () => {
  const STOPS = new Set(["withheld", "finished", "call_limit", "turn_limit", "time_limit", "context_limit", "error", "finished_or_unknown"]);
  for (const x of attempts) {
    expect(STOPS.has(x.stop)).toBe(true);
    expect(x.resolved === 0 || x.resolved === 1).toBe(true);
    if (x.stop === "withheld") {
      expect([x.toolCalls, x.llmCalls, x.wallS, x.patchBytes, x.completionTokens, x.peakPromptTokens, x.editCalls, x.editErrors]).toEqual(Array(8).fill(null));
      continue;
    }
    expect(x.wallS!).toBeGreaterThan(0);
    if (x.editCalls !== null) expect(x.editErrors!).toBeLessThanOrEqual(x.editCalls);
  }
});

test("summary is stable (pins the README process numbers)", () => {
  const s = summarise(attempts);
  expect(s.attempts).toBe(3985);
  expect(s.tasks).toBe(129);
  expect(s.withheldAttempts).toBe(1194);
  // the exact values the README quotes
  expect(s.editCalls).toBe(6905);
  expect((100 * s.editFailureRate).toFixed(1)).toBe("36.1");
  expect((100 * s.stopShares.finished!).toFixed(1)).toBe("55.9");
  expect((100 * s.stopShares.call_limit!).toFixed(1)).toBe("32.1");
  expect((100 * s.stopShares.turn_limit!).toFixed(1)).toBe("5.8");
  expect((100 * s.stopShares.time_limit!).toFixed(1)).toBe("5.7");
  expect(s.tokensWallCorr.perDrawMedian.toFixed(2)).toBe("0.97");
  expect(s.tokensWallCorr.drawsUsed).toBe(97);
  expect(s.tokensWallCorr.perDrawQ1.toFixed(2)).toBe("0.95"); // README: IQR 0.950-0.985
  expect(s.tokensWallCorr.perDrawQ3.toFixed(3)).toBe("0.985");
  expect(s.tokensWallCorr.perDrawMedian).toBeGreaterThan(0.9);
  const shares = Object.values(s.stopShares).reduce((p, q) => p + q, 0);
  expect(shares).toBeCloseTo(1, 12);
});

test("fork ledger: 334 rollouts; the short self-test replays 13 of 13 steps, the long one shows its pre-fix divergence", () => {
  const f = summariseForks(read("fork-ledger.csv"));
  expect(f.rollouts).toBe(334);
  expect(f.selftests.filter((s) => s.includes("0 of 13 forced"))).toHaveLength(1);
  expect(f.selftests.some((s) => / [1-9]\d* of 4[02] forced/.test(s))).toBe(true);
});

test("pearson is 1 for a line and -1 for its mirror", () => {
  expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
  expect(pearson([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1, 12);
});

// ---------------- leak scan over every released data file ----------------
// The release must not carry real task ids, internal version labels, host or path names, or the withheld
// ideas. The specific patterns name exactly what is withheld, so they live in a PRIVATE file that is never
// committed (LEAK_PATTERNS, or leak-patterns.private.json at the repository root, gitignored). This public file keeps
// only generic patterns; without the private file the specific scan is skipped, and says so.
const PUBLIC_DATA_LEAKS: [string, RegExp][] = [
  ["internal version label", /\bv\d{2,4}[A-Za-z0-9-]*\b/],
  ["base named as withheld or champion", /current[- ]best|\bchampion\b/i],
  ["home path", /\/home\/[a-z]/i],
  ["tailnet host", /\.ts\.net\b/i],
  ["IPv4 address", /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
];
const PUBLIC_REPO_LEAKS: [string, RegExp][] = [
  ["internal version label", /\bv\d{2,4}[A-Za-z0-9-]*\b/],
  ["withheld line named", /current[- ]best line/i],
  ["home path", /\/home\/[a-z]/i],
  ["tailnet host", /\.ts\.net\b/i],
];
const PRIVATE_PATH = process.env.LEAK_PATTERNS ?? join(REPO, "leak-patterns.private.json");
const priv: { data: [string, string, string][]; repo: [string, string, string][] } | null = existsSync(PRIVATE_PATH) ? JSON.parse(readFileSync(PRIVATE_PATH, "utf8")) : null;
const compile = (xs: [string, string, string][]) => xs.map(([w, src, fl]) => [w, new RegExp(src, fl)] as [string, RegExp]);
const LEAKS = [...PUBLIC_DATA_LEAKS, ...(priv ? compile(priv.data) : [])];
const REPO_LEAKS = [...PUBLIC_REPO_LEAKS, ...(priv ? compile(priv.repo) : [])];
if (!priv) console.warn(`leak scan: ${PRIVATE_PATH} not found; only the generic patterns run`);

test.skipIf(!priv)("the private leak-pattern file is loaded (maintainers only)", () => {
  expect(priv!.data.length).toBeGreaterThan(3);
  expect(priv!.repo.length).toBeGreaterThan(2);
});

test("no released data file leaks a withheld or internal string", () => {
  const hits: string[] = [];
  for (const f of readdirSync(join(ROOT, "data"))) {
    const text = read(f);
    for (const [what, re] of LEAKS) { const m = text.match(re); if (m) hits.push(`${f}: ${what} "${m[0]}"`); }
  }
  expect(hits).toEqual([]);
});

// Repo-wide: every tracked text file (code, docs, README), not only data/. Narrower patterns, because
// prose legitimately says "hostnames" or "test oracle".

function walk(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return e.name === "node_modules" || e.name === ".git" ? [] : walk(dir, r);
    return [r];
  });
}

test("no tracked file anywhere in the repo leaks a withheld or internal string", () => {
  // git ls-files when there is a repo; a plain walk otherwise (the Docker build context has no .git, and
  // an empty file list would make this test pass without scanning anything)
  // (the oven/bun image has no git binary at all, and Bun.spawnSync throws rather than failing)
  let listed: string[];
  try {
    const git = Bun.spawnSync(["git", "ls-files"], { cwd: REPO });
    listed = git.exitCode === 0 ? git.stdout.toString().trim().split("\n") : walk(REPO);
  } catch { listed = walk(REPO); }
  const files = listed.filter((f) => f && !/\.(png|svg|lock)$/.test(f) && !f.endsWith(".private.json"));
  expect(files.length).toBeGreaterThan(40);
  const hits: string[] = [];
  for (const f of files) {
    let text: string;
    try { text = readFileSync(join(REPO, f), "utf8"); } catch { continue; }
    for (const [what, re] of REPO_LEAKS) { const m = text.match(re); if (m) hits.push(`${f}: ${what} "${m[0]}"`); }
  }
  expect(hits).toEqual([]);
});

test("hindsight A/A: every unchanged package with >= 7 flaky-10 draws gives FP(4,3) between 13% and 23%", async () => {
  const { drawCountsByPackage, MIN_DRAWS } = await import("./aa-hindsight");
  const { falsePass } = await import("../../../src/noise-floor/aa-splits");
  const pk = [...drawCountsByPackage(readFileSync(join(ROOT, "data/flaky10-task-outcomes.csv"), "utf8"))].filter(([, c]) => c.length >= MIN_DRAWS);
  expect(pk.length).toBe(6);
  for (const [, c] of pk) { const fp = falsePass(c, 4, 3).fp; expect(fp).toBeGreaterThan(0.13); expect(fp).toBeLessThan(0.23); }
}, 60_000);

test("task-sets.json: fast-43 and flaky-10 are subsets of the 129, and flaky-10 matches the tasks its draws ran", () => {
  const s = JSON.parse(read("task-sets.json"));
  const all = new Set<string>(s["local-129"].tasks);
  expect(all.size).toBe(129);
  const f43 = Object.values(s["fast-43"].strata).flatMap((v: any) => v.tasks as string[]);
  expect(f43.length).toBe(43);
  for (const t of f43) expect(all.has(t)).toBe(true);
  const f10 = s["flaky-10"].tasks.map((t: any) => t.task as string);
  expect(new Set(f10).size).toBe(10);
  const ran = new Set(attempts.filter((x) => x.slate === "flaky10").map((x) => x.task));
  expect([...ran].sort()).toEqual([...f10].sort());
});
