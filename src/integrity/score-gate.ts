// score-gate: the repair rule that keeps a measured score honest.
//
// A failed post-run instrument (e.g. the analysis pass, a synthesis step, the capture-attribution
// check) may be repaired only if ALL of these hold, and no score may be printed before they do:
//   1. the instrument is REPAIRABLE (by default: analysis, synthesis, capture). The run's raw
//      rows and its environment/config record (by default: "rows", "stack") reflect the run
//      itself and are NEVER repairable — if those failed, the run failed, full stop;
//   2. the run's raw artifacts (task_results.jsonl, patches/, capture/*.jsonl.gz, stack.json) hash to
//      exactly what they were at run end — a repair that runs against artifacts that have since changed
//      is not verifying the run you think it is;
//   3. no score has been read for the run yet (score-read.json absent) — once a human has seen
//      the number, "repairing" an instrument stops being quality control and starts being
//      p-hacking.
//
// The run-end instrument record (instruments.runend.json) is written once, by your own
// post-run guard, and never overwritten; repairs append to instruments.repairs.json. Readers
// call assertReadable() and then sealRead() BEFORE printing any score — see score-reader.ts for
// the reference reader built on this module.
//
// Capture ATTRIBUTION (capture/manifest.json and capture/task-index.json: which exchanges belong to which
// task) is hashed separately, because re-attributing is exactly what a "capture" repair does. A change to it
// after run end is admitted only through a recorded, successful capture repair that left it in that state;
// any other edit (say, pointing task A's trajectory at task B) makes the run unreadable.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync, chmodSync, lstatSync, readlinkSync, realpathSync, unlinkSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const REPAIRABLE = ["analysis", "synthesis", "capture"] as const;
// "artifacts" stands in for "rows" in an artifact-only run (no task rows, e.g. a tabular submission): see requiredChecks
export const NEVER_REPAIRABLE = ["rows", "stack", "artifacts"] as const;
/** The checks a run-end record must carry: rows + stack for a run with task rows, artifacts + stack for an
 *  artifact-only run (its scored bytes live in artifacts/). */
export function requiredChecks(artifactOnly: boolean): string[] { return artifactOnly ? ["artifacts", "stack"] : ["rows", "stack"]; }
type Checks = Record<string, { ok: boolean; detail: string }>;

const write = (p: string, v: unknown) => { writeFileSync(p, JSON.stringify(v, null, 1) + "\n"); try { chmodSync(p, 0o664); } catch {} };
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

// Every hashed entry is framed: a type tag, then the byte length and bytes of its run-relative path, then the
// byte length and bytes of its content. Without framing, file "a" = "X/patches/bY" and the pair "a" = "X",
// "b" = "Y" would feed the hash the same byte stream.
type Hash = ReturnType<typeof createHash>;
function frame(h: Hash, tag: string, rel: string, content: Buffer | null): void {
  const r = Buffer.from(rel, "utf8");
  h.update(`${tag}\0${r.length}\0`); h.update(r);
  if (content === null) h.update("\0-\0");
  else { h.update(`\0${content.length}\0`); h.update(content); }
}

/** Frames one file by streaming its bytes in fixed-size chunks, so a multi-gigabyte model file never has to fit in
 *  memory (or in one Buffer). The byte stream fed to the hash is identical to framing the whole file at once. A file
 *  whose size changes while it is read is refused: the hash would describe bytes that never existed together. */
export const HASH_CHUNK = 1 << 20;
function frameFile(h: Hash, rel: string, path: string): void {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size, buf = Buffer.allocUnsafe(Math.min(HASH_CHUNK, Math.max(size, 1)));
    const r = Buffer.from(rel, "utf8");
    h.update(`file\0${r.length}\0`); h.update(r); h.update(`\0${size}\0`);
    let done = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, done);
      if (n === 0) break;
      done += n;
      if (done > size) break;
      h.update(n === buf.length ? buf : buf.subarray(0, n));
    }
    if (done !== size) throw new Error(`${rel} changed size while it was hashed (${size} bytes at open, ${done} read); hash a run that is no longer being written`);
  } finally { closeSync(fd); }
}

