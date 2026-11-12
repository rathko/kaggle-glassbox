#!/usr/bin/env bun
// score-reader: a generic gated reader for a set of scored runs. It checks every run's
// RUN-INTEGRITY instruments FIRST (via score-gate.readability) and prints NO SCORE AT ALL if any
// run fails that check — so a decision can never be taken on the strength of a number that was
// never actually earned. Only once every run passes does it seal each run (score-gate.sealRead,
// which forbids any further instrument repair) and then print the per-run and aggregate pass
// rate.
//
// This is deliberately generic: it has no notion of strata, baselines, or a pass/fail bar — your
// own analysis owns those. What it owns is the ORDER OF OPERATIONS: gate, then seal, then read.
// Build your own task-specific reader on top of readability()/sealRead() the same way, and keep
// that ordering.
//
// usage: bun src/integrity/score-reader.ts <run-dir> [<run-dir> ...]
//          [--outcome-field resolved] [--task-field instance_id] [--allow-legacy]
//          [--outcome-kind binary|numeric] [--aggregate mean|sum]
// --mixed-slates accepts runs that score different task sets (refused by default: the mean would mix tests).
// --outcome-kind numeric reads a per-task score you computed yourself (partial credit, a per-task metric): every
// outcome must be a finite number (not a boolean), and the run's score is the --aggregate (mean, the default, or sum)
// of its rows. The kind and the aggregate are sealed with the result, so a later read cannot re-aggregate a sealed
// run. The default, binary, is unchanged: true/false or 1/0 per task, score = passed / total.
// --allow-legacy accepts a run that has only a mutable instruments.json and no run-end record.
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { readability, sealRead, lockRuns } from "./score-gate";
import { strictArgs } from "../cli-args";
import { safeMean } from "./safe-mean";
import { binaryOutcome } from "./outcome";

const rawArgv = process.argv.slice(2);
const USAGE = "usage: bun src/integrity/score-reader.ts <run-dir> [<run-dir> ...] [--outcome-field resolved] [--task-field instance_id] [--outcome-kind binary|numeric] [--aggregate mean|sum] [--allow-legacy] [--mixed-slates]";
const runArgs = strictArgs(rawArgv, { valued: ["outcome-field", "task-field", "outcome-kind", "aggregate"], bool: ["allow-legacy", "mixed-slates"], positionals: [1, Infinity] }, USAGE);
const flag = (n: string, d: string) => { const i = rawArgv.indexOf(`--${n}`); return i >= 0 ? rawArgv[i + 1] : d; };
const OUTCOME = flag("outcome-field", "resolved");
const TASK = flag("task-field", "instance_id");
const ALLOW_LEGACY = rawArgv.includes("--allow-legacy");
const KIND = flag("outcome-kind", "binary"), AGG = flag("aggregate", "mean");
if (KIND !== "binary" && KIND !== "numeric") { console.error(`--outcome-kind must be binary or numeric, got '${KIND}'\n${USAGE}`); process.exit(2); }
if (AGG !== "mean" && AGG !== "sum") { console.error(`--aggregate must be mean or sum, got '${AGG}'\n${USAGE}`); process.exit(2); }
if (KIND === "binary" && rawArgv.includes("--aggregate")) { console.error(`--aggregate needs --outcome-kind numeric (a binary read is passed / total)\n${USAGE}`); process.exit(2); }
const NUMERIC = KIND === "numeric";

// Each run is resolved to its real path once, and that canonical list is the only one used for locking, reading and
// the mean: the same run named twice (`A ./A`, a symlink, a trailing slash) would otherwise be weighted twice.
const canonical = runArgs.map((d) => (existsSync(d) ? realpathSync(d) : resolve(d)));
const dupes = runArgs.filter((_, i) => canonical.indexOf(canonical[i]!) !== i);
if (dupes.length) { console.error(`the same run is named more than once (${dupes.map((d) => JSON.stringify(d)).join(", ")}); name each run once\n${USAGE}`); process.exit(2); }
const runDirs = canonical;

// Every run stays locked from the integrity check through sealing (released on exit), so a concurrent reader cannot
// seal a run between this reader's check of the seal and its own seal.
try { lockRuns(runDirs); } catch (e) { console.log(`LOCKED (no scores printed): ${(e as Error).message}`); process.exit(1); }

