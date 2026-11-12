#!/usr/bin/env bun
// run-end: write a run's immutable run-end record (instruments.runend.json) the moment the run finishes,
// before anyone looks at a score. It stores your instrument checks and a hash of the raw artifacts, so
// the score reader can later prove the rows it scores are the rows the run produced. It refuses to
// overwrite an existing record.
//
// Call it as the last step of your harness's run script. Each --check is name=ok or name=fail[:detail].
// The checks "rows" (the result rows are complete and parse) and "stack" (the environment/config is the
// one you meant to run) are required: they describe the run itself and can never be repaired later. When
// "stack" is ok, <run-dir>/stack.json must exist and parse: your guard writes what it checked there (versions,
// config, image digest), and it is hashed with the artifacts, so the record pins the environment, not only your
// word for it. Raw (uncompacted) snapshots in capture/ are refused: they are not part of the hash.
//
// Run this AFTER capture-compact (and capture-attribute, if you use it): the capture archives and the
// attribution are part of the record.
//
// CAPTURE IS CHECKED, NOT ATTESTED. A run with task rows must have a compacted capture/: a manifest.json listing at
// least one exchange, every listed archive present, parsing line by line with positive unique seqs, its line count
// and first/last seq equal to the manifest entry, and no archive the manifest does not list. A proxy that was
// bypassed or misrouted (no capture/ at all) would otherwise close an agent run with no trajectory. When that holds
// and you gave no capture check, the record gets a computed capture=ok ("N exchange(s) in M archive(s)"); an
// explicit capture=ok is verified the same way; an explicit capture=fail is recorded as given (a repairable
// failure). --no-capture waives the check for a run that deliberately has no or a partial capture (a non-agent
// pipeline). An artifact-only run must choose: --check capture=ok (an agent scored by the platform; its capture is
// verified the same way, with per-task coverage when it keeps task rows) or --no-capture (a pipeline with no model
// traffic). Saying neither is refused, since the same close command serves both.
//
// COVERAGE. A consistent capture is not enough: every task in task_results.jsonl (its id read from --task-field,
// default instance_id) must have at least one captured exchange attributed to it (the snapshot's task_id from the
// x-task-id header, or the `instances` capture-attribute writes). A task that bypassed the proxy would otherwise be
// sealed as captured. A task that genuinely made no model call is waived by name with --uncaptured-ok <id,...>; the
// waiver is recorded in the run-end record as the check "uncaptured" (ok, with the ids), so it is visible later.
//
// ARTIFACT-ONLY RUNS. A run whose score comes from submitted bytes rather than task rows (a tabular or other
// continuous-metric submission) passes --artifact-only. It then needs no task_results.jsonl; instead
// artifacts/ must hold at least one regular file, and the required checks are "artifacts" (the submitted bytes
// are complete and are the ones you meant to score) and "stack", in place of "rows" and "stack". The record
// says artifact_only: true, and the reader requires the same pair. examples/read-platform-score.ts reads such
// a run. artifacts/ must hold copies: a symlink would seal its target's path, not its bytes, so it is refused.
//
// Artifacts hashed (the run layout every integrity tool here assumes):
//   <run-dir>/task_results.jsonl      one JSON row per task (absent in an artifact-only run)
//   <run-dir>/patches/*               optional, any files
//   <run-dir>/capture/*.jsonl.gz      optional, compacted captures (capture-compact.ts)
//   <run-dir>/stack.json              what your "stack" check verified (required when stack=ok)
//   <run-dir>/artifacts/**            optional, the exact bytes you submitted or scored (submission.csv,
//                                     model files, predictions), recursively, by relative path
// and, hashed separately so a recorded capture repair can change it, the attribution:
//   <run-dir>/capture/manifest.json, <run-dir>/capture/task-index.json
//
// usage: bun src/integrity/run-end.ts <run-dir> --check rows=ok --check stack=ok [--check capture=fail:why ...] [--no-capture]
//        bun src/integrity/run-end.ts <run-dir> --artifact-only --no-capture --check artifacts=ok --check stack=ok
//        bun src/integrity/run-end.ts <run-dir> --artifact-only --check artifacts=ok --check stack=ok --check capture=ok
//        [--task-field instance_id] [--uncaptured-ok <id,...>]   (coverage, see above)
import { existsSync, readdirSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { recordRunEnd, requiredChecks, artifactProblems, rawSnapshots } from "./score-gate";
import { checkCapture, snapTask } from "../capture/archives";
import { captureProblems } from "../replay/capture-valid";

const USAGE = "usage: bun src/integrity/run-end.ts <run-dir> [--artifact-only] --check rows=ok|artifacts=ok --check stack=ok [--check NAME=ok|fail[:detail] ...] [--no-capture] [--task-field instance_id] [--uncaptured-ok <id,...>]";

/** Task ids the capture attributes at least one exchange to, exchange by exchange (archives.ts snapTask): the
 *  harness task id, capture-attribute's per-seq map, or the archive's single task. An archive listing several
 *  `instances` with no per-seq map covers none of them, since no task's trajectory can be recovered from it. Ids
 *  are compared as strings (a numeric id 7 matches "7"). */
export function capturedTaskIds(dir: string): Set<string> {
  const out = new Set<string>();
  const c = checkCapture(join(dir, "capture"));
  for (const a of c.archives) {
    for (const l of a.lines) { const t = snapTask(a.entry, l.snap); if (t) out.add(t); }
  }
  return out;
}

/** Why the capture does not cover the result rows (empty = every row task has a captured exchange or is waived).
 *  Also refuses a waiver that names a task the rows do not have (a typo would otherwise waive nothing silently). */
export function captureCoverageProblems(dir: string, taskField = "instance_id", waived: string[] = []): string[] {
  const rowsPath = join(dir, "task_results.jsonl");
  if (!existsSync(rowsPath)) return [];
  const ids: string[] = [], out: string[] = [];
  readFileSync(rowsPath, "utf8").split("\n").forEach((l, i) => {
    if (!l.trim()) return;
    let r: any;
    try { r = JSON.parse(l); } catch { out.push(`task_results.jsonl line ${i + 1} does not parse`); return; }
    const id = r?.[taskField];
    if (!((typeof id === "string" && id !== "") || (typeof id === "number" && Number.isFinite(id)))) { out.push(`task_results.jsonl line ${i + 1} has no "${taskField}" (set --task-field)`); return; }
    ids.push(String(id));
  });
  if (out.length) return out;
  const rowSet = new Set(ids), w = new Set(waived);
  const unknown = [...w].filter((id) => !rowSet.has(id));
  if (unknown.length) out.push(`--uncaptured-ok names task(s) not in task_results.jsonl: ${unknown.slice(0, 10).join(", ")}`);
  // an archive that carries attribution (or attribution that compaction marked stale) must attribute every exchange:
  // one that resolves to no task is missing from every trajectory, even when its task is covered by older exchanges
  const unattributed: string[] = [];
  for (const a of checkCapture(join(dir, "capture")).archives) {
    const e = a.entry ?? {};
    if (e.attribution_stale) { unattributed.push(`${a.name}: ${e.attribution_stale}`); continue; }
    if (!Array.isArray(e.instances) && !(e.seq_tasks && typeof e.seq_tasks === "object")) continue;
    const n = a.lines.filter((l) => snapTask(e, l.snap) === null).length;
    if (n) unattributed.push(`${a.name}: ${n} of ${a.lines.length} exchange(s) attributed to no task (re-run capture-attribute)`);
  }
  if (unattributed.length) out.push(`capture holds exchanges with no task: ${unattributed.slice(0, 5).join("; ")}${unattributed.length > 5 ? "; ..." : ""}`);
  const captured = capturedTaskIds(dir);
  const missing = [...rowSet].filter((id) => !captured.has(id) && !w.has(id)).sort();
  if (missing.length) out.push(`${missing.length} of ${rowSet.size} task(s) have no captured exchange (${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", ..." : ""}): did they bypass the proxy? Run capture-attribute if your harness sends no x-task-id; pass --uncaptured-ok <id,...> for tasks that made no model call`);
  return out;
}

/** The compacted capture of a run: its problems (empty = usable) and, when usable, how many exchanges and archives
 *  it holds. A capture needs a manifest listing at least one exchange, every listed archive present and parseable,
 *  and no unlisted archive, and every exchange must be replayable by the same rule the replay tools apply
 *  (replay/capture-valid.ts: a 2xx status, no error, a usable answer, a finished stream): capture=ok means a later
 *  replay screen can use the run, so a run whose upstream failed mid-way is closed with --check capture=fail:<why>. */
export function captureStatus(dir: string): { problems: string[]; exchanges: number; archives: number } {
  const cap = join(dir, "capture");
  if (!existsSync(join(cap, "manifest.json"))) return { problems: ["capture/ has no manifest.json (run capture-compact)"], exchanges: 0, archives: 0 };
  // the same parse capture-compact applies: every line an object with a positive unique seq, and each archive's line
  // count and first/last seq equal to its manifest entry, so a truncated or padded archive is never sealed as ok
  const c = checkCapture(cap);
  const problems = c.problems.map((p) => `capture/: ${p}`);
  const exchanges = c.archives.reduce((n, a) => n + a.lines.length, 0), archives = c.archives;
  if (!problems.length && exchanges === 0) problems.push("capture/ holds no exchange: was the model reached through the capturing proxy? (--no-capture if this run deliberately has none)");
  if (!problems.length) {
    const bad: string[] = [];
    for (const a of c.archives) for (const l of a.lines) { const why = captureProblems(l.snap); if (why.length) bad.push(`${a.name} seq ${l.snap?.seq}: ${why.join(", ")}`); }
    if (bad.length) problems.push(`${bad.length} captured exchange(s) are not replayable (${bad.slice(0, 5).join("; ")}${bad.length > 5 ? "; ..." : ""}); close with --check capture=fail:<why> to record that`);
  }
  return { problems, exchanges, archives: archives.length };
}

export function parseChecks(specs: string[], artifactOnly = false): Record<string, { ok: boolean; detail: string }> {
  const checks: Record<string, { ok: boolean; detail: string }> = {};
  for (const spec of specs) {
    const m = spec.match(/^([A-Za-z0-9_-]+)=(ok|fail)(?::(.*))?$/);
    if (!m) throw new Error(`bad --check '${spec}' (want NAME=ok or NAME=fail[:detail])`);
    if (m[1]! in checks) throw new Error(`check '${m[1]}' given twice`);
    checks[m[1]!] = { ok: m[2] === "ok", detail: m[3] ?? "" };
  }
  for (const k of requiredChecks(artifactOnly)) if (!(k in checks)) throw new Error(`required check '${k}' is missing${artifactOnly ? " (an artifact-only run needs artifacts and stack)" : ""}`);
  if (!artifactOnly && "artifacts" in checks && !("rows" in checks)) throw new Error("check 'artifacts' without --artifact-only");
  return checks;
}

/** Why a run-end record must not be written yet (empty = go). Library callers of recordRunEnd should check
 *  this first; the CLI always does.
 *  - no result rows (or, with artifactOnly, no regular file in artifacts/);
 *  - anything but regular files and directories in artifacts/;
 *  - raw per-exchange snapshots still in capture/: they are not in the hash, so the record would seal a capture
 *    that is not the one later read (run capture-compact first);
 *  - `stack` recorded as ok with no readable stack.json to back it: the record would pin nothing;
 *  - a run with task rows whose capture/ is missing, empty or inconsistent (captureStatus), unless the capture
 *    check is an explicit fail or opts.noCapture waives it;
 *  - an artifact-only run that does not say whether it was captured: it must pass --check capture=ok (an agent run;
 *    the capture is verified, with per-task coverage when task rows exist) or opts.noCapture (no model traffic),
 *    since one close command serves both a tabular pipeline and an agent scored by the platform;
 *  - an artifact-only run that claims capture=ok without a consistent capture. */
export function runEndProblems(dir: string, checks: Record<string, { ok: boolean }>, opts: { artifactOnly?: boolean; noCapture?: boolean; taskField?: string; uncapturedOk?: string[] } = {}): string[] {
  const out: string[] = [];
  if (opts.artifactOnly) { if (!hasRegularFile(join(dir, "artifacts"))) out.push("--artifact-only but artifacts/ holds no file"); }
  else if (!existsSync(join(dir, "task_results.jsonl"))) out.push("no task_results.jsonl (for a run scored from submitted bytes, use --artifact-only)");
  out.push(...artifactProblems(dir));
  const raw = rawSnapshots(dir);
  if (raw.length) out.push(`${raw.length} raw snapshot(s) in capture/ are not compacted (${raw.slice(0, 3).join(", ")}${raw.length > 3 ? ", ..." : ""}); run capture-compact first`);
  if (checks.stack?.ok) {
    const sp = join(dir, "stack.json");
    if (!existsSync(sp)) out.push("stack=ok but no stack.json: write what the stack check verified to <run-dir>/stack.json");
    else { try { JSON.parse(readFileSync(sp, "utf8")); } catch { out.push("stack.json does not parse as JSON"); } }
  }
  // an artifact-only agent run that claims its capture is complete needs an inventory of the tasks it ran: without one,
  // coverage has nothing to check against, and one captured task would vouch for every task that bypassed the proxy
  if (opts.artifactOnly && checks.capture?.ok === true && !existsSync(join(dir, "task_results.jsonl")))
    out.push(`--artifact-only --check capture=ok needs a task inventory: an id-only task_results.jsonl, one {"${opts.taskField ?? "instance_id"}": ...} row per task (outcomes not needed; the score comes from the platform), so every task's capture can be checked`);
  if (opts.artifactOnly && !opts.noCapture && !("capture" in checks))
    out.push("an --artifact-only run must say whether it was captured: --check capture=ok for an agent run (the capture is verified) or --no-capture for a pipeline with no model traffic");
  const verifyCapture = opts.artifactOnly ? checks.capture?.ok === true : !opts.noCapture && checks.capture?.ok !== false;
  if (opts.noCapture && checks.capture?.ok === true) out.push("--no-capture contradicts --check capture=ok");
  if (verifyCapture && !raw.length) {
    if (!existsSync(join(dir, "capture"))) out.push("no capture/ directory: an agent run is closed with its compacted capture (pass --no-capture for a run that deliberately has none)");
    else {
      const st = captureStatus(dir).problems;
      out.push(...st);
      // coverage only makes sense on a consistent capture, and only where task rows say which tasks ran (an
      // artifact-only agent run may keep its rows too; captureCoverageProblems is empty when there are none)
      if (!st.length) out.push(...captureCoverageProblems(dir, opts.taskField, opts.uncapturedOk));
    }
  }
  if (opts.uncapturedOk?.length && !(verifyCapture && existsSync(join(dir, "task_results.jsonl")))) out.push("--uncaptured-ok only applies to a run with task rows whose capture is checked");
  return out;
}

function hasRegularFile(d: string): boolean {
  if (!existsSync(d) || !lstatSync(d).isDirectory()) return false;
  return readdirSync(d).some((f) => { const st = lstatSync(join(d, f)); return st.isFile() || (st.isDirectory() && hasRegularFile(join(d, f))); });
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); process.exit(0); }
  const dirs: string[] = [], specs: string[] = [];
  let artifactOnly = false, noCapture = false, taskField: string | undefined, uncapturedOk: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--artifact-only") { if (artifactOnly) { console.error(`--artifact-only given twice\n${USAGE}`); process.exit(2); } artifactOnly = true; }
    else if (argv[i] === "--no-capture") { if (noCapture) { console.error(`--no-capture given twice\n${USAGE}`); process.exit(2); } noCapture = true; }
    else if (argv[i] === "--task-field" || argv[i] === "--uncaptured-ok") {
      const flag = argv[i]!, v = argv[i + 1];
      if (v === undefined || v === "" || v.startsWith("--")) { console.error(`${flag} needs a value\n${USAGE}`); process.exit(2); }
      if (flag === "--task-field") { if (taskField !== undefined) { console.error(`--task-field given twice\n${USAGE}`); process.exit(2); } taskField = v; }
      else {
        if (uncapturedOk !== undefined) { console.error(`--uncaptured-ok given twice\n${USAGE}`); process.exit(2); }
        const ids = v.split(",");
        if (ids.some((x) => x === "") || new Set(ids).size !== ids.length) { console.error(`--uncaptured-ok must be a comma-separated list of distinct, non-empty task ids\n${USAGE}`); process.exit(2); }
        uncapturedOk = ids;
      }
      i++;
    }
    else if (argv[i] === "--check") { if (argv[i + 1] === undefined) { console.error(USAGE); process.exit(2); } specs.push(argv[++i]!); }
    else if (argv[i]!.startsWith("--")) { console.error(`unknown flag ${argv[i]}\n${USAGE}`); process.exit(2); }
    else dirs.push(argv[i]!);
  }
  if (dirs.length !== 1) { console.error(USAGE); process.exit(2); }
  const dir = dirs[0]!;
  let checks;
  try { checks = parseChecks(specs, artifactOnly); } catch (e) { console.error(`${(e as Error).message}\n${USAGE}`); process.exit(2); }
  if ("uncaptured" in checks) { console.error(`'uncaptured' is recorded from --uncaptured-ok, not given as a --check\n${USAGE}`); process.exit(2); }
  const problems = runEndProblems(dir, checks, { artifactOnly, noCapture, taskField, uncapturedOk });
  if (problems.length) { console.error(`${dir}: refusing to write the run-end record: ${problems.join("; ")}`); process.exit(1); }
  // a verified capture is recorded as a computed check, so the record says what was found rather than what was claimed
  if (!artifactOnly && !noCapture && !("capture" in checks) && existsSync(join(dir, "capture"))) {
    const c = captureStatus(dir);
    checks.capture = { ok: true, detail: `${c.exchanges} exchange(s) in ${c.archives} archive(s)` };
  }
  // the waiver is part of the immutable record, so a reader sees which tasks were closed without a capture
  if (uncapturedOk?.length) checks.uncaptured = { ok: true, detail: `no model call, waived: ${uncapturedOk.join(", ")}` };
  if (!recordRunEnd(dir, checks, { artifactOnly })) { console.error(`${dir}: run-end record already exists; it is written once and never overwritten`); process.exit(1); }
  const failed = Object.entries(checks).filter(([, v]) => !v.ok).map(([k]) => k);
  console.log(`run-end record written: ${join(dir, "instruments.runend.json")}${failed.length ? ` (failed checks: ${failed.join(", ")})` : ""}`);
}
