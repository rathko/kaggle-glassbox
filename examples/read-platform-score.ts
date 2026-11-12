#!/usr/bin/env bun
// read-platform-score: the gated-reader pattern for a run whose score only the PLATFORM computes: a hidden-label
// competition that returns one aggregate number (accuracy, RMSE, AUC, a fractional score) and no per-task verdicts
// you could write into task_results.jsonl. What decides the reader is where the score comes from, not its type: a
// binary accuracy from a hidden test set belongs here too. A run with your own per-task verdicts is read by
// src/integrity/score-reader.ts instead. A minimal template to copy, in the same order as score-reader.ts: gate,
// then seal, then print. (examples/read-continuous-score.ts is the same reader under its earlier name.)
//
// The score does not exist when the run ends: the platform computes it after you upload the sealed bytes. So the
// run is closed first, as an artifact-only run holding only what you submitted (artifacts/submission.csv, model
// files), and the platform's score is handed in later from OUTSIDE the run directory:
//   bun src/integrity/run-end.ts <run-dir> --artifact-only --no-capture --check artifacts=ok --check stack=ok
//   (an agent scored by the platform closes with --check capture=ok instead of --no-capture)
//   ... upload artifacts/, wait for the platform's score ...
//   bun examples/read-platform-score.ts <run-dir> --score 0.8312
// Nothing is added to the run directory except the seal, so the run stays readable. A score file kept inside the
// run directory is refused: writing it would change the sealed artifacts, or sit next to them unsealed.
//
// The seal records the score it was read with and where it came from (for --score-file, the field and the sha256 of
// the very bytes the score was parsed from; the file is read once). Reading the run again must present the same
// record: the same score from the same source (and, for a file, the same field and bytes). Anything else is
// refused, so one set of submitted bytes can never end up with two "sealed" scores or a swapped score file.
//
// Named observations. A platform can score the same bytes more than once: a public leaderboard score now, a private
// or final one when the competition closes. Each is its own immutable observation, `--observation <name>` (default
// "public"): each name is sealed once with its own record, a different score under a name already sealed is refused,
// and a new name can be added later without reopening anything (repairs stay refused once any observation exists).
// "public" is the run's main seal (score-read.json), so a seal written before observations existed counts as public;
// every other name gets score-read.obs-<name>.json.
//
// Only a run closed with --artifact-only is accepted (checked before anything is read or sealed): sealing a run with
// task rows here would block score-reader.ts on it for good. The run is locked from the gate through the seal.
//
// usage: bun examples/read-platform-score.ts <run-dir> (--score <number> | --score-file <path> [--field score]) [--observation public]
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, relative, isAbsolute, join } from "node:path";
import { readability, sealRead, lockRuns, observationSealFile } from "../src/integrity/score-gate";
import { strictArgs } from "../src/cli-args";

const usage = (script: string) => `usage: bun ${script} <run-dir> (--score <number> | --score-file <path outside the run dir> [--field score]) [--observation public]`;

const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
const inside = (dir: string, p: string) => { const r = relative(real(dir), real(p)); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };

export type ScoreRead = { score: number; source: "--score" } | { score: number; source: "--score-file"; field: string; sha256: string };

/** The platform's score for a closed run, with its provenance: `score` given directly, or `field` read from
 *  `scoreFile` (a JSON object, or a file holding just the number), which must live outside `runDir`. The file is
 *  read ONCE and both the score and the sha256 come from that one buffer. Throws unless the score is finite. */