// The result rows are read ONCE, before the integrity check, and that buffer is what gets hashed against the
// run-end record and then parsed and sealed: a late write to task_results.jsonl between the check and the read can
// then neither slip an unverified score through nor change the number printed. The sealed read records the buffer's
// sha256 (rowsSha256).
const rowBytes = new Map<string, Buffer>();
const fails: string[] = [];
for (const d of runDirs) {
  const rp = join(d, "task_results.jsonl");
  if (!existsSync(rp)) { fails.push(`${d}: no task_results.jsonl`); continue; }
  const buf = readFileSync(rp);
  rowBytes.set(d, buf);
  const g = readability(d, { allowLegacy: ALLOW_LEGACY, retained: new Map([["task_results.jsonl", buf]]) });
  if (!g.ok) fails.push(`${d}: ${g.reasons.join("; ")}`);
}
if (fails.length) {
  console.log("RUN-INTEGRITY FAILURES (no scores printed):\n  " + fails.join("\n  "));
  process.exit(1);
}

// Parse and validate EVERY row before sealing anything: a seal is permanent, so a malformed file or an outcome
// field with the wrong type must stop the read before the score exists, not after.
const parsed: { d: string; rows: any[] }[] = [];
const bad: string[] = [];
for (const d of runDirs) {
  const rows: any[] = [];
  const seen = new Set<string>();
  rowBytes.get(d)!.toString("utf8").trim().split("\n").filter(Boolean).forEach((l, i) => {
    let r: any;
    try { r = JSON.parse(l); } catch { bad.push(`${d}: line ${i + 1} is not JSON`); return; }
    if (!r || typeof r !== "object" || Array.isArray(r)) { bad.push(`${d}: line ${i + 1} is not a JSON object`); return; }
    if (NUMERIC) { if (typeof r[OUTCOME] !== "number" || !Number.isFinite(r[OUTCOME])) bad.push(`${d}: line ${i + 1}: "${OUTCOME}" must be a finite number for --outcome-kind numeric, got ${JSON.stringify(r[OUTCOME])} (set --outcome-field)`); }
    else if (binaryOutcome(r[OUTCOME]) === undefined) bad.push(`${d}: line ${i + 1}: "${OUTCOME}" must be true/false or 1/0, got ${JSON.stringify(r[OUTCOME])} (set --outcome-field)`);
    const id = r[TASK];
    if (!(typeof id === "string" && id !== "") && !(typeof id === "number" && Number.isFinite(id))) bad.push(`${d}: line ${i + 1}: "${TASK}" must be a non-empty string or a number, got ${JSON.stringify(id)} (set --task-field)`);
    else if (seen.has(String(id))) bad.push(`${d}: line ${i + 1}: task ${JSON.stringify(id)} appears twice; one row per task`);
    seen.add(String(id));
    rows.push(r);
  });
  if (!rows.length) bad.push(`${d}: task_results.jsonl has no rows`);
  parsed.push({ d, rows });
}
if (bad.length) {
  console.log("RESULT ROWS INVALID (nothing sealed, no scores printed):\n  " + bad.slice(0, 20).join("\n  ") + (bad.length > 20 ? `\n  ... and ${bad.length - 20} more` : ""));
  process.exit(1);
}

// The repository's statistics assume one fixed slate: every run must score the same task ids, or the mean mixes
// different tests. --mixed-slates accepts differing sets on purpose (and says so).
const MIXED = rawArgv.includes("--mixed-slates");
if (parsed.length > 1 && !MIXED) {
  const ids = parsed.map(({ rows }) => new Set(rows.map((r) => String(r[TASK]))));
  const diffs: string[] = [];
  parsed.forEach(({ d }, i) => {
    if (i === 0) return;
    const missing = [...ids[0]!].filter((x) => !ids[i]!.has(x)), extra = [...ids[i]!].filter((x) => !ids[0]!.has(x));
    if (missing.length || extra.length) diffs.push(`${d}: ${missing.length} task(s) missing vs ${parsed[0]!.d} (e.g. ${missing.slice(0, 3).join(", ")}), ${extra.length} extra (e.g. ${extra.slice(0, 3).join(", ")})`);
  });
  if (diffs.length) {
    console.log("RUNS SCORE DIFFERENT TASK SETS (nothing sealed, no scores printed; pass --mixed-slates if that is intended):\n  " + diffs.join("\n  "));
    process.exit(1);
  }
}

