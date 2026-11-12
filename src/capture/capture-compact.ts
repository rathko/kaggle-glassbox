#!/usr/bin/env bun
// capture-compact: groups a capture dir's per-exchange snapshots (written by wire-tap.ts
// --capture-full) by TASK — defined as sharing an identical first user message, which is
// normally the task prompt — and writes one gzip JSONL per task
// (`task-<hash12>.jsonl.gz`, lines ordered by seq). VERIFIES the round-trip (gunzip, line
// count, seq set) before deleting any raw file, and writes a manifest.json mapping
// hash -> {exchanges, first/last seq, bytes raw/gz}. Readers (replay/step-replay.ts,
// replay/fork-run-steps.ts) load .jsonl.gz transparently via Bun.gunzipSync.
//
// A raw capture dir is one JSON file per model exchange, which is fine for a short debugging
// session but grows without bound across a real campaign. Compacting by task both shrinks it
// (JSON compresses very well) and gives every other instrument in this package a stable unit —
// "the captured trajectory of task X" — instead of an unordered pile of numbered files.
//
// usage: bun src/capture/capture-compact.ts <capture-dir> [--keep-raw] [--id-pattern <regex>] [--group-by <regex>] [--shared-perms]
//
// ATOMIC. It refuses, before writing or deleting anything, if any snapshot does not parse, any seq is not a positive
// whole number or repeats one already compacted, or an archive exists that manifest.json does not list. Archives are
// staged and verified, then renamed into place, then the merged manifest is written (tmp + rename), and only then
// are raw files deleted.
//
// INCREMENTAL. Run it again after more snapshots land (e.g. wire-tap --append) and it merges them in: a new task
// gets its own archive, and new exchanges for a task that already has one are merged with it (old and new lines
// together, seq order, verified, staged, then renamed over the old archive) and its manifest entry is updated.
//
// CHECKED EVERY TIME. Each listed archive is read and parsed (even when there is nothing new to compact): every line
// is a JSON object with a positive whole-number seq, unique across all archives, and its line count and first and
// last seq agree with manifest.json. Any disagreement exits non-zero before anything is written.
// Files are owner-only (0600) like wire-tap's; --shared-perms makes them group-writable (0664).
//
// GROUPING, in order: (1) the snapshot's task_id, which wire-tap records when the harness sends one in a
// request header (exact, recommended); (2) --group-by <regex>: the first capture group of the regex, matched
// against the serialised request messages; (3) otherwise the first user message. Use (1) or (2) when your
// tasks share one first instruction, or the task text lives in a system message or tool output.
//
// --id-pattern lets you recover a human-readable task-id guess from the prompt head (e.g. an
// instance id that always appears near the start of your task prompts). It is optional and has
// no default — without it, tasks are identified purely by their content hash, which is always
// correct even if no readable id can be guessed.
import { readdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync, statSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { strictArgs } from "../cli-args";
import { manifestArchives, readManifest, archiveName, checkCapture } from "./archives";

const argv = process.argv.slice(2);
const [dir] = strictArgs(argv, { valued: ["id-pattern", "group-by"], bool: ["keep-raw", "shared-perms"], positionals: [1, 1] },
  "usage: bun src/capture/capture-compact.ts <capture-dir> [--keep-raw] [--id-pattern <regex>] [--group-by <regex>] [--shared-perms]") as [string];
const keepRaw = argv.includes("--keep-raw");
const FILE_MODE = argv.includes("--shared-perms") ? 0o664 : 0o600;
const idPatternFlag = (() => { const i = argv.indexOf("--id-pattern"); return i >= 0 ? argv[i + 1] : undefined; })();
const idPattern = idPatternFlag ? new RegExp(idPatternFlag) : null;
const groupByFlag = (() => { const i = argv.indexOf("--group-by"); return i >= 0 ? argv[i + 1] : undefined; })();
const groupBy = groupByFlag ? new RegExp(groupByFlag) : null;
let ungroupable = 0;

// The existing manifest and archives are checked FIRST, even when there is nothing new to compact: a capture
// directory that is already inconsistent must not pass as "nothing to do" and then be sealed.
const manifestPath = join(dir, "manifest.json");
// Any .jsonl.gz the manifest does not list (whatever its name) is evidence from an interrupted or foreign compaction:
// every reader goes by the manifest and would never see it, so reconcile it by hand before anything else is merged
// in. A listed archive that is missing is the opposite hole: the manifest promises exchanges nobody can read.
let manifest: Record<string, any> = {};
try { manifest = readManifest(dir); manifestArchives(dir); }
catch (e) { console.error(`refusing: ${(e as Error).message}; nothing written or deleted`); process.exit(1); }

// Read every listed archive now: its lines are both the consistency check and, for a task that gets new exchanges,
// the old half of the merge.
// (the same check run-end applies before it records capture=ok: src/capture/archives.ts checkCapture)
const existingLines = new Map<string, { seq: number; line: string }[]>();
const seen = new Map<number, string>();
const checked = checkCapture(dir), archiveProblems = checked.problems;
for (const a of checked.archives) {
  existingLines.set(a.key, a.lines.map(({ seq, line }) => ({ seq, line })));
  for (const l of a.lines) seen.set(l.seq, a.name);
}
if (archiveProblems.length) {
  console.error(`refusing: the compacted capture is inconsistent (${archiveProblems.slice(0, 10).join("; ")}${archiveProblems.length > 10 ? "; ..." : ""}); nothing written or deleted`);
  process.exit(1);
}

const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "manifest.json" && f !== "task-index.json").sort();
if (!files.length) { console.log("nothing to compact (no raw .json snapshots; existing manifest and archives are consistent)"); process.exit(0); }