export function readExternalScoreWithSource(runDir: string, opts: { score?: string; scoreFile?: string; field?: string }): ScoreRead {
  if ((opts.score === undefined) === (opts.scoreFile === undefined)) throw new Error("give exactly one of --score or --score-file");
  const finite = (v: unknown) => { if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`the score is not a finite number`); return v; };
  if (opts.score !== undefined) return { score: finite(opts.score.trim() === "" ? NaN : Number(opts.score)), source: "--score" };
  const p = opts.scoreFile!, field = opts.field ?? "score";
  if (inside(runDir, p)) throw new Error(`${p} is inside the run directory: keep the platform's score outside the sealed run`);
  if (!existsSync(p)) throw new Error(`${p} not found`);
  const bytes = readFileSync(p);
  const text = bytes.toString("utf8").trim();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  const v = typeof parsed === "object" && parsed !== null ? (parsed as any)[field] : typeof parsed === "string" && parsed !== "" ? Number(parsed) : parsed;
  return { score: finite(v), source: "--score-file", field, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** The score alone (see readExternalScoreWithSource). */
export function readExternalScore(runDir: string, opts: { score?: string; scoreFile?: string; field?: string }): number {
  return readExternalScoreWithSource(runDir, opts).score;
}

/** Do two seal payloads describe the same read? Every recorded key must match exactly (score, source, field, sha256). */
export function sameRead(recorded: unknown, now: ScoreRead | (ScoreRead & { observation: string })): boolean {
  if (!recorded || typeof recorded !== "object") return false;
  const r = recorded as Record<string, unknown>, n = now as Record<string, unknown>;
  const keys = new Set([...Object.keys(r), ...Object.keys(n)]);
  for (const k of keys) if (r[k] !== n[k]) return false;
  return true;
}

/** The command line: gate, seal, print. `script` names the entry point in usage and in the seal. */
export function main(argv: string[], script = "examples/read-platform-score.ts"): void {
  const dir = strictArgs(argv, { valued: ["score", "score-file", "field", "observation"], positionals: [1, 1] }, usage(script))[0]!;
  const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const OBS = opt("observation") ?? "public";
  let sealFile: string;
  try { sealFile = OBS === "public" ? "score-read.json" : observationSealFile(OBS); }
  catch (e) { console.error((e as Error).message); process.exit(2); }
  // only a run closed as artifact-only: a run with task rows is read (and sealed) by score-reader.ts, and sealing it
  // here with an external score would block that reader for good
  const re = join(dir, "instruments.runend.json");
  let artifactOnly = false;
  try { artifactOnly = JSON.parse(readFileSync(re, "utf8")).artifact_only === true; } catch {}
  if (!artifactOnly) { console.log(`REFUSED (nothing sealed, no score printed): ${dir} was not closed as an artifact-only run (run-end.ts --artifact-only); a run with task rows is read with src/integrity/score-reader.ts`); process.exit(1); }
  try { lockRuns([dir]); } catch (e) { console.log(`LOCKED (no score printed): ${(e as Error).message}`); process.exit(1); }
  const g = readability(dir);
  if (!g.ok) { console.log(`RUN-INTEGRITY FAILURE (no score printed): ${g.reasons.join("; ")}`); process.exit(1); }
  let read: ScoreRead;
  try { read = readExternalScoreWithSource(dir, { score: opt("score"), scoreFile: opt("score-file"), field: opt("field") }); }
  catch (e) { console.log(`unreadable score, nothing sealed: ${(e as Error).message}`); process.exit(1); }
  // the public observation keeps the original payload (so a seal written before observations existed still matches);
  // any other name records itself in its payload as well as in its file name
  const payload = OBS === "public" ? read : { ...read, observation: OBS };
  const seal = sealRead(dir, script, payload, sealFile);
  const label = OBS === "public" ? "score" : `score (${OBS})`;
  if (!seal.created) {
    const recorded = seal.record?.read;
    if (!sameRead(recorded, payload)) {
      console.log(`REFUSED: the ${OBS} observation of this run was already sealed with ${recorded ? JSON.stringify(recorded) : "no recorded score"}; this read (${JSON.stringify(payload)}) does not match it`);
      process.exit(1);
    }
    console.log(`${dir}: ${label} = ${recorded.score} (already sealed ${seal.record.at})`);
  } else console.log(`${dir}: ${label} = ${read.score}`);
}

if (import.meta.main) main(process.argv.slice(2));
