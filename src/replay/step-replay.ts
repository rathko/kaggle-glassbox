#!/usr/bin/env bun
// step-replay: the precision optimiser over FULL step snapshots.
//
// WHY: once wire-tap.ts has captured a full input for every model exchange, you can keep
// re-sending ONE step with surgical mutations (a different system prompt, dropped tools, a
// trimmed message history, a different sampling parameter) and see what changes — without
// re-running the whole task, and without touching a scored run at all. This is the cheapest
// possible screen for "would this prompt/parameter change help here?" before you spend a real
// task-level or full-slate run on it. Grading a whole task stays with your own harness; this
// tool measures the STEP: did the next tool call change, and how.
//
// Select:
//   --dir <capture dir>            required
//   --seq 12,40-60                 snapshot sequence filter
//   --grep <regex>                 keep snapshots whose request text matches
//   --last-per-conversation        keep only the final step of each message-prefix chain
//   --limit N
// Mutate (all optional, applied in this order):
//   --system-file <path>           replace the first system message's text; a request with no system message
//                                  gets one inserted at the front (logged as system_inserted), so a candidate prompt
//                                  is never silently skipped on a user-only trajectory
//   --set '<json>'                 merge keys into the request body (sampling etc.)
//   --drop-tools a,b               remove named tools from the tools array
//   --messages-head N              keep only the first N messages
//   --append-user <text>           append one user message
// Run:
//   --base http://127.0.0.1:8010   model server (default; override for your own setup)
//   --out <jsonl>                  required
//   --repeat N                     send each mutated snapshot N times (default 1)
//   --compare auto|tool|content    what counts as a change (default auto), over EVERY choice by index (a different
//                                  number of choices is a change): "tool" compares the sequence of tool-call
//                                  names; "content" compares the normalised text and the tool calls with their
//                                  arguments; "auto" compares the full tool-call sequence WITH arguments when
//                                  either side made a tool call (so submit_answer({"answer":"4"}) vs "5" is a
//                                  change), and the normalised text when neither did. Arguments that parse as JSON
//                                  are compared canonically (key order and spacing do not count).
//   --append                       add to an existing --out file; without it an existing file is refused, so a
//                                  second candidate never mixes into the first one's results. Every row records
//                                  the mutation it ran (config) and its sha256 (config_sha256), so rows from
//                                  different candidates in one file can always be told apart.
//
// Never run this against a server that a timed/scored evaluation currently owns — it competes
// for the same decode budget.
import { readFileSync, readdirSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { postChat } from "./endpoint";
import { assertValidCaptures } from "./capture-valid";
import { countFlag } from "./cli-num";
import { strictArgs } from "../cli-args";
import { manifestArchives, readArchiveSnaps } from "../capture/archives";
import { join, dirname } from "node:path";

const argv = process.argv.slice(2);
const USAGE = "usage: bun src/replay/step-replay.ts --dir <capture dir> --out <jsonl> [--seq S] [--grep RE] [--last-per-conversation] [--limit N]\n  [--system-file F] [--set JSON] [--drop-tools a,b] [--messages-head N] [--append-user TEXT] [--base URL] [--repeat N] [--compare auto|tool|content] [--append]";
// a misspelt mutation flag would otherwise replay an unchanged control while looking like an intervention
strictArgs(argv, {
  valued: ["dir", "out", "seq", "grep", "limit", "system-file", "set", "drop-tools", "messages-head", "append-user", "base", "repeat", "compare"],
  bool: ["last-per-conversation", "append"],
}, USAGE);
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n: string) => argv.includes(`--${n}`);
const DIR = flag("dir"); const OUT = flag("out");
if (!DIR || !OUT) { console.error(USAGE); process.exit(2); }
const BASE = flag("base") ?? "http://127.0.0.1:8010";
const REPEAT = countFlag("repeat", flag("repeat"), 1);
const LIMIT = countFlag("limit", flag("limit"), Infinity);
const MESSAGES_HEAD = countFlag("messages-head", flag("messages-head"), Infinity);
const COMPARE = flag("compare") ?? "auto";
if (!["auto", "tool", "content"].includes(COMPARE)) { console.error("--compare must be auto, tool or content"); process.exit(2); }
// an existing output file would silently mix this candidate's rows into another's
if (existsSync(OUT) && !has("append")) { console.error(`${OUT} already exists; pick a new --out, or pass --append to add to it (every row records its config_sha256)`); process.exit(2); }
let SET: Record<string, unknown> | null = null;
if (flag("set") !== undefined) {
  try { SET = JSON.parse(flag("set")!); } catch { console.error(`--set must be a JSON object, got ${flag("set")}`); process.exit(2); }
  if (!SET || typeof SET !== "object" || Array.isArray(SET)) { console.error(`--set must be a JSON object, got ${flag("set")}`); process.exit(2); }
}
const SYSTEM_TEXT = flag("system-file") !== undefined ? readFileSync(flag("system-file")!, "utf8") : null;
/** Canonical JSON: object keys sorted at every depth, so two equal values always print the same. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x);
// What this invocation changes, recorded on every row: the system text by content hash (a path can be edited between
// runs), and every other mutation as given.
const CONFIG = {
  system_sha256: SYSTEM_TEXT === null ? null : createHash("sha256").update(SYSTEM_TEXT).digest("hex"),
  set: SET, drop_tools: flag("drop-tools") ?? null, messages_head: Number.isFinite(MESSAGES_HEAD) ? MESSAGES_HEAD : null,
  append_user: flag("append-user") ?? null, compare: COMPARE,
};
const CONFIG_SHA = createHash("sha256").update(canon(CONFIG)).digest("hex");

/** Parse --seq strictly: comma-separated positive whole numbers or ranges a-b with a <= b, none overlapping another.
 *  Anything else (blank parts, "5-3", "0", "1.5", "7,7", "1-5,3") is a usage error, not a silently empty filter. */
