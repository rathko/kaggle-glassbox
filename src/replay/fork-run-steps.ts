// Loads the captured exchanges of one task from one source run, in seq order. Shared by
// fork-run.ts (and any fork-optimisation loop you build on top of it).
//
// A source run is any results directory that has a `capture/` subdirectory produced by
// wire-tap.ts --capture-full and compacted by capture-compact.ts (so it contains manifest.json
// and task-<key>.jsonl.gz files) and whose manifest entries have been attributed to task ids by
// capture-attribute.ts (so each entry carries an `instances` array).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertValidCaptures } from "./capture-valid";
import { manifestArchives, taskSnaps } from "../capture/archives";

export function loadSteps(sourceRunDir: string, task: string): any[] {
  const cap = join(sourceRunDir, "capture");
  if (!existsSync(join(cap, "manifest.json"))) throw new Error(`no capture/manifest.json in ${sourceRunDir}`);
  // A task's exchanges can be split over several capture groups (the group key is a prompt head), and one group can
  // hold several tasks' exchanges; take exactly this task's (archives.ts taskSnaps), in seq order. Each archive must
  // agree with its manifest entry (count, first/last seq): a truncated archive would replay as a shorter trajectory
  // and fork at the wrong step.
  const rows = taskSnaps(manifestArchives(cap), task);
  if (!rows.length) throw new Error(`no captured exchange attributed to ${task} in ${sourceRunDir}`);
  assertValidCaptures(rows, `${task} in ${sourceRunDir}`);
  return rows;
}

/** One rollout's outcome from a result file (JSON object, JSON array, or JSONL). The row is the one whose
 *  `taskField` equals `task`; a file holding exactly ONE row WITHOUT a task field is taken as that task's row
 *  (single-task harnesses); one row naming another task gives null, and so do two or more rows for the task (which
 *  one is the rollout's is unknowable).
 *  true for true / 1 / "true" / "pass" / "passed" / "resolved" / "success"; false for false / 0 / "false" / "fail" /
 *  "failed" / "unresolved"; null (not a failure) for anything else, a missing row, or an unreadable file, so an
 *  instrument failure is never counted as the agent failing. With `threshold` set, a finite numeric outcome (a
 *  reward or score such as 0.73) is a success when >= threshold and a miss below it; with direction "lower" (a loss
 *  or error, lower is better) a success is <= threshold. */
export function readOutcome(text: string, task: string, taskField: string, outcomeField: string, threshold: number | null = null,
  direction: "higher" | "lower" = "higher"): boolean | null {
  let rows: any[];
  const t = text.trim();
  if (!t) return null;
  try { const j = JSON.parse(t); rows = Array.isArray(j) ? j : [j]; }
  catch { try { rows = t.split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return null; } }
  // the one-row fallback is for harnesses that do not write a task field at all; a row that names ANOTHER task
  // is a stale or misrouted result file, never this rollout's outcome
  const matches = rows.filter((r) => r?.[taskField] !== undefined && String(r[taskField]) === task);
  if (matches.length > 1) return null;
  const row = matches[0]
    ?? (rows.length === 1 && rows[0] && typeof rows[0] === "object" && !(taskField in rows[0]) ? rows[0] : undefined);
  if (!row || !(outcomeField in row)) return null;
  const v = row[outcomeField];
  if (threshold !== null) {
    const x = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (Number.isFinite(x)) return direction === "lower" ? x <= threshold : x >= threshold;
    if (typeof v !== "boolean") return null;
  }
  const s = typeof v === "string" ? v.toLowerCase() : v;
  if (s === true || s === 1 || ["true", "pass", "passed", "resolved", "success", "1"].includes(s)) return true;
  if (s === false || s === 0 || ["false", "fail", "failed", "unresolved", "0"].includes(s)) return false;
  return null;
}

/** Why one fork rollout cannot be counted (empty = valid). A rollout counts only if the harness exited 0, its
 *  outcome was readable, all K captured steps were forced, and none diverged from the capture. */
export function invalidReasons(r: { rc: number; outcome: boolean | null; forced: number; divergent: number }, K: number): string[] {
  return [
    ...(r.rc !== 0 ? [`harness exit ${r.rc}`] : []),
    ...(r.outcome === null ? ["no readable outcome"] : []),
    ...(r.forced !== K ? [`forced ${r.forced} of ${K} captured steps`] : []),
    ...(r.divergent ? [`${r.divergent} forced step(s) diverged`] : []),
  ];
}