/** Entries under artifacts/ that are not regular files or directories (symlinks, sockets, devices). A symlink
 *  would seal only its target path, not the bytes it points at, so artifacts/ must hold copies. */
/** Raw per-exchange snapshots still sitting in capture/ (anything .json but the manifest and the task index). They
 *  are never part of the artifact hash, so a run that has them is sealing a capture it cannot vouch for. */
export function rawSnapshots(runDir: string): string[] {
  const cap = join(runDir, "capture");
  if (!existsSync(cap)) return [];
  return readdirSync(cap).filter((f) => f.endsWith(".json") && f !== "manifest.json" && f !== "task-index.json").sort();
}

/** A hashed entry's label: its path relative to the RESOLVED run directory, with forward slashes. Labels must not
 *  depend on how the run directory was spelled ("./run-1", "run-1", an absolute path, "x/../run-1"), or an
 *  unchanged run would read as changed when opened through a different but equivalent path. */
const label = (root: string, p: string) => relative(root, p).split(sep).join("/");

export function artifactProblems(runDir: string): string[] {
  runDir = resolve(runDir);
  const out: string[] = [];
  const d = join(runDir, "artifacts");
  if (!existsSync(d) && !lstatExists(d)) return out;
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f), st = lstatSync(p), rel = label(runDir, p);
      if (st.isDirectory()) walk(p);
      else if (!st.isFile()) out.push(`${rel} is ${st.isSymbolicLink() ? `a symlink (to ${readlinkSync(p)})` : "not a regular file"}; copy the bytes into artifacts/`);
    }
  };
  if (lstatSync(d).isSymbolicLink()) out.push("artifacts is a symlink; make it a real directory holding copies");
  else walk(d);
  return out;
}
function lstatExists(p: string): boolean { try { lstatSync(p); return true; } catch { return false; } }

/** Content hash of everything that constitutes "the run's raw evidence". Throws if artifacts/ holds anything
 *  but regular files and directories (see artifactProblems). File contents are streamed (frameFile).
 *  `retained` substitutes bytes a caller already holds for the file at that run-relative path (say
 *  "task_results.jsonl"): a reader that hashes exactly the buffer it then parses cannot be fooled by a write that
 *  lands between the check and the read. */
export function artifactHash(runDir: string, retained?: Map<string, Buffer>): string {
  const bad = artifactProblems(runDir);
  if (bad.length) throw new Error(`artifacts/ cannot be sealed: ${bad.join("; ")}`);
  runDir = resolve(runDir);
  const h = createHash("sha256");
  const add = (p: string) => {
    const rel = label(runDir, p), held = retained?.get(rel);
    if (held) frame(h, "file", rel, held); else frameFile(h, rel, p);
  };
  const rows = join(runDir, "task_results.jsonl");
  if (existsSync(rows)) add(rows);
  for (const sub of ["patches", "capture"]) {
    const d = join(runDir, sub);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).sort()) if (sub === "patches" || f.endsWith(".jsonl.gz")) add(join(d, f));
  }
  const stack = join(runDir, "stack.json");
  if (existsSync(stack)) add(stack);
  // artifacts/: the exact bytes you submitted or scored (submission.csv, model files, predictions), any depth,
  // relative paths in sorted order; directories are framed too, so an empty directory or a move changes the hash.
  const walk = (d: string): void => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (lstatSync(p).isDirectory()) { frame(h, "dir", label(runDir, p), null); walk(p); }
      else add(p);
    }
  };
  const artifacts = join(runDir, "artifacts");
  if (existsSync(artifacts)) walk(artifacts);
  return h.digest("hex");
}

/** Content hash of the capture attribution (which captured exchanges belong to which task). */
export function attributionHash(runDir: string): string {
  const h = createHash("sha256");
  for (const f of ["manifest.json", "task-index.json"]) {
    const p = join(runDir, "capture", f);
    frame(h, existsSync(p) ? "file" : "absent", `capture/${f}`, existsSync(p) ? readFileSync(p) : null);
  }
  return h.digest("hex");
}