function parseSeqSpec(spec: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const part of spec.split(",").map((x) => x.trim())) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`--seq: "${part}" is not a positive whole number or a range a-b`);
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1) throw new Error(`--seq: "${part}" is out of range (positive whole numbers only)`);
    if (a > b) throw new Error(`--seq: range "${part}" runs backwards`);
    const clash = ranges.find(([x, y]) => a <= y && x <= b);
    if (clash) throw new Error(`--seq: "${part}" repeats or overlaps ${clash[0] === clash[1] ? clash[0] : `${clash[0]}-${clash[1]}`}`);
    ranges.push([a, b]);
  }
  return ranges;
}
let seqRanges: [number, number][] | null = null;
if (flag("seq") !== undefined) {
  try { seqRanges = parseSeqSpec(flag("seq")!); } catch (e) { console.error((e as Error).message); console.error(USAGE); process.exit(2); }
}
const seqOk = seqRanges && ((n: number) => seqRanges!.some(([a, b]) => n >= a && n <= b));
const grepRe = flag("grep") ? new RegExp(flag("grep")!, "i") : null;

// Raw per-exchange .json files AND compacted per-task .jsonl.gz (capture-compact.ts) load
// interchangeably — decompression happens in memory, on the fly.
// Each archive is one complete trajectory; the raw snapshots still in the directory are another. A trajectory is
// validated WHOLE before any selector runs (capture-valid.ts), so a --seq that happens to dodge a bad exchange
// cannot replay a step whose surroundings were broken, and nothing is silently dropped.
const trajectories = new Map<string, any[]>();
trajectories.set("raw snapshots", readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "manifest.json" && f !== "task-index.json").sort()
  .map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8"))));
// only the archives manifest.json lists: an unlisted .jsonl.gz would add exchanges no other instrument accounts for
let archives: ReturnType<typeof manifestArchives>;
try { archives = manifestArchives(DIR); } catch (e) { console.error(`${DIR}: ${(e as Error).message}`); process.exit(1); }
try { for (const a of archives) trajectories.set(a.name, readArchiveSnaps(a)); }
catch (e) { console.error(`${DIR}: ${(e as Error).message}`); process.exit(1); }
const all = [...trajectories.values()].flat();
try {
  for (const [name, t] of trajectories) if (t.length) assertValidCaptures(t, `${DIR}/${name}`);
  assertValidCaptures(all, DIR); // seq numbers are unique across the whole directory too
} catch (e: any) { console.error(e.message); process.exit(1); }
let snaps = all.sort((a, b) => a.seq - b.seq);
if (seqOk) snaps = snaps.filter((s) => seqOk(s.seq));
if (grepRe) snaps = snaps.filter((s) => grepRe.test(JSON.stringify(s.request.messages)));
if (has("last-per-conversation")) {
  // A later snapshot whose messages START WITH this snapshot's messages supersedes it.
  const keep: any[] = [];
  for (const s of snaps) {
    const sig = JSON.stringify(s.request.messages);
    const superseded = snaps.some((o) => o !== s &&
      JSON.stringify(o.request.messages).startsWith(sig.slice(0, -1)) &&
      o.request.messages.length > s.request.messages.length);
    if (!superseded) keep.push(s);
  }
  snaps = keep;
}
snaps = snaps.slice(0, LIMIT);
// an explicit selection that matches nothing is a mistake (a typo'd seq, a stale grep), not an empty experiment:
// say so and leave no output behind
if ((seqOk || grepRe) && snaps.length === 0) {
  console.error(`no snapshot in ${DIR} matches the selection${flag("seq") !== undefined ? ` --seq ${flag("seq")}` : ""}${grepRe ? ` --grep ${flag("grep")}` : ""}; nothing written`);
  process.exit(1);
}
mkdirSync(dirname(OUT), { recursive: true });
console.log(`selected ${snaps.length} snapshot(s) from ${DIR}`);