type Snap = { seq?: number; task_id?: string | null; request?: { messages?: { role: string; content: unknown }[] } };
// Parse EVERY snapshot before touching anything: a skipped malformed file would be missing from the manifest
// while the rest of the run looked complete, so one bad file aborts the whole compaction.
const parsed: { file: string; snap: Snap; raw: string }[] = [], unparseable: string[] = [];
for (const f of files) {
  const raw = readFileSync(join(dir, f), "utf8");
  try {
    const snap = JSON.parse(raw);
    if (!snap || typeof snap !== "object" || Array.isArray(snap)) throw new Error("not an object");
    parsed.push({ file: f, snap, raw });
  } catch { unparseable.push(f); }
}
if (unparseable.length) {
  console.error(`refusing: ${unparseable.length} snapshot(s) do not parse as a JSON object (${unparseable.slice(0, 10).join(", ")}${unparseable.length > 10 ? ", ..." : ""}); nothing written or deleted`);
  process.exit(1);
}

// Step order is the seq number: every seq must be a positive whole number, unique across this batch AND the
// archives already compacted, or a replay would order two exchanges arbitrarily.
const seqProblems: string[] = [];
for (const { file, snap } of parsed) {
  const q = snap.seq;
  if (typeof q !== "number" || !Number.isSafeInteger(q) || q < 1) seqProblems.push(`${file}: seq ${JSON.stringify(q)} is not a positive whole number`);
  else if (seen.has(q)) seqProblems.push(`${file}: seq ${q} already used by ${seen.get(q)}`);
  else seen.set(q, file);
}
if (seqProblems.length) {
  console.error(`refusing: ${seqProblems.length} snapshot(s) have a bad or duplicate seq (${seqProblems.slice(0, 10).join("; ")}${seqProblems.length > 10 ? "; ..." : ""}); nothing written or deleted`);
  process.exit(1);
}
const groups = new Map<string, { file: string; snap: Snap; raw: string }[]>();
for (const { file: f, snap, raw } of parsed) {
  let ident: string;
  if (snap.task_id) ident = `task:${snap.task_id}`;
  else if (groupBy) {
    const m = groupBy.exec(JSON.stringify(snap.request?.messages ?? []));
    if (!m) ungroupable++;
    ident = m ? `match:${m[1] ?? m[0]}` : `file:${f}`;
  } else {
    const firstUser = (snap.request?.messages ?? []).find((m) => m.role === "user");
    ident = JSON.stringify(firstUser?.content ?? f);
  }
  const key = createHash("sha256").update(ident).digest("hex").slice(0, 12);
  (groups.get(key) ?? groups.set(key, []).get(key)!).push({ file: f, snap, raw });
}

