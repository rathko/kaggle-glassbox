#!/usr/bin/env bun
// replay-states: next-call replay across many previously-observed decision points ("states") and
// many candidate arms, in one pass. Generalises the single-state, single-arm idea in
// step-replay.ts to the shape you actually want when diagnosing a recurring failure: "across
// every place I've seen this go wrong before, does arm A change what happens next, versus the
// captured (control) arm?"
//
// Two state kinds out of the box:
//   onset  the captured response IS the thing you're diagnosing (a fresh, non-repeat occurrence
//          of some undesired model behaviour at this step).
//   retry  the first captured exchange AFTER an onset in the same trajectory — i.e. what the
//          model is asked right after its previous call was rejected/corrected. Many failure
//          modes recur verbatim here, so this state carries the loop, not just its start.
//
// Each arm is either:
//   a prompt FILE whose full text replaces an "anchor" block of text inside the captured system
//   message (refuses if the anchor text is not found verbatim — silently matching the wrong
//   thing would invalidate every result from that arm), or
//   a set of sampling-parameter overrides merged into the request body.
// Arm "control" always exists and replays the captured request unchanged.
//
// The default classifier below demonstrates the pattern for a generic "structured file-edit
// tool" (an edit call with old_string/new_string/filepath-shaped arguments, as many SWE-style
// agent tools use) — swap `classify()` for your own tool's shape; it is intentionally the only
// task-specific piece of this file.
//
// Split: states are grouped by their source trajectory ("run"); runs are sorted and alternate
// selection/confirmation, so you are not allowed to pick a winning arm on the same data you
// confirm it on.
//
// usage: bun src/replay/replay-states.ts --states-file rows.jsonl --capture-root <dir>
//          --anchor-file <path> --arms a.md,b.md [--kinds onset,retry] [--n 4] [--pool 8]
//          [--tag t] [--base http://127.0.0.1:8010] [--out results.jsonl]
//          [--sampling-arms "name:temperature=1;name2:temperature=1,top_k=64"] [--classifier my-classify.ts]
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { postChat } from "./endpoint";
import { join, basename, dirname } from "node:path";
import { assertValidCaptures } from "./capture-valid";
import { countFlag } from "./cli-num";
import { strictArgs } from "../cli-args";
import { readManifestArchive } from "../capture/archives";
import { makeRunLoader, candidateRows, runKeyCollisions, spreadSample, stateRowProblems } from "./state-rows";

const a = process.argv.slice(2);
strictArgs(a, {
  valued: ["states-file", "capture-root", "anchor-file", "arms", "kinds", "n", "pool", "entry", "tag", "base", "out", "sampling-arms", "classifier"],
}, "usage: bun src/replay/replay-states.ts --states-file <jsonl> --capture-root <dir> [--anchor-file <path>] --arms a.md,b.md [--kinds onset,retry]\n  [--n 4] [--pool 8] [--entry 60] [--tag t] [--base URL] [--out results.jsonl] [--sampling-arms SPEC] [--classifier module.ts]");
const flag = (n: string, d?: string) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : d; };
const N = countFlag("n", flag("n"), 4), POOL = countFlag("pool", flag("pool"), 8), TAG = flag("tag", "replay");
const NENTRY = countFlag("entry", flag("entry"), 60, 0);
// --kinds must name at least one known kind and nothing else: a typo ("onsett") would select no state, and an
// empty experiment that exits 0 reads like a result
const KIND_NAMES = ["onset", "retry", "entry"];
const KIND_LIST = flag("kinds", "onset,retry")!.split(",").map((k) => k.trim());
if (!KIND_LIST.length || KIND_LIST.some((k) => !KIND_NAMES.includes(k))) {
  console.error(`--kinds must be a comma list of ${KIND_NAMES.join(", ")}, got '${flag("kinds")}'`);
  process.exit(2);
}
const KINDS = new Set(KIND_LIST);
const BASE = flag("base", "http://127.0.0.1:8010")!;
const OUT = flag("out", "./results/replay-states.jsonl")!;
const STATES_FILE = flag("states-file"), CAP_ROOT = flag("capture-root"), ANCHOR_FILE = flag("anchor-file");
if (!STATES_FILE || !CAP_ROOT) { console.error("usage: --states-file <jsonl> --capture-root <dir> [--anchor-file <path>] --arms a.md,b.md [options]"); process.exit(2); }
const ARMFILES = flag("arms", "")!.split(",").filter(Boolean);