function mutate(req: any): any {
  const r = JSON.parse(JSON.stringify(req));
  if (SYSTEM_TEXT !== null) {
    const sys = r.messages.find((m: any) => m.role === "system");
    if (sys) sys.content = SYSTEM_TEXT;
    else { r.messages.unshift({ role: "system", content: SYSTEM_TEXT }); r.__system_inserted = true; }
  }
  if (SET) Object.assign(r, SET);
  if (flag("drop-tools") && Array.isArray(r.tools)) {
    const drop = new Set(flag("drop-tools")!.split(","));
    r.tools = r.tools.filter((t: any) => !drop.has(t.function?.name ?? t.name));
  }
  if (Number.isFinite(MESSAGES_HEAD)) r.messages = r.messages.slice(0, MESSAGES_HEAD);
  if (flag("append-user")) r.messages.push({ role: "user", content: flag("append-user") });
  return r;
}

/** A tool call's arguments for comparison: canonical JSON when they parse, the trimmed text otherwise. */
const argKey = (a: unknown): string => {
  if (typeof a !== "string") return canon(a ?? null);
  try { return canon(JSON.parse(a)); } catch { return a.trim(); }
};
/** Every choice, in index order, reduced to what a comparison looks at. */
function choiceKeys(resp: any): { names: string[]; calls: string; text: string }[] {
  const choices = [...(resp?.choices ?? [])].sort((x: any, y: any) => (x?.index ?? 0) - (y?.index ?? 0));
  return choices.map((c: any) => {
    const msg = c?.message ?? {}, tcs = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const names = tcs.map((t: any) => String(t?.function?.name ?? t?.name ?? ""));
    return { names, calls: JSON.stringify(tcs.map((t: any, i: number) => [names[i], argKey(t?.function?.arguments ?? t?.arguments)])), text: String(msg.content ?? "").trim().replace(/\s+/g, " ") };
  });
}

function describe(resp: any) {
  const msg = resp?.choices?.[0]?.message ?? {};
  const tc = (msg.tool_calls ?? []).map((t: any) => t.function?.name ?? t.name);
  return {
    finish: resp?.choices?.[0]?.finish_reason ?? null,
    tool_calls: tc,
    first_tool: tc[0] ?? null,
    n_choices: Array.isArray(resp?.choices) ? resp.choices.length : 0,
    content_chars: msg.content ? String(msg.content).length : 0,
    completion_tokens: resp?.usage?.completion_tokens ?? null,
  };
}

/** Whether the mutated answer differs from the original under --compare, over every choice by index. */
function answersDiffer(original: any, mutated: any, compare: string): boolean {
  const o = choiceKeys(original), m = choiceKeys(mutated);
  if (o.length !== m.length) return true;
  return o.some((oc, i) => {
    const mc = m[i]!;
    const mode = compare === "auto" ? (oc.names.length || mc.names.length ? "calls" : "text") : compare;
    if (mode === "tool") return JSON.stringify(oc.names) !== JSON.stringify(mc.names);
    if (mode === "calls") return oc.calls !== mc.calls;
    return oc.text !== mc.text || oc.calls !== mc.calls; // content
  });
}

let i = 0, failures = 0;
for (const s of snaps) {
  i++;
  const req = mutate(s.request);
  const systemInserted = !!req.__system_inserted;
  delete req.__system_inserted;
  for (let r = 1; r <= REPEAT; r++) {
    const rec: any = { seq: s.seq, repeat: r, ts: new Date().toISOString(), config: CONFIG, config_sha256: CONFIG_SHA, original: describe(s.response), ...(systemInserted ? { system_inserted: true } : {}) };
    try {
      const j: any = await postChat(BASE, req);
      rec.mutated = describe(j);
      rec.changed_first_tool = rec.original.first_tool !== rec.mutated.first_tool;
      rec.changed = answersDiffer(s.response, j, COMPARE);
      rec.response_text = String(j?.choices?.[0]?.message?.content ?? "").slice(0, 2000);
      rec.tool_args = JSON.stringify(j?.choices?.[0]?.message?.tool_calls ?? []).slice(0, 2000);
    } catch (e: any) {
      rec.error = String(e?.message ?? e).slice(0, 200);
      failures++;
    }
    appendFileSync(OUT, JSON.stringify(rec) + "\n");
    console.log(`[${i}/${snaps.length} r${r}] seq ${s.seq}: ${rec.original.first_tool ?? "text"} -> ${rec.mutated?.first_tool ?? rec.error ?? "text"}${rec.changed ? "  *CHANGED*" : ""}${systemInserted ? "  (system message inserted)" : ""}`);
  }
}
console.log("done");

if (failures) { console.error(`${failures} replay call(s) failed; they are recorded with "error" and must not be read as model behaviour`); process.exit(1); }