/** Called by your own post-run instrument guard on every write; records the run-end state the
 * FIRST time only. Returns false (and does nothing) if a run-end record already exists. */
export function recordRunEnd(runDir: string, checks: Checks, opts: { artifactOnly?: boolean } = {}): boolean {
  const p = join(runDir, "instruments.runend.json");
  if (existsSync(p)) return false;
  const record = { at: new Date().toISOString(), artifact_hash: artifactHash(runDir), attribution_hash: attributionHash(runDir), artifact_only: !!opts.artifactOnly, checks };
  // exclusive create: two guards racing past the existsSync check cannot both write, the second gets EEXIST
  try { writeFileSync(p, JSON.stringify(record, null, 1) + "\n", { flag: "wx" }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; throw e; }
  try { chmodSync(p, 0o664); } catch {}
  return true;
}

/** A score was read when the run's seal exists, or any named observation seal (score-read.obs-<name>.json, written by
 *  the platform reader for a second score such as a private leaderboard's). */
export function scoreWasRead(runDir: string): boolean {
  if (existsSync(join(runDir, "score-read.json"))) return true;
  try { return readdirSync(runDir).some((f) => /^score-read\.obs-[A-Za-z0-9_-]+\.json$/.test(f)); } catch { return false; }
}
/** The seal file for one named observation; the default (unnamed) seal is score-read.json. */
export const OBSERVATION_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const observationSealFile = (name: string) => {
  if (!OBSERVATION_NAME.test(name)) throw new Error(`observation name must be lowercase letters, digits, "_" or "-" (at most 32), got "${name}"`);
  return `score-read.obs-${name}.json`;
};

/** Throws unless a repair of `instrument` is allowed right now. */
export function assertRepairAllowed(runDir: string, instrument: string): void {
  if (!(REPAIRABLE as readonly string[]).includes(instrument))
    throw new Error(`REFUSED: '${instrument}' is not repairable (only ${REPAIRABLE.join(", ")}; rows/stack reflect the run itself)`);
  if (scoreWasRead(runDir)) throw new Error("REFUSED: a score has already been read for this run (score-read.json exists)");
  const re = join(runDir, "instruments.runend.json");
  if (!existsSync(re)) throw new Error("REFUSED: no run-end record (instruments.runend.json) to compare artifacts against");
  if (readJson(re).artifact_hash !== artifactHash(runDir)) throw new Error("REFUSED: raw artifacts changed since run end");
}

export function recordRepair(runDir: string, instrument: string, toolRef: string, ok: boolean, detail: string): void {
  const p = join(runDir, "instruments.repairs.json");
  const log = existsSync(p) ? readJson(p) : [];
  log.push({ at: new Date().toISOString(), instrument, tool_ref: toolRef, ok, detail, artifact_hash: artifactHash(runDir), attribution_hash: attributionHash(runDir) });
  write(p, log);
}

/** Integrity verdict for reading a score: run-end checks, with only valid repairs admitted.
 * A run without instruments.runend.json is refused unless allowLegacy is set: a mutable
 * instruments.json alone cannot prove the artifacts are the ones the run produced. */
export function readability(runDir: string, opts: { allowLegacy?: boolean; retained?: Map<string, Buffer> } = {}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const re = join(runDir, "instruments.runend.json"), cur = join(runDir, "instruments.json");
  if (!existsSync(re) && !existsSync(cur)) return { ok: false, reasons: ["no instruments record"] };
  if (!existsSync(re) && !opts.allowLegacy)
    return { ok: false, reasons: ["no run-end record (instruments.runend.json); write one with src/integrity/run-end.ts, or pass allowLegacy for a run that predates it"] };
  // Legacy runs (allowLegacy) that predate the run-end record have only instruments.json to go on.
  const runEnd: Checks = existsSync(re) ? readJson(re).checks : readJson(cur).checks;
  const now: Checks = existsSync(cur) ? readJson(cur).checks : runEnd;
  const repairs: any[] = existsSync(join(runDir, "instruments.repairs.json")) ? readJson(join(runDir, "instruments.repairs.json")) : [];
  let hashNow: string | null = null;
  if (existsSync(re)) {
    try { hashNow = artifactHash(runDir, opts.retained); } catch (e) { return { ok: false, reasons: [(e as Error).message] }; }
    if (readJson(re).artifact_hash !== hashNow) reasons.push("raw artifacts changed since run end");
    // a snapshot written after run end (say, a streamed answer that landed late) is outside the hash: refuse it
    const raw = rawSnapshots(runDir);
    if (raw.length) reasons.push(`${raw.length} raw snapshot(s) in capture/ are outside the sealed hash (${raw.slice(0, 3).join(", ")}${raw.length > 3 ? ", ..." : ""})`);
  }
  const attrEnd = existsSync(re) ? readJson(re).attribution_hash : undefined;
  if (attrEnd !== undefined) {
    const attrNow = attributionHash(runDir);
    const repaired = repairs.some((r) => r.instrument === "capture" && r.ok && r.artifact_hash === hashNow && r.attribution_hash === attrNow);
    if (attrEnd !== attrNow && !repaired) reasons.push("capture attribution changed since run end without a successful capture repair");
  }
  // the never-repairable checks describe the run itself; a record without them proves nothing about the run
  const artifactOnly = existsSync(re) ? readJson(re).artifact_only === true : false;
  for (const k of requiredChecks(artifactOnly)) if (!(k in runEnd)) reasons.push(`required check '${k}' is missing from the run-end record`);
  for (const [k, v] of Object.entries(runEnd)) {
    if (v.ok) continue;
    if ((NEVER_REPAIRABLE as readonly string[]).includes(k)) { reasons.push(`${k} failed at run end (not repairable)`); continue; }
    const fixed = repairs.some((r) => r.instrument === k && r.ok && r.artifact_hash === hashNow) && now[k]?.ok;
    if (!fixed) reasons.push(`${k} failed at run end and has no valid pre-read repair`);
  }
  return { ok: reasons.length === 0, reasons };
}

export function assertReadable(runDir: string, opts: { allowLegacy?: boolean } = {}): void {
  const r = readability(runDir, opts);
  if (!r.ok) throw new Error(`NOT READABLE: ${r.reasons.join("; ")}`);
}

/** Takes an exclusive read lock (score-read.lock, created with "wx") on every run, in sorted real-path order so two
 *  readers of overlapping batches cannot deadlock or interleave. Hold it from the integrity check through sealing: two
 *  readers that both found a run unsealed would otherwise each print their own number while only one seal survives.
 *  Throws (holding nothing) when any run is already locked. Returns the release function, which removes only the locks
 *  this call created; it is also run on process exit, so an early process.exit() never leaves a lock behind. */
export function lockRuns(runDirs: string[]): () => void {
  const dirs = [...new Set(runDirs.map((d) => (existsSync(d) ? realpathSync(d) : resolve(d))))].sort();
  const held: string[] = [];
  const release = () => { for (const p of held.splice(0)) try { unlinkSync(p); } catch {} process.off("exit", release); };
  process.on("exit", release);
  for (const d of dirs) {
    const p = join(d, "score-read.lock");
    try { writeFileSync(p, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n", { flag: "wx" }); held.push(p); }
    catch (e) {
      release();
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new Error(`${d} is being read by another reader (${p} exists; if no reader is running, delete it)`);
      if (code === "ENOENT") throw new Error(`${d}: no such run directory`);
      throw e;
    }
  }
  return release;
}

/** Marks the run's score as read. After this, no repair is allowed. The seal is created exclusively (never
 *  overwritten) and can carry the value that was read (`payload`), so a reader can refuse to print a different
 *  number for the same run later. Returns whether this call created the seal, and the seal as it now stands. */
export function sealRead(runDir: string, reader: string, payload?: Record<string, unknown>, file = "score-read.json"): { created: boolean; record: any } {
  const p = join(runDir, file);
  const record = { at: new Date().toISOString(), reader, ...(payload ? { read: payload } : {}) };
  try {
    writeFileSync(p, JSON.stringify(record, null, 1) + "\n", { flag: "wx" });
    try { chmodSync(p, 0o664); } catch {}
    return { created: true, record };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return { created: false, record: readJson(p) };
  }
}