// --sampling-arms "t1:temperature=1;t1k64:temperature=1,top_k=64": sampling-only arms replayed on the captured
// (control) prompt text. Every arm name must be unique across control, prompt-file and sampling arms (results are
// tallied by name, so two arms with one name would be silently pooled into one rate), and every sampling key must be
// a plain parameter name with a finite numeric value. All of it is checked before any output is created.
const usage = (msg: string): never => { console.error(msg); process.exit(2); };
const SAMPLING_ARMS = flag("sampling-arms", "")!.split(";").filter(Boolean).map((x) => {
  const i = x.indexOf(":");
  const name = i >= 0 ? x.slice(0, i).trim() : "", kv = i >= 0 ? x.slice(i + 1) : "";
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || !kv.trim()) usage(`--sampling-arms: '${x}' is not name:key=value[,key=value...]`);
  const params: Record<string, number> = {};
  for (const p of kv.split(",")) {
    const j = p.indexOf("=");
    const k = j >= 0 ? p.slice(0, j).trim() : "", raw = j >= 0 ? p.slice(j + 1).trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) usage(`--sampling-arms ${name}: '${p}' needs a parameter name like temperature=1`);
    const v = Number(raw);
    if (raw === "" || !Number.isFinite(v)) usage(`--sampling-arms ${name}: ${k} must be a finite number, got '${raw}'`);
    if (k in params) usage(`--sampling-arms ${name}: ${k} given twice`);
    params[k] = v;
  }
  return { name, text: null as string | null, params };
});
{
  const names = ["control", ...ARMFILES.map((f) => basename(f).replace(/\.md$/, "")), ...SAMPLING_ARMS.map((s) => s.name)];
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) usage(`arm names must be unique (results are tallied by name); repeated: ${[...new Set(dup)].join(", ")}`);
}
mkdirSync(dirname(OUT), { recursive: true });
const ANCHOR = ANCHOR_FILE ? readFileSync(ANCHOR_FILE, "utf8").trim() : null;