// STAGE every archive under a temporary name and verify it; only when all are good are they renamed into place,
// the merged manifest written atomically (tmp + rename), and then, last, the raw files deleted. An interruption
// at any point leaves either the raw files or a complete manifest, never an archive the manifest does not list.
let compacted = 0, merged = 0, deleted = 0, staleAttribution = 0;
const staged: { tmp: string; final: string }[] = [];
const abort = (msg: string) => { for (const st of staged) try { unlinkSync(st.tmp); } catch {} console.error(msg); process.exit(1); };
for (const [key, items] of groups) {
  items.sort((a, b) => (a.snap.seq ?? 0) - (b.snap.seq ?? 0));
  // an existing archive for this task: its lines join the new ones (seqs are already known to be disjoint)
  const old = existingLines.get(key) ?? [];
  const all = [...old.map((o) => ({ seq: o.seq, line: o.line })), ...items.map((i) => ({ seq: i.snap.seq as number, line: JSON.stringify(JSON.parse(i.raw)) }))]
    .sort((a, b) => a.seq - b.seq);
  const jsonl = all.map((x) => x.line).join("\n") + "\n";
  const finalPath = join(dir, `task-${key}.jsonl.gz`), gzPath = `${finalPath}.tmp`;
  writeFileSync(gzPath, Bun.gzipSync(Buffer.from(jsonl)), { mode: FILE_MODE });
  chmodSync(gzPath, FILE_MODE);
  staged.push({ tmp: gzPath, final: finalPath });
  // VERIFY the round-trip before any raw file dies: gunzip, line count, seq set.
  const back = Buffer.from(Bun.gunzipSync(readFileSync(gzPath))).toString("utf8");
  const lines = back.trim().split("\n");
  const seqsIn = all.map((x) => x.seq).join(",");
  const seqsOut = lines.map((l) => JSON.parse(l).seq ?? -1).join(",");
  if (lines.length !== all.length || seqsIn !== seqsOut)
    abort(`VERIFY FAILED for ${gzPath} (${lines.length}/${all.length} lines, seqs ${seqsOut} vs ${seqsIn}) — raw files kept, nothing written`);
  const newBytes = items.reduce((s, i) => s + Buffer.byteLength(i.raw, "utf8"), 0); // bytes on disk, not UTF-16 units
  if (old.length) {
    // merge: keep the entry's identity (first exchange, task id, prompt head), update the counts
    const prev = manifest[key];
    const next: Record<string, any> = { ...prev, exchanges: all.length, seq_first: all[0]!.seq, seq_last: all[all.length - 1]!.seq,
      raw_bytes: (prev.raw_bytes ?? 0) + newBytes, gz_bytes: statSync(gzPath).size };
    // Attribution covers only the exchanges it saw. A header-attributed archive (task_id on the entry and on every new
    // snapshot) stays exact, and a per-seq map is extended from those ids. Anything else written by capture-attribute
    // (instances, seq_tasks) no longer describes the archive, so it is dropped and marked stale: the new exchanges
    // would otherwise resolve to no task and silently vanish from every trajectory. Re-run capture-attribute.
    const exact = typeof prev.task_id === "string" && prev.task_id !== "" && items.every((i) => i.snap.task_id === prev.task_id);
    if (exact) {
      if (prev.seq_tasks && typeof prev.seq_tasks === "object") next.seq_tasks = { ...prev.seq_tasks, ...Object.fromEntries(items.map((i) => [String(i.snap.seq), prev.task_id])) };
    } else if (Array.isArray(prev.instances) || prev.seq_tasks || prev.attribution_stale) {
      delete next.instances; delete next.seq_tasks;
      next.attribution_stale = `${items.length} exchange(s) merged after capture-attribute ran; re-run capture-attribute`;
      staleAttribution++;
    }
    manifest[key] = next;
    merged++;
    continue;
  }
  const firstUser = (items[0].snap.request?.messages ?? []).find((m) => m.role === "user");
  const head = String(typeof firstUser?.content === "string" ? firstUser.content : JSON.stringify(firstUser?.content ?? "")).slice(0, 160);
  const idGuess = idPattern ? head.match(idPattern)?.[0] ?? null : null;
  manifest[key] = {
    exchanges: items.length,
    seq_first: items[0].snap.seq ?? null,
    seq_last: items[items.length - 1].snap.seq ?? null,
    instance_guess: idGuess,
    // with a harness-supplied task id the attribution is exact, so `instances` is filled here and
    // capture-attribute.ts (which matches against harness traces) is not needed
    ...(items[0].snap.task_id ? { task_id: items[0].snap.task_id, instances: [items[0].snap.task_id] } : {}),
    prompt_head: head,
    raw_bytes: newBytes,
    gz_bytes: statSync(gzPath).size,
  };
  compacted++;
}
for (const st of staged) renameSync(st.tmp, st.final);
const manifestTmp = `${manifestPath}.tmp`;
writeFileSync(manifestTmp, JSON.stringify(manifest, null, 1) + "\n", { mode: FILE_MODE });
chmodSync(manifestTmp, FILE_MODE);
renameSync(manifestTmp, manifestPath);
if (!keepRaw) for (const items of groups.values()) for (const i of items) { unlinkSync(join(dir, i.file)); deleted++; }
if (staleAttribution) console.error(`warning: ${staleAttribution} attributed capture group(s) gained exchanges; their attribution was dropped (attribution_stale): re-run capture-attribute before run-end`);
if (ungroupable) console.error(`warning: --group-by matched nothing in ${ungroupable} snapshot(s); each was kept as its own group`);
const totRaw = Object.values(manifest).reduce((s: number, m: any) => s + m.raw_bytes, 0);
const totGz = Object.values(manifest).reduce((s: number, m: any) => s + m.gz_bytes, 0);
console.log(`compacted ${compacted} new task(s)${merged ? ` and merged into ${merged} existing` : ""} from ${files.length} snapshots; raw ${(totRaw / 1e6).toFixed(1)}MB -> gz ${(totGz / 1e6).toFixed(1)}MB (${(totRaw / Math.max(totGz, 1)).toFixed(1)}x); raw files deleted: ${deleted}`);
