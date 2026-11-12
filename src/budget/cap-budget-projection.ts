#!/usr/bin/env bun
// cap-budget-projection: what does a candidate per-task time cap ACTUALLY cost over a full
// evaluation slate?
//
// The naive budget argument is "cap x n_tasks", which assumes every task runs to the cap. That
// is wrong, and it steers decisions the wrong way: tasks that finish early still finish early
// when the cap rises, so raising the cap costs far less than cap x n_tasks implies, and a table
// built on that assumption will make a safe cap look unaffordable or an unaffordable cap look
// safe.
//
// The honest projection instead takes a MEASURED per-task duration distribution from a past run,
// truncates each duration downward to the candidate cap (a task that would have run longer is
// clipped there; one that finished earlier is unaffected), and takes the mean. That reconstructs
// what the candidate cap would have cost, using real task-to-task variance instead of assuming
// every task saturates it.
//
// This only works if the SOURCE run's own cap was high enough that most durations are
// UNcensored — i.e. most tasks finished before hitting it. Using a source run whose cap already
// clipped most tasks is circular: you'd be truncating already-truncated data, which
// systematically underestimates what a higher candidate cap would really cost.
//
// Also reports, for each candidate cap, how many of the source run's SOLVED tasks would still
// finish inside that cap — the upside a given cap buys, not just its cost.
//
// usage: bun src/budget/cap-budget-projection.ts <source-run-task-results.jsonl> \
//          --n-tasks 120 --limit-hours 12 --setup-reserve-hours 1.5 --measured-good-hours 8.0 \
//          [--caps 240,250,260,280,300,320,350,400,500] [--outcome-field resolved]
//          [--duration-field duration_seconds]
import { readFileSync } from "node:fs";
import { countFlag } from "../replay/cli-num";
import { strictArgs } from "../cli-args";

const argv = process.argv.slice(2);
const [SRC] = strictArgs(argv, {
  valued: ["n-tasks", "limit-hours", "setup-reserve-hours", "measured-good-hours", "outcome-field", "duration-field", "caps"],
  positionals: [1, 1],
}, "usage: bun src/budget/cap-budget-projection.ts <task_results.jsonl> --n-tasks N --limit-hours H [options]");
const flag = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
if (!SRC || SRC.startsWith("--")) {
  console.error("usage: bun src/budget/cap-budget-projection.ts <task_results.jsonl> --n-tasks N --limit-hours H [options]");
  process.exit(2);
}
if (flag("n-tasks") === undefined) { console.error("error: --n-tasks is required and must be a positive whole number"); process.exit(2); }
const N_TASKS = countFlag("n-tasks", flag("n-tasks"), 0);
const LIMIT_H = Number(flag("limit-hours"));
const SETUP_RESERVE_H = Number(flag("setup-reserve-hours", "0"));
const MEASURED_GOOD_H = flag("measured-good-hours") ? Number(flag("measured-good-hours")) : null;
const OUTCOME_FIELD = flag("outcome-field", "resolved")!;
const DURATION_FIELD = flag("duration-field", "duration_seconds")!;
const CAPS = (flag("caps", "240,250,260,280,300,320,350,400,500")!).split(",").map(Number);
const bad = (what: string) => { console.error(`error: ${what}`); process.exit(2); };
if (!(Number.isFinite(LIMIT_H) && LIMIT_H > 0)) bad("--limit-hours is required and must be a positive number");
if (!(Number.isFinite(SETUP_RESERVE_H) && SETUP_RESERVE_H >= 0 && SETUP_RESERVE_H < LIMIT_H)) bad("--setup-reserve-hours must be >= 0 and below --limit-hours");
if (MEASURED_GOOD_H !== null && !(Number.isFinite(MEASURED_GOOD_H) && MEASURED_GOOD_H > 0)) bad("--measured-good-hours must be a positive number");
if (!CAPS.length || CAPS.some((c) => !(Number.isFinite(c) && c > 0))) bad("--caps must be comma-separated positive seconds");
const USABLE_H = LIMIT_H - SETUP_RESERVE_H;

const rows = readFileSync(SRC, "utf8").trim().split("\n").filter(Boolean).map((l, i) => {
  try { return JSON.parse(l); } catch { bad(`${SRC} line ${i + 1} is not JSON`); }
});
if (!rows.length) bad(`${SRC} has no rows`);
rows.forEach((r: any, i: number) => {
  const d = r[DURATION_FIELD];
  if (typeof d !== "number" || !Number.isFinite(d) || d < 0) bad(`${SRC} line ${i + 1}: "${DURATION_FIELD}" must be a non-negative number of seconds, got ${JSON.stringify(d)} (set --duration-field)`);
});
const durs = rows.map((r: any) => r[DURATION_FIELD] as number);
const solvedDurs = rows.filter((r: any) => r[OUTCOME_FIELD]).map((r: any) => r[DURATION_FIELD] as number);

console.log(`source: ${SRC}, n=${rows.length}, ${OUTCOME_FIELD}=${solvedDurs.length}, max ${DURATION_FIELD} ${Math.round(Math.max(...durs))}s\n`);
console.log("cap    meanDur   proj         vs measured-good   solved captured   verdict");
console.log("-----  -------   ----------   -----------------  ---------------   -------");

for (const cap of CAPS) {
  const truncated = durs.map((d) => Math.min(d, cap));
  const mean = truncated.reduce((a, b) => a + b, 0) / truncated.length;
  const projH = (mean * N_TASKS) / 3600;
  const captured = solvedDurs.filter((d) => d <= cap).length;
  const deltaStr = MEASURED_GOOD_H !== null
    ? `${(projH - MEASURED_GOOD_H >= 0 ? "+" : "") + (projH - MEASURED_GOOD_H).toFixed(2)}h`
    : "n/a";
  const verdict =
    MEASURED_GOOD_H !== null && projH <= MEASURED_GOOD_H ? "SAFE (within measured-good AND legal)"
    : projH <= USABLE_H ? `LEGAL (fits ${LIMIT_H}h with ${SETUP_RESERVE_H}h setup reserve)`
    : projH < LIMIT_H ? "TIGHT (legal only if setup overhead is near-zero)"
    : "ILLEGAL (over the stated limit on task time alone)";
  console.log(
    `${String(cap).padStart(4)}s  ${mean.toFixed(0).padStart(6)}s   ${projH.toFixed(2).padStart(6)}h        ` +
    deltaStr.padStart(9) +
    `          ${String(captured).padStart(2)}/${solvedDurs.length} of source's solves`.padStart(23) +
    `   ${verdict}`
  );
}

console.log(
  `\nSTATED LIMIT: ${LIMIT_H}h total; usable task-time budget after a ${SETUP_RESERVE_H}h reserve ` +
  `for whatever overhead (sandbox setup, environment provisioning, etc.) sits inside that limit but ` +
  "outside your own measured per-task durations is " + `${USABLE_H}h. That reserve is a judgment call, ` +
  "not a measurement, and it is the live risk on any cap near the usable-budget edge."
);