// A generic states index: one JSON object per line, shaped like
// { corpus, run, group, seq, flagged, fingerprint, tool, outcome, ambiguous }. `corpus` plus
// `group` locate the capture group (<capture-root>/<corpus>/capture/task-<group>.jsonl.gz);
// `run` identifies the trajectory for split purposes; `flagged` marks an onset candidate;
// `fingerprint` lets consecutive identical calls be recognised as repeats rather than new onsets.
// Ambiguous rows still belong to their run's trajectory (their capture group holds real calls, possibly a retry), so
// run/group membership is built from ALL rows; ambiguity only removes a row from being chosen as a state.
const allRows = readFileSync(STATES_FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
// identities are checked before anything is selected: string corpus/run/group, positive seq, no duplicate row
const rowProblems = stateRowProblems(allRows);
if (rowProblems.length) { console.error(`states index: ${rowProblems.slice(0, 10).join("; ")}${rowProblems.length > 10 ? ` ... and ${rowProblems.length - 10} more` : ""}`); process.exit(1); }
const clash = runKeyCollisions(allRows);
if (clash.length) { console.error(`states index: ${clash.join("; ")}`); process.exit(1); }

const capCache = new Map<string, any[]>();
function cap(corpus: string, group: string): any[] {
  const key = `${corpus}/${group}`;
  if (!capCache.has(key)) {
    // only a group manifest.json lists (and only from a capture dir with no unlisted archives)
    const p = join(CAP_ROOT!, corpus, "capture", String(group));
    const snaps = readManifestArchive(join(CAP_ROOT!, corpus, "capture"), String(group)).sort((x: any, y: any) => x.seq - y.seq);
    assertValidCaptures(snaps, p);
    capCache.set(key, snaps);
  }
  return capCache.get(key)!;
}
// One run's trajectory can span several capture groups. The retry after an onset is the run's NEXT call, which may
// sit in another group, so every group of a run is merged and validated as one trajectory (unique seqs, every
// exchange valid) before any state is cut from it.
const loadRun = makeRunLoader(allRows, cap, assertValidCaptures);
// a run that cannot be loaded as one valid trajectory stops the experiment with a message, before any call
const runCap = (corpus: string, run: string) => {
  try { return loadRun(corpus, run); } catch (e) { console.error(`states index: run ${corpus}/${run}: ${(e as Error).message}`); process.exit(1); }
};
const firstCall = (res: any) => res?.choices?.[0]?.message?.tool_calls?.[0];

type St = { kind: "onset" | "retry" | "entry"; run: string; runId: string; corpus: string; group: string; seq: number; onsetArgs: string };
const states: St[] = [];
const entries: St[] = [];
// consecutive-call detection walks every row, ambiguous ones included (they are real calls); only the
// non-ambiguous rows can become states
for (const { row: r, repeat } of candidateRows(allRows)) {
  const run = `${r.corpus}/${r.run}`;
  if (!repeat && !r.flagged && r.outcome === "success") entries.push({ kind: "entry", run, runId: r.run, corpus: r.corpus, group: r.group, seq: r.seq, onsetArgs: "" });
  if (repeat || !r.flagged) continue;
  const c = runCap(r.corpus, r.run);
  const on = c.find((x) => x.snap.seq === r.seq);
  if (!on || on.group !== String(r.group)) { console.error(`states index: ${run} seq ${r.seq} is not in capture group ${r.group}`); process.exit(1); }
  const onsetArgs = String(firstCall(on.snap.response)?.function?.arguments ?? "");
  if (KINDS.has("onset")) states.push({ kind: "onset", run, runId: r.run, corpus: r.corpus, group: r.group, seq: r.seq, onsetArgs });
  const nx = c.find((x) => x.snap.seq > r.seq);
  if (KINDS.has("retry") && nx) states.push({ kind: "retry", run, runId: r.run, corpus: r.corpus, group: nx.group, seq: nx.snap.seq, onsetArgs });
}
// exactly --entry states, spread over the whole sorted list (corpus, run, seq), never a prefix of it. Each chosen
// entry is cut from its run's merged, validated trajectory like an onset: a broken exchange in another group of the
// same run rejects the run, and the entry's (group, seq) must really be in it.
if (KINDS.has("entry")) for (const e of spreadSample(entries, NENTRY)) {
  const c = runCap(e.corpus, e.runId);
  const at = c.find((x) => x.snap.seq === e.seq);
  if (!at || at.group !== String(e.group)) { console.error(`states index: ${e.run} seq ${e.seq} is not in capture group ${e.group}`); process.exit(1); }
  states.push(e);
}
const runs = [...new Set(states.map((s) => s.run))].sort();
const half = new Map(runs.map((r, i) => [r, i % 2 === 0 ? "selection" : "confirmation"]));

// The default classifier is written for a structured-edit tool (edit_file / write_file / run_command). For any
// other tool, pass --classifier <module.ts>: a module whose default export is
//   (call: { function: { name: string; arguments: string } } | undefined, onsetArgs: string) => string
// returning the category of the model's next call. The summary counts "repeat" and "malformed" as failures.
const CLASSIFIER = flag("classifier");
const classify: (call: any, onsetArgs: string) => string = CLASSIFIER
  ? (await import(require("node:path").resolve(CLASSIFIER))).default
  : defaultClassify;
if (typeof classify !== "function") { console.error(`--classifier ${CLASSIFIER} has no default-exported function`); process.exit(2); }

function defaultClassify(call: any, onsetArgs: string): string {
  const name = call?.function?.name;
  if (!name) return "other";
  if (onsetArgs && call.function.arguments === onsetArgs) return "repeat";
  let g: any;
  try { g = JSON.parse(call.function.arguments); } catch { return name === "edit_file" || name === "write_file" ? "malformed" : "other"; }
  if (name === "edit_file") {
    if (!(typeof g?.old_string === "string" && typeof g?.new_string === "string" && g?.filepath)) return "malformed";
    return !g.new_string.includes("\n") && g.new_string.includes("\\n") ? "escaped" : "valid";
  }
  if (name === "write_file") return typeof g?.content === "string" && g?.filepath ? "switched" : "malformed";
  return name === "run_command" ? "switched" : "other";
}

const arms: { name: string; text: string | null; params?: Record<string, number> }[] = [
  { name: "control", text: null },
  ...ARMFILES.map((f) => ({ name: basename(f).replace(/\.md$/, ""), text: readFileSync(f, "utf8").trim() })),
  ...SAMPLING_ARMS,
];
console.log(`states: ${states.filter((s) => s.kind === "entry").length} entry, ${states.filter((s) => s.kind === "onset").length} onset, ${states.filter((s) => s.kind === "retry").length} retry; ${runs.length} runs; N=${N}; arms ${arms.map((x) => x.name).join(" ")}`);
const jobs: { st: St; arm: (typeof arms)[number]; k: number }[] = [];
for (const st of states) for (let k = 0; k < N; k++) for (const arm of arms) jobs.push({ st, arm, k });
const tally: Record<string, Record<string, number>> = {};
let errors = 0;
const q = [...jobs];
await Promise.all(Array.from({ length: POOL }, async () => {
  for (let j; (j = q.shift()); ) {
    const req = JSON.parse(JSON.stringify(cap(j.st.corpus, j.st.group).find((x) => x.seq === j.st.seq).request));
    const sys = req.messages.find((m: any) => m.role === "system");
    if (j.arm.text) {
      if (!ANCHOR || !String(sys.content).includes(ANCHOR)) { errors++; console.error(`ANCHOR_NOT_FOUND ${j.st.run}`); continue; }
      sys.content = String(sys.content).replace(ANCHOR, j.arm.text);
    }
    if (j.arm.params) {
      const { ...rest } = j.arm.params as any;
      Object.assign(req, rest);
    }
    try {
      const res: any = await postChat(BASE, req);
      const cls = classify(firstCall(res), j.st.onsetArgs);
      const t = `${j.arm.name}|${j.st.kind}|${half.get(j.st.run)}`;
      tally[t] ??= {}; tally[t][cls] = (tally[t][cls] ?? 0) + 1;
      appendFileSync(OUT, JSON.stringify({ tag: TAG, arm: j.arm.name, kind: j.st.kind, half: half.get(j.st.run), run: j.st.run, seq: j.st.seq, k: j.k, next: cls }) + "\n");
    } catch (e) { errors++; console.error(`ERR ${j.st.run} seq ${j.st.seq}: ${String(e).slice(0, 200)}`); }
  }
}));
for (const [k, v] of Object.entries(tally).sort()) {
  const n = Object.values(v).reduce((x, y) => x + y, 0);
  const bad = (v.malformed ?? 0) + (v.repeat ?? 0);
  console.log(`${k.padEnd(44)} n=${String(n).padStart(3)} fail ${String(bad).padStart(3)} (${((bad / n) * 100).toFixed(1)}%) repeat ${v.repeat ?? 0} malformed ${v.malformed ?? 0} valid ${v.valid ?? 0} escaped ${v.escaped ?? 0} switched ${v.switched ?? 0} other ${v.other ?? 0}`);
}
console.log(`errors ${errors}`);
// The built-in classifier only knows one tool family; on any other harness most calls land in "other" and the
// fail column reads 0 for the wrong reason. Say so, rather than let a quiet zero look like a clean result.
if (!CLASSIFIER) {
  const all = Object.values(tally).flatMap((v) => Object.entries(v));
  const total = all.reduce((s, [, c]) => s + c, 0), other = all.filter(([k]) => k === "other").reduce((s, [, c]) => s + c, 0);
  console.log(`classifier: built-in (edit_file / write_file / run_command only); ${other} of ${total} next calls fell outside it as "other"` +
    (total && other / total > 0.5 ? " -- most calls were not classified: write a --classifier for your tools (see examples/classify-next-call.ts)" : ""));
}

if (errors) { console.error(`${errors} call(s) failed and are excluded from every count above`); process.exit(1); }
