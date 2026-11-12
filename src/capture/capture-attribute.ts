#!/usr/bin/env bun
// capture-attribute: maps every captured snapshot group (wire-tap.ts --capture-full, compacted by
// capture-compact.ts) to the task that produced it.
//
// This matters because a wire-tap capture has no idea which task was running when a given model
// exchange happened — it only sees prompt text. If your harness runs tasks concurrently, you
// cannot even use "whichever task was active at that timestamp" as a fallback.
//
// EXACT FIRST. A snapshot that carries the harness's own task id (wire-tap --task-header; capture-compact copies it
// into the manifest) is attributed to that task, full stop. Everything below only fills in snapshots without one.
//
// PRIMARY METHOD = CONTENT. Each captured response's tool calls (name + exact arguments) are
// matched against the per-task traces your harness already produces (described by --adapter, below); each SNAPSHOT is assigned
// to the task with the most matching calls; a tie for the most leaves it unassigned. Snapshots with no tool calls (e.g. a
// compaction/summary call) are matched by the agent text they summarise instead. Under
// concurrency, an unmatched snapshot stays unassigned rather than being guessed. This works for
// any concurrency level.
//
// CROSS-CHECK = TIME WINDOW, valid only for SERIAL runs: when tasks ran one after another, each owns the window
// (previous task's end, its own end], where an end is its done marker's mtime (adapter "done_marker"), and a snapshot is
// placed by its request-arrival time (req_at, else at). The windows never overlap, and a snapshot after the last end
// belongs to no task. With start markers too (adapter "start_marker"), a task owns [start, end + 5 s] cut at the next
// task's start, and a snapshot before the first start or between tasks belongs to none. If the run was serial (concurrency 1 or
// unspecified), content assignments must agree with the time-window assignment on >= 95% of
// snapshots, or the tool refuses — a serial run where content and time disagree usually means the
// trace format assumption below is wrong, not that the task boundaries moved.
//
// SELF-CHECK (when the adapter names a "calls_field"): per task, the number of tool-bearing captured requests
// attributed to it must be within ±2 of that task's own reported model-call count on >= 90% of tasks, or the tool
// refuses.
//
// COVERAGE: every task that reports a model-call count > 0 must get at least one snapshot (a task with calls and
// no capture is a lost trajectory, which ±2 alone forgives for small tasks), and at least --min-coverage of all
// snapshots (default 1.0) must be assigned. Lower it, e.g. --min-coverage 0.95, only for a concurrent run whose
// unmatched summary calls you have looked at; the share actually assigned is always printed.
//
// Writes <capture-dir>/task-index.json (task id -> capture group keys) and adds an `instances`
// field to each group's entry in manifest.json, plus a `seq_tasks` map (seq -> task id) whenever a group is not
// wholly one task's, so every reader takes a task's trajectory from its own exchanges only.
//
// YOUR HARNESS'S LAYOUT is described by an adapter file (--adapter <json>), because every harness writes its own
// traces. With no adapter only the README run layout is assumed (task_results.jsonl rows keyed by instance_id), so
// only snapshots that carry a harness task id can be attributed. examples/attribution-adapter.json is a worked
// example; its keys, all optional:
//   rows          results file, relative to <results-dir> (default "task_results.jsonl")
//   task_field    task id field in a row (default "instance_id")
//   calls_field   field with the task's own count of model calls (enables the self-check and the lost-task check)
//   calls_count   what calls_field counts: "exchanges" (default, every attributed model exchange) or "tool_turns"
//                 (only requests that offer tools, for a harness that counts agent turns that way)
//   prompt_field  field (dotted path) of a row holding the task's own prompt or question; a snapshot whose request
//                 messages contain it verbatim (whitespace-normalised) is that task's, the strongest content evidence
//                 after a harness task id. This attributes a tool-free, one-exchange agent (QA, math) at any
//                 concurrency, where time windows cannot help
//   trace         per-task trace path template with {id}, relative to <results-dir>, e.g. "traces/{id}.json"
//                 ({id} is the task id when it is a safe file name, else a slug plus a short hash; see safe-id.ts)
//   trace_steps   field (dotted path) of the step array in a trace (default "steps")
//   step_calls    field of a step's tool-call array (default "tool_calls")
//   call_name     field of a call's tool name (default "name"); call_args: its arguments (default "arguments")
//   step_text     field of a step's text (default "text"); step_role / agent_role: only steps whose step_role field
//                 equals agent_role index their text (defaults "role" / "assistant")
//   done_marker   per-task file template with {id} whose mtime marks when the task finished (serial cross-check)
//   start_marker  optional per-task file template with {id} whose mtime marks when the task started (bounds the
//                 windows on both sides and allows a 5 s grace after a task's end)
//   concurrency   how many tasks ran at once (default 1; --concurrency overrides)
//
// usage: bun src/capture/capture-attribute.ts <results-dir> <capture-dir> [--adapter adapter.json] [--concurrency N]
//          [--min-coverage 1.0] [--shared-perms]
// (manifest.json and task-index.json are written owner-only, 0600; --shared-perms makes them 0664)
import { readdirSync, readFileSync, writeFileSync, statSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { strictArgs } from "../cli-args";
import { safeId, within } from "../safe-id";
import { manifestArchives, readManifest, readArchiveSnaps } from "./archives";

const USAGE = "usage: bun src/capture/capture-attribute.ts <results-dir> <capture-dir> [--adapter adapter.json] [--concurrency N] [--min-coverage 1.0] [--shared-perms]";
const argv = process.argv.slice(2);
strictArgs(argv, { valued: ["adapter", "concurrency", "min-coverage"], bool: ["shared-perms"], positionals: [2, 2] }, USAGE);
const VALUED = new Set(["--min-coverage", "--adapter", "--concurrency"]);
const flagOf = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const MIN_COVERAGE = flagOf("min-coverage") !== undefined ? Number(flagOf("min-coverage")) : 1;
const [RES, CAP] = argv.filter((x, i) => !x.startsWith("--") && !VALUED.has(argv[i - 1] ?? ""));
const FILE_MODE = argv.includes("--shared-perms") ? 0o664 : 0o600;
if (!RES || !CAP) { console.error(USAGE); process.exit(2); }
if (!(MIN_COVERAGE >= 0 && MIN_COVERAGE <= 1)) { console.error(`--min-coverage must be in [0, 1]\n${USAGE}`); process.exit(2); }
type Adapter = { rows?: string; task_field?: string; calls_field?: string; calls_count?: string; prompt_field?: string; trace?: string; trace_steps?: string; step_calls?: string;
  call_name?: string; call_args?: string; step_text?: string; step_role?: string; agent_role?: string; done_marker?: string; start_marker?: string; concurrency?: number };
let AD: Adapter = {};
if (flagOf("adapter")) {
  try { AD = JSON.parse(readFileSync(flagOf("adapter")!, "utf8")); } catch (e) { console.error(`--adapter: ${(e as Error).message}`); process.exit(2); }
  const known = ["rows", "task_field", "calls_field", "calls_count", "prompt_field", "trace", "trace_steps", "step_calls", "call_name", "call_args", "step_text", "step_role", "agent_role", "done_marker", "start_marker", "concurrency"];
  const unknown = Object.keys(AD).filter((k) => !known.includes(k) && !k.startsWith("_"));
  if (unknown.length) { console.error(`--adapter: unknown key(s) ${unknown.join(", ")}`); process.exit(2); }
  if (AD.calls_count !== undefined && AD.calls_count !== "exchanges" && AD.calls_count !== "tool_turns") { console.error(`--adapter: "calls_count" must be "exchanges" or "tool_turns"`); process.exit(2); }
  for (const k of ["trace", "done_marker", "start_marker"] as const) if (AD[k] !== undefined && !String(AD[k]).includes("{id}")) { console.error(`--adapter: "${k}" must contain {id}`); process.exit(2); }
  for (const k of ["trace", "done_marker", "start_marker"] as const) if (AD[k] !== undefined) {
    try { within(RES, String(AD[k]).split("{id}").join("x")); } catch { console.error(`--adapter: "${k}" must stay inside <results-dir>`); process.exit(2); }
  }
}
const get = (o: any, path: string): any => path.split(".").reduce((v, k) => (v == null ? undefined : v[k]), o);
// {id} becomes one safe path component (safe-id.ts): a tame id is used as is, an id such as "a/b" or "../x" becomes
// a slug plus a short hash, and the resolved path must stay inside <results-dir> or the path is refused
const at = (tpl: string, id: string) => within(RES, tpl.split("{id}").join(safeId(id)));

const stable = (v: any): string => v && typeof v === "object"
  ? Array.isArray(v) ? `[${v.map(stable).join(",")}]` : `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",")}}`
  : JSON.stringify(v);
const parseArgs = (a: any) => { if (typeof a !== "string") return a ?? {}; try { return JSON.parse(a); } catch { return a; } };
const callKey = (name: string, args: any) => `${name}|${stable(parseArgs(args))}`;
const textKey = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 80);