// The seal records what was read (fields and counts); a later read of the same run must match it exactly, so a
// second invocation cannot pick another field and print a different number for a sealed run.
// A numeric read adds its kind and aggregate, and seals the aggregated value itself; a binary read keeps the payload
// it always had, so seals written before numeric reads existed still match.
// A mean whose plain sum overflows (rows near Number.MAX_VALUE) is computed without overflow (safe-mean.ts); the plain
// sum is kept whenever it is finite, so ordinary reads are unchanged bit for bit.
const aggregate = (rows: any[]) => { const xs = rows.map((r) => r[OUTCOME] as number); return AGG === "sum" ? xs.reduce((a, b) => a + b, 0) : safeMean(xs); };
const rowsSha256 = (d: string) => createHash("sha256").update(rowBytes.get(d)!).digest("hex");
const reads = parsed.map(({ d, rows }) => ({ d, read: NUMERIC
  ? { taskField: TASK, outcomeField: OUTCOME, outcomeKind: "numeric", aggregate: AGG, value: aggregate(rows), total: rows.length, rowsSha256: rowsSha256(d) } as Record<string, unknown>
  : { taskField: TASK, outcomeField: OUTCOME, passed: rows.filter((r) => binaryOutcome(r[OUTCOME]) === true).length, total: rows.length, rowsSha256: rowsSha256(d) } as Record<string, unknown> }));
// A seal written before rowsSha256 existed is compared on every field it does record (fields, counts, value); the
// digest is only required to match when the seal carries one. A seal with no read at all stays a conflict (below).
const sameRead = (prior: any, read: Record<string, unknown>) => {
  if (prior === undefined || prior === null) return false;
  const { rowsSha256: digest, ...rest } = read;
  return "rowsSha256" in prior ? JSON.stringify(prior) === JSON.stringify(read) : JSON.stringify(prior) === JSON.stringify(rest);
};
// A non-finite aggregate (a sum that overflows) cannot be sealed: JSON would store it as null, so the printed
// number and the permanent seal would disagree. Refuse before anything is sealed.
const nonFinite = reads.filter(({ read }) => NUMERIC && !Number.isFinite(read.value as number));
if (nonFinite.length) {
  console.log(`NON-FINITE ${AGG} (nothing sealed, no scores printed):\n  ` + nonFinite.map(({ d, read }) => `${d}: ${read.value}`).join("\n  "));
  process.exit(1);
}
// Check every existing seal BEFORE creating any: a batch that fails must not leave some of its runs sealed.
const conflicts: string[] = [];
for (const { d, read } of reads) {
  const p = join(d, "score-read.json");
  if (!existsSync(p)) continue;
  const prior = JSON.parse(readFileSync(p, "utf8")).read;
  // a seal that does not say what was read (an older or custom reader) cannot vouch for this read either
  if (prior === undefined) conflicts.push(`${d}: sealed by a reader that recorded no read; a new score cannot be printed for it`);
  else if (!sameRead(prior, read)) conflicts.push(`${d}: sealed as ${JSON.stringify(prior)}, this read is ${JSON.stringify(read)}`);
}
if (conflicts.length) {
  console.log("SEALED READ DIFFERS (nothing sealed, no scores printed):\n  " + conflicts.join("\n  "));
  process.exit(1);
}
// The lock makes a race impossible between readers that use it; the seal each call returns is still checked, so a
// reader that ignored the lock and sealed first can never make this one print a number that disagrees with the seal.
const raced: string[] = [];
for (const { d, read } of reads) {
  const s = sealRead(d, "src/integrity/score-reader.ts", read);
  if (!s.created && !sameRead(s.record?.read, read)) raced.push(`${d}: sealed as ${JSON.stringify(s.record?.read)}, this read is ${JSON.stringify(read)}`);
}
if (raced.length) {
  console.log("SEALED READ DIFFERS (no scores printed):\n  " + raced.join("\n  "));
  process.exit(1);
}

if (NUMERIC) {
  const values = reads.map(({ d, read }) => { console.log(`${d}: ${AGG} ${OUTCOME} ${read.value} over ${read.total} distinct ${TASK}`); return read.value as number; });
  console.log(`MEAN of per-run ${AGG} ${safeMean(values)} across n=${runDirs.length} run(s)`);
  process.exit(0);
}
const rates: number[] = [];
for (const { d, read: { passed, total: n } } of reads as { d: string; read: { passed: number; total: number } }[]) {
  const rate = passed / n;
  rates.push(rate);
  console.log(`${d}: ${passed}/${n} ${OUTCOME} (${(rate * 100).toFixed(1)}%), ${n} distinct ${TASK}`);
}
const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
console.log(`MEAN pass rate ${(mean * 100).toFixed(2)}% across n=${runDirs.length} run(s)`);
