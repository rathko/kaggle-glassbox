// archives: which compacted archives a capture directory holds, going by manifest.json ONLY. capture-compact.ts
// writes one task-<key>.jsonl.gz per manifest key; every reader of compacted captures loads exactly those files
// through here, so an archive the manifest does not list (an interrupted compaction, a hand-copied file, a foreign
// "extra.jsonl.gz") can never slip extra exchanges into a replay or an analysis.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isSafeId } from "../safe-id";

export const archiveName = (key: string) => `task-${key}.jsonl.gz`;

/** manifest.json of a capture directory: {} when there is none. Throws when it does not parse as a JSON object. */
export function readManifest(captureDir: string): Record<string, any> {
  const p = join(captureDir, "manifest.json");
  if (!existsSync(p)) return {};
  let m: unknown;
  try { m = JSON.parse(readFileSync(p, "utf8")); } catch { throw new Error(`${p} does not parse`); }
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error(`${p} is not a JSON object`);
  return m as Record<string, any>;
}

/** Every archive the manifest lists, in key order. Throws if a key is not a safe file-name component, a listed archive
 *  is missing, or the directory holds any .jsonl.gz the manifest does not list (whatever its name). */
export function manifestArchives(captureDir: string): { key: string; name: string; path: string; entry: any }[] {
  const manifest = readManifest(captureDir);
  const keys = Object.keys(manifest).sort();
  const unsafe = keys.filter((k) => !isSafeId(k));
  if (unsafe.length) throw new Error(`manifest.json has ${unsafe.length} key(s) that are not safe archive names (${unsafe.slice(0, 5).map((k) => JSON.stringify(k)).join(", ")})`);
  const listed = new Set(keys.map(archiveName));
  const strays = existsSync(captureDir) ? readdirSync(captureDir).filter((f) => f.endsWith(".jsonl.gz") && !listed.has(f)).sort() : [];
  if (strays.length) throw new Error(`${strays.length} archive(s) are not in manifest.json (${strays.slice(0, 10).join(", ")})`);
  const missing = keys.filter((k) => !existsSync(join(captureDir, archiveName(k))));
  if (missing.length) throw new Error(`manifest.json lists ${missing.length} archive(s) that do not exist (${missing.slice(0, 10).map(archiveName).join(", ")})`);
  return keys.map((key) => ({ key, name: archiveName(key), path: join(captureDir, archiveName(key)), entry: manifest[key] }));
}

/** The archive of one manifest key (checked as above), for a reader that addresses a single capture group. */
export function manifestArchive(captureDir: string, key: string): string {
  const a = manifestArchives(captureDir).find((x) => x.key === key);
  if (!a) throw new Error(`${captureDir}: manifest.json does not list capture group ${JSON.stringify(key)}`);
  return a.path;
}

export type ArchiveLine = { seq: number; line: string; snap: Record<string, any> };
type Archive = { key: string; name: string; path: string; entry: any };

/** Parse one archive and check it against its manifest entry: every line a JSON object with a positive whole-number
 *  seq, seqs unique (across archives too, when the caller passes a shared `seen`), the line count equal to
 *  `exchanges`, and the first and last seq equal to `seq_first` / `seq_last`. Never throws; returns the problems. */
export function checkArchive(a: Archive, seen: Map<number, string> = new Map()): { lines: ArchiveLine[]; problems: string[] } {
  const problems: string[] = [], lines: ArchiveLine[] = [];
  let text: string;
  try { text = Buffer.from(Bun.gunzipSync(readFileSync(a.path))).toString("utf8"); }
  catch (e) { return { lines, problems: [`${a.name}: does not gunzip (${String(e).slice(0, 80)})`] }; }
  text.split("\n").forEach((l, i) => {
    if (!l) return;
    let o: any;
    try { o = JSON.parse(l); } catch { problems.push(`${a.name} line ${i + 1}: not JSON`); return; }
    if (!o || typeof o !== "object" || Array.isArray(o)) { problems.push(`${a.name} line ${i + 1}: not an object`); return; }
    const q = o.seq;
    if (typeof q !== "number" || !Number.isSafeInteger(q) || q < 1) { problems.push(`${a.name} line ${i + 1}: seq ${JSON.stringify(q)} is not a positive whole number`); return; }
    if (seen.has(q)) { problems.push(`${a.name} line ${i + 1}: seq ${q} also in ${seen.get(q)}`); return; }
    seen.set(q, a.name);
    lines.push({ seq: q, line: l, snap: o });
  });
  const m = a.entry ?? {};
  const qs = lines.map((x) => x.seq);
  if (m.exchanges !== lines.length) problems.push(`${a.name}: ${lines.length} line(s), manifest says ${m.exchanges}`);
  if (lines.length && (m.seq_first !== Math.min(...qs) || m.seq_last !== Math.max(...qs)))
    problems.push(`${a.name}: seqs ${Math.min(...qs)}-${Math.max(...qs)}, manifest says ${m.seq_first}-${m.seq_last}`);
  return { lines, problems };
}