const TASK_FIELD = AD.task_field ?? "instance_id";
const rowsAll = readFileSync(join(RES, AD.rows ?? "task_results.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const taskIds = rowsAll.map((j) => j[TASK_FIELD]).filter((x) => typeof x === "string" || typeof x === "number").map(String);
const taskIdSet = new Set(taskIds);
// task id -> its own model-call count; empty when the adapter names no calls_field (self-check and lost check off)
// Every row's count must be a whole number >= 0: a missing count read as 0 would hide a lost task, and a NaN would
// fail the self-check for one task while 90% of the others still pass it.
if (AD.calls_field) {
  const bad = rowsAll.map((j, i) => [i + 1, j[TASK_FIELD], get(j, AD.calls_field!)] as const)
    .filter(([, , v]) => !(typeof v === "number" && Number.isSafeInteger(v) && v >= 0));
  if (bad.length) {
    console.error(`--adapter calls_field "${AD.calls_field}": ${bad.length} row(s) without a whole-number count >= 0: ${bad.slice(0, 5).map(([n, id, v]) => `row ${n} (${id}): ${JSON.stringify(v)}`).join(", ")}${bad.length > 5 ? ", ..." : ""}`);
    process.exit(2);
  }
}
const reported = new Map<string, number>(AD.calls_field ? rowsAll.map((j) => [String(j[TASK_FIELD]), get(j, AD.calls_field!) as number] as const) : []);

// Content index from traces: tool-call keys and agent-text keys -> task ids.
const callIdx = new Map<string, Set<string>>(), textIdx = new Map<string, Set<string>>();
const add = (m: Map<string, Set<string>>, k: string, id: string) => { if (!m.has(k)) m.set(k, new Set()); m.get(k)!.add(id); };
if (AD.trace) for (const id of taskIds) {
  const f = at(AD.trace, id);
  if (!existsSync(f)) continue;
  const steps = get(JSON.parse(readFileSync(f, "utf8")), AD.trace_steps ?? "steps");
  for (const st of Array.isArray(steps) ? steps : []) {
    for (const c of get(st, AD.step_calls ?? "tool_calls") ?? []) add(callIdx, callKey(get(c, AD.call_name ?? "name"), get(c, AD.call_args ?? "arguments")), id);
    const text = get(st, AD.step_text ?? "text");
    if (get(st, AD.step_role ?? "role") === (AD.agent_role ?? "assistant") && typeof text === "string" && text.trim().length >= 40) add(textIdx, textKey(text), id);
  }
}

// Prompt index: each task's own prompt (adapter prompt_field), whitespace-normalised. Matched as a substring of the
// request's message text, longest match winning, so a task whose prompt extends another's is not mistaken for it.
// Any non-empty prompt counts. A short one (under SHORT_PROMPT characters, e.g. "2+2?") could also occur by chance
// inside shared text such as a system prompt, so it must instead end a user message, after a non-alphanumeric
// character or as the whole message ("Question: 2+2?").
const norm = (t: string) => t.replace(/\s+/g, " ").trim();
const msgText = (msgs: any[]): string => norm((Array.isArray(msgs) ? msgs : []).map((m) => typeof m?.content === "string" ? m.content
  : Array.isArray(m?.content) ? m.content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join(" ") : "").join(" \n "));
const promptIdx = new Map<string, Set<string>>();
if (AD.prompt_field) for (const r of rowsAll) {
  const t = get(r, AD.prompt_field), id = r[TASK_FIELD];
  if (typeof t === "string" && norm(t).length > 0 && (typeof id === "string" || typeof id === "number")) add(promptIdx, norm(t), String(id));
}
const promptsByLength = [...promptIdx.keys()].sort((a, b) => b.length - a.length);
// tasks whose prompt is the longest one contained in the request text (empty when none, or when the longest match is shared)
const SHORT_PROMPT = 8;
const userTexts = (msgs: any[]): string[] => (Array.isArray(msgs) ? msgs : []).filter((m) => m?.role === "user").map((m) => msgText([m]));
const endsUserMessage = (p: string, users: string[]) => users.some((u) => u === p || (u.endsWith(p) && !/[\p{L}\p{N}]/u.test(u[u.length - p.length - 1]!)));
function promptOwner(msgs: any[]): Set<string> | undefined {
  const text = msgText(msgs), users = userTexts(msgs);
  for (const p of promptsByLength) if (p.length >= SHORT_PROMPT ? text.includes(p) : endsUserMessage(p, users)) return promptIdx.get(p);
  return undefined;
}
const countsAsCall = (s: any) => (AD.calls_count ?? "exchanges") === "exchanges" || (Array.isArray(s.request?.tools) && s.request.tools.length > 0);

// Time-window index (serial cross-check).
const mtime = (tpl: string | undefined, id: string) => (tpl && existsSync(at(tpl, id)) ? statSync(at(tpl, id)).mtimeMs : null);
const tasks = AD.done_marker
  ? taskIds.filter((id) => mtime(AD.done_marker, id) !== null).map((id) => ({ id, end: mtime(AD.done_marker, id)!, start: mtime(AD.start_marker, id) })).sort((a, b) => a.end - b.end)
  : [];
const withStarts = tasks.length > 0 && tasks.every((t) => t.start !== null);
function windowOwner(ts: number, ts_tasks: { id: string; end: number; start: number | null }[], starts: boolean): string | null {
  for (let i = 0; i < ts_tasks.length; i++) {
    const t = ts_tasks[i]!, next = ts_tasks[i + 1];
    if (starts) { if (ts >= t.start! && ts <= t.end + 5000 && (next === undefined || ts < next.start!)) return t.id; }
    else if (ts > (i === 0 ? -Infinity : ts_tasks[i - 1]!.end) && ts <= t.end) return t.id;
  }
  return null; // before the first start, between tasks, or after the last end: no task owns it
}
const taskAt = (ts: number) => windowOwner(ts, tasks, withStarts);
const concurrency = Number(flagOf("concurrency") ?? AD.concurrency ?? 1);
if (!Number.isSafeInteger(concurrency) || concurrency < 1) { console.error(`--concurrency must be a whole number >= 1\n${USAGE}`); process.exit(2); }

const manifestPath = join(CAP, "manifest.json");
// only the archives manifest.json lists are attributed; an unlisted .jsonl.gz is refused, not silently included
let archives: ReturnType<typeof manifestArchives>, manifest: Record<string, any>;
try { manifest = readManifest(CAP); archives = manifestArchives(CAP); } catch (e) { console.error(`${CAP}: ${(e as Error).message}`); process.exit(1); }
const perTask = new Map<string, number>();
const idx: Record<string, string[]> = {};
// exact ids the harness sent that name no task in the result rows (a typo or a stale header): authoritative ids are
// only trusted when they point at a real task, otherwise that task silently loses its capture
const unknownExact = new Map<string, number>();
let groups = 0, snapsN = 0, exact = 0, contentAssigned = 0, timeOnly = 0, agree = 0, compared = 0, unassigned = 0, ambiguous = 0;
for (const a of archives) {
  const { key } = a;
  let snaps: any[];
  try { snaps = readArchiveSnaps(a); } catch (e) { console.error(`${CAP}: ${(e as Error).message}`); process.exit(1); }
  groups++;
  const ids = new Set<string>();
  // seq -> task for every snapshot this archive attributes; an archive can hold several tasks' exchanges (one prompt
  // head shared by sub-agent calls), and readers take a task's trajectory from this map, never the whole archive
  const seqTasks: Record<string, string> = {};
  let unassignedHere = 0;
  // Per SNAPSHOT, not per group: a group (one prompt head) can span tasks, e.g. sub-agent calls
  // that all start with the same request text.
  for (const s of snaps) {
    snapsN++;
    // A task id the harness sent (wire-tap records it per snapshot; capture-compact copies it into the manifest) is
    // the attribution, exactly. The trace/time heuristics below only ever fill in snapshots that have none.
    const known = (typeof s.task_id === "string" && s.task_id) || (typeof manifest[key]?.task_id === "string" && manifest[key].task_id) || null;
    if (known) {
      if (taskIdSet.size && !taskIdSet.has(known)) unknownExact.set(known, (unknownExact.get(known) ?? 0) + 1);
      exact++;
      ids.add(known);
      seqTasks[String(s.seq)] = known;
      if (countsAsCall(s)) perTask.set(known, (perTask.get(known) ?? 0) + 1);
      continue;
    }
    const votes = new Map<string, number>();
    const vote = (set: Set<string> | undefined, w = 1) => { if (set && set.size === 1) { const [id] = set; votes.set(id, (votes.get(id) ?? 0) + w); } };
    for (const c of s.response?.choices?.[0]?.message?.tool_calls ?? []) vote(callIdx.get(callKey(c.function?.name, c.function?.arguments)), 2);
    for (const m of s.request?.messages ?? []) for (const c of m.tool_calls ?? []) vote(callIdx.get(callKey(c.function?.name, c.function?.arguments)));
    if (promptIdx.size) vote(promptOwner(s.request?.messages), 3);
    if (!votes.size) {
      const body = JSON.stringify(s.request?.messages ?? []).replace(/\\n/g, " ").replace(/\s+/g, " ");
      for (const [k, set] of textIdx) if (body.includes(k)) vote(set);
      // the answer this exchange produced, against the agent text the traces recorded (a text-only agent's only trace)
      const said = s.response?.choices?.[0]?.message?.content;
      if (typeof said === "string" && said.trim().length >= 40) vote(textIdx.get(textKey(said)), 2);
    }
    const ts = Date.parse(s.req_at ?? s.at);
    const byTime = concurrency === 1 && !Number.isNaN(ts) && tasks.length ? taskAt(ts) : null;
    const ranked = [...votes].sort((a, b) => b[1] - a[1]);
    // a tie between two tasks is not evidence for either: leave the snapshot unassigned (coverage then fails loudly)
    if (ranked.length > 1 && ranked[0]![1] === ranked[1]![1]) { ambiguous++; unassigned++; unassignedHere++; continue; }
    let id: string | null = ranked[0]?.[0] ?? null;
    if (id) { contentAssigned++; if (byTime) { compared++; if (byTime === id) agree++; } }
    else if (byTime) { id = byTime; timeOnly++; }
    if (!id) { unassigned++; unassignedHere++; continue; }
    ids.add(id);
    seqTasks[String(s.seq)] = id;
    if (countsAsCall(s)) perTask.set(id, (perTask.get(id) ?? 0) + 1);
  }
  for (const id of ids) (idx[id] ??= []).push(key);
  if (manifest[key]) {
    manifest[key].instances = [...ids];
    delete manifest[key].attribution_stale; // this attribution saw every exchange the archive now holds
    // the per-seq map is written whenever the archive is not wholly one task's (several tasks, or some snapshots left
    // unassigned); a stale map from an earlier attribution is dropped otherwise
    if (ids.size > 1 || (unassignedHere && ids.size)) manifest[key].seq_tasks = seqTasks;
    else delete manifest[key].seq_tasks;
  }
}
let within2 = 0;
for (const [id, rep] of reported) if (Math.abs((perTask.get(id) ?? 0) - rep) <= 2) within2++;
const selfOk = reported.size === 0 || within2 >= reported.size * 0.9;
const lost = [...reported].filter(([id, rep]) => Number(rep) > 0 && !idx[id]).map(([id]) => id);
const coverage = snapsN ? (snapsN - unassigned) / snapsN : 1;
const coverOk = !lost.length && coverage >= MIN_COVERAGE;
const crossOk = concurrency !== 1 || compared === 0 || agree >= compared * 0.95;
console.log(`attribution (content-primary, concurrency ${concurrency}): ${groups} groups, ${snapsN} snapshots: ${exact} by harness task id, ${contentAssigned} by content, ${timeOnly} by time only, ${unassigned} unassigned (${ambiguous} tied); serial cross-check ${agree}/${compared} agree -> ${crossOk ? "OK" : "FAILED"}`);
console.log(AD.calls_field ? `attribution: ${within2}/${reported.size} tasks within +/-2 of reported model calls -> ${selfOk ? "OK" : "FAILED"}` : "attribution: no calls_field in the adapter, so the per-task call-count self-check and the lost-task check are off");
console.log(`attribution: ${((coverage) * 100).toFixed(1)}% of snapshots assigned (minimum ${(MIN_COVERAGE * 100).toFixed(1)}%); ${lost.length} task(s) reporting model calls have no snapshot${lost.length ? ` (${lost.slice(0, 10).join(", ")}${lost.length > 10 ? ", ..." : ""})` : ""} -> ${coverOk ? "OK" : "FAILED"}`);
if (unknownExact.size) {
  const list = [...unknownExact].slice(0, 10).map(([id, n]) => `${id} (${n} snapshot${n === 1 ? "" : "s"})`).join(", ");
  console.error(`attribution: ${unknownExact.size} harness task id(s) name no task in the result rows: ${list}${unknownExact.size > 10 ? ", ..." : ""} -> FAILED (nothing written; fix the x-task-id the harness sends or the --task-field)`);
}
if (!selfOk || !crossOk || !coverOk || unknownExact.size) process.exit(1);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + "\n");
writeFileSync(join(CAP, "task-index.json"), JSON.stringify(idx, null, 1) + "\n");
for (const p of [manifestPath, join(CAP, "task-index.json")]) { try { chmodSync(p, FILE_MODE); } catch {} }