/** Every listed archive, parsed and checked (manifestArchives + checkArchive, seqs unique across the directory).
 *  Never throws; `problems` empty means the compacted capture is consistent. */
export function checkCapture(captureDir: string): { archives: (Archive & { lines: ArchiveLine[] })[]; problems: string[] } {
  let listed: Archive[];
  try { listed = manifestArchives(captureDir); } catch (e) { return { archives: [], problems: [(e as Error).message] }; }
  const seen = new Map<number, string>(), problems: string[] = [];
  const archives = listed.map((a) => { const c = checkArchive(a, seen); problems.push(...c.problems); return { ...a, lines: c.lines }; });
  return { archives, problems };
}

/** The snapshots of one archive, in file order, for a reader: throws if the archive disagrees with its manifest
 *  entry (a truncated or padded archive would otherwise replay as a shorter or longer trajectory). */
export function readArchiveSnaps(a: Archive): Record<string, any>[] {
  const c = checkArchive(a);
  if (c.problems.length) throw new Error(`capture archive inconsistent with manifest.json: ${c.problems.slice(0, 5).join("; ")}`);
  return c.lines.map((x) => x.snap);
}

/** Snapshots of the archive of one manifest key (checked as readArchiveSnaps). */
export function readManifestArchive(captureDir: string, key: string): Record<string, any>[] {
  const a = manifestArchives(captureDir).find((x) => x.key === key);
  if (!a) throw new Error(`${captureDir}: manifest.json does not list capture group ${JSON.stringify(key)}`);
  return readArchiveSnaps(a);
}

/** The task one snapshot belongs to: the task id the harness sent with it, else the per-seq attribution capture-attribute
 *  wrote (`seq_tasks`), else the archive's single task (`instances` of length one, or `task_id`). null when the archive
 *  spans several tasks and nothing says which one this snapshot is (an attribution written before `seq_tasks`). */
export function snapTask(entry: any, snap: Record<string, any>): string | null {
  if (typeof snap.task_id === "string" && snap.task_id) return snap.task_id;
  const e = entry ?? {};
  const bySeq = e.seq_tasks && typeof e.seq_tasks === "object" ? e.seq_tasks[String(snap.seq)] : undefined;
  if (typeof bySeq === "string" && bySeq) return bySeq;
  if (e.seq_tasks && typeof e.seq_tasks === "object") return null; // per-seq attribution exists and leaves this one out
  if (Array.isArray(e.instances) && e.instances.length === 1) return String(e.instances[0]);
  if (!Array.isArray(e.instances) && typeof e.task_id === "string" && e.task_id) return e.task_id;
  return null;
}

/** Every snapshot attributed to `task` across the listed archives (each checked as readArchiveSnaps), in seq order: a
 *  task's trajectory is exactly its own exchanges, even when an archive (one prompt head) also holds another task's.
 *  Throws when an archive lists the task among several `instances` with no per-seq attribution, since its exchanges
 *  cannot then be told apart (re-run capture-attribute). */
export function taskSnaps(archives: Archive[], task: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const a of archives) {
    const e = a.entry ?? {};
    // an archive whose attribution does not name the task holds none of its exchanges: skip it unread
    if (Array.isArray(e.instances) && !e.instances.map(String).includes(task)) continue;
    const multi = Array.isArray(e.instances) && e.instances.length > 1;
    if (multi && !(e.seq_tasks && typeof e.seq_tasks === "object") && e.instances.map(String).includes(task))
      throw new Error(`${a.name} holds exchanges of ${e.instances.length} tasks with no per-seq attribution (seq_tasks); re-run capture-attribute to separate task ${task}`);
    for (const s of readArchiveSnaps(a)) if (snapTask(e, s) === task) out.push(s);
  }
  return out.sort((x, y) => x.seq - y.seq);
}
