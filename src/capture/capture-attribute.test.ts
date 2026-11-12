import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fillManifest } from "./test-fixture";

const SCRIPT = join(import.meta.dir, "capture-attribute.ts");
// the worked example adapter: traces at agent-logs/<id>.json shaped { events: [{ who, text, calls: [{ tool, input }] }] }
const ADAPTER = join(import.meta.dir, "../../examples/attribution-adapter.json");
const traceOf = (calls: { tool: string; input: unknown }[]) => ({ events: [{ who: "model", text: "", calls }] });

test("attributes a captured snapshot to its task by matching tool-call content", async () => {
  const resDir = mkdtempSync(join(tmpdir(), "attr-results-"));
  const capDir = mkdtempSync(join(tmpdir(), "attr-capture-"));
  try {
    writeFileSync(join(resDir, "task_results.jsonl"), JSON.stringify({ instance_id: "t1", model_calls: 1 }) + "\n");
    mkdirSync(join(resDir, "agent-logs"));
    writeFileSync(join(resDir, "agent-logs", "t1.json"), JSON.stringify(traceOf([{ tool: "edit_file", input: '{"a":1}' }])));

    const groupKey = "abc123";
    const snapshot = {
      seq: 1,
      at: new Date().toISOString(),
      request: { messages: [{ role: "system", content: "sys" }, { role: "user", content: "x" }], tools: [{ function: { name: "edit_file" } }] },
      response: { choices: [{ message: { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "edit_file", arguments: '{"a":1}' } }] } }] },
    };
    writeFileSync(join(capDir, `task-${groupKey}.jsonl.gz`), Bun.gzipSync(Buffer.from(JSON.stringify(snapshot) + "\n")));
    writeFileSync(join(capDir, "manifest.json"), JSON.stringify({ [groupKey]: { exchanges: 1 } })); fillManifest(capDir);
    const p = Bun.spawn(["bun", SCRIPT, resDir, capDir, "--adapter", ADAPTER], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("1 by content");

    const idx = JSON.parse(readFileSync(join(capDir, "task-index.json"), "utf8"));
    expect(idx.t1).toEqual([groupKey]);

    const manifest = JSON.parse(readFileSync(join(capDir, "manifest.json"), "utf8"));
    expect(manifest[groupKey].instances).toEqual(["t1"]);
  } finally {
    rmSync(resDir, { recursive: true, force: true });
    rmSync(capDir, { recursive: true, force: true });
  }
});

test("refuses (non-zero exit) when attribution disagrees with reported llm-call counts", async () => {
  const resDir = mkdtempSync(join(tmpdir(), "attr-results-"));
  const capDir = mkdtempSync(join(tmpdir(), "attr-capture-"));
  try {
    // Reports 10 llm calls for t1, but no trace and no capture data exist to back that up —
    // attribution has nothing to go on, so the self-check must fail.
    writeFileSync(join(resDir, "task_results.jsonl"), JSON.stringify({ instance_id: "t1", model_calls: 10 }) + "\n");
    const groupKey = "zzz999";
    const snapshot = {
      seq: 1,
      at: new Date().toISOString(),
      request: { messages: [{ role: "user", content: "unrelated" }], tools: [{ function: { name: "noop" } }] },
      response: { choices: [{ message: {} }] },
    };
    writeFileSync(join(capDir, `task-${groupKey}.jsonl.gz`), Bun.gzipSync(Buffer.from(JSON.stringify(snapshot) + "\n")));

    const p = Bun.spawn(["bun", SCRIPT, resDir, capDir, "--adapter", ADAPTER], { stdout: "pipe", stderr: "pipe" });
    const code = await p.exited;
    expect(code).toBe(1);
  } finally {
    rmSync(resDir, { recursive: true, force: true });
    rmSync(capDir, { recursive: true, force: true });
  }
});

test("a task reporting calls with no assigned snapshot, or unassigned snapshots below --min-coverage, is refused", async () => {
  const resDir = mkdtempSync(join(tmpdir(), "attr-results-"));
  const capDir = mkdtempSync(join(tmpdir(), "attr-capture-"));
  try {
    // concurrent run (no time fallback), t1 reports 2 calls; neither snapshot matches any trace. 0 is within +/-2
    // of 2, so the old self-check passed and an empty task index was written.
    writeFileSync(join(resDir, "task_results.jsonl"), JSON.stringify({ instance_id: "t1", model_calls: 2 }) + "\n");
    const go = (...extra: string[]) => Bun.spawnSync(["bun", SCRIPT, resDir, capDir, "--adapter", ADAPTER, "--concurrency", "4", ...extra]);
    const snap = (seq: number) => ({ seq, status: 200, at: new Date().toISOString(), request: { messages: [{ role: "user", content: "unrelated" }], tools: [{ function: { name: "noop" } }] }, response: { choices: [{ message: {} }] } });
    writeFileSync(join(capDir, "task-k1.jsonl.gz"), Bun.gzipSync(Buffer.from([snap(1), snap(2)].map((x) => JSON.stringify(x)).join("\n") + "\n")));
    writeFileSync(join(capDir, "manifest.json"), JSON.stringify({ k1: { exchanges: 2 } })); fillManifest(capDir);
    const p = go();
    expect(p.exitCode).toBe(1);
    expect(p.stdout.toString()).toContain("1 task(s) reporting model calls have no snapshot (t1)");
    expect(p.stdout.toString()).toContain("0.0% of snapshots assigned");
    expect(() => readFileSync(join(capDir, "task-index.json"))).toThrow();
    // a task with zero calls and nothing captured is fine, but an unassigned snapshot still counts against coverage
    writeFileSync(join(resDir, "task_results.jsonl"), JSON.stringify({ instance_id: "t1", model_calls: 0 }) + "\n");
    expect(go().exitCode).toBe(1);
    expect(go("--min-coverage", "0").exitCode).toBe(0);
    expect(go("--min-coverage", "1.5").exitCode).toBe(2);
  } finally {
    rmSync(resDir, { recursive: true, force: true });
    rmSync(capDir, { recursive: true, force: true });
  }
});

function attributeSetup(snaps: any[], manifestEntry: any, results: any[], traces: Record<string, any>) {
  const resDir = mkdtempSync(join(tmpdir(), "attr-results-")), capDir = mkdtempSync(join(tmpdir(), "attr-capture-"));
  writeFileSync(join(resDir, "task_results.jsonl"), results.map((r) => JSON.stringify(r)).join("\n") + "\n");
  mkdirSync(join(resDir, "agent-logs"));
  for (const [id, t] of Object.entries(traces)) writeFileSync(join(resDir, "agent-logs", `${id}.json`), JSON.stringify(t));
  writeFileSync(join(capDir, "task-g1.jsonl.gz"), Bun.gzipSync(Buffer.from(snaps.map((s) => JSON.stringify(s)).join("\n") + "\n")));
  writeFileSync(join(capDir, "manifest.json"), JSON.stringify({ g1: manifestEntry })); fillManifest(capDir);
  const p = Bun.spawnSync(["bun", SCRIPT, resDir, capDir, "--adapter", ADAPTER]);
  const out = { code: p.exitCode, stdout: p.stdout.toString(), idx: null as any, manifest: JSON.parse(readFileSync(join(capDir, "manifest.json"), "utf8")) };
  try { out.idx = JSON.parse(readFileSync(join(capDir, "task-index.json"), "utf8")); } catch {}
  rmSync(resDir, { recursive: true, force: true }); rmSync(capDir, { recursive: true, force: true });
  return out;
}
const callSnap = (seq: number, args: string, extra: any = {}) => ({
  seq, at: "2026-01-01T00:00:00Z",
  request: { messages: [{ role: "user", content: "x" }], tools: [{ function: { name: "edit_file" } }] },
  response: { choices: [{ message: { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "edit_file", arguments: args } }] } }] }, ...extra,
});
const trace = (args: string) => traceOf([{ tool: "edit_file", input: args }]);

test("a snapshot's harness task id is authoritative even when the content heuristic points at another task", () => {
  // the tool call matches t2's trace, but the harness said this exchange was t1's
  const r = attributeSetup([callSnap(1, '{"b":2}', { task_id: "t1" })], { exchanges: 1, task_id: "t1", instances: ["t1"] },
    [{ instance_id: "t1", model_calls: 1 }], { t2: trace('{"b":2}') });
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("1 by harness task id");
  expect(r.idx).toEqual({ t1: ["g1"] });
  expect(r.manifest.g1.instances).toEqual(["t1"]);
});

test("a tie in content votes leaves the snapshot unassigned, and coverage then fails instead of guessing", () => {
  // one response carries two calls: one only t1's trace has, one only t2's: an exact 2-2 tie
  const tied = { seq: 1, status: 200, at: "2026-01-01T00:00:00Z", request: { messages: [{ role: "user", content: "x" }], tools: [{ function: { name: "edit_file" } }] },
    response: { choices: [{ message: { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "edit_file", arguments: '{"a":1}' } }, { id: "c2", type: "function", function: { name: "edit_file", arguments: '{"b":2}' } }] } }] } };
  const r = attributeSetup([tied], { exchanges: 1 }, [{ instance_id: "t1", model_calls: 1 }, { instance_id: "t2", model_calls: 1 }],
    { t1: trace('{"a":1}'), t2: trace('{"b":2}') });
  expect(r.stdout).toContain("(1 tied)");
  expect(r.code).toBe(1);
  expect(r.idx).toBe(null);
});

test("with no adapter only harness task ids attribute: no trace or log layout is assumed", () => {
  const resDir = mkdtempSync(join(tmpdir(), "attr-results-")), capDir = mkdtempSync(join(tmpdir(), "attr-capture-"));
  try {
    writeFileSync(join(resDir, "task_results.jsonl"), [{ instance_id: "t1", model_calls: 1 }, { instance_id: "t2", model_calls: 1 }].map((r) => JSON.stringify(r)).join("\n") + "\n");
    // a trace in some other layout is never read without an adapter that describes it
    mkdirSync(join(resDir, "agent-logs"));
    writeFileSync(join(resDir, "agent-logs", "t2.json"), JSON.stringify(traceOf([{ tool: "edit_file", input: '{"b":2}' }])));
    writeFileSync(join(capDir, "task-g1.jsonl.gz"), Bun.gzipSync(Buffer.from([callSnap(1, '{"a":1}', { task_id: "t1" }), callSnap(2, '{"b":2}')].map((x) => JSON.stringify(x)).join("\n") + "\n")));
    writeFileSync(join(capDir, "manifest.json"), JSON.stringify({ g1: { exchanges: 2 } })); fillManifest(capDir);
    const p = Bun.spawnSync(["bun", SCRIPT, resDir, capDir]);
    expect(p.stdout.toString()).toContain("1 by harness task id, 0 by content");
    expect(p.stdout.toString()).toContain("no calls_field"); // without an adapter the row counts are not read
    expect(p.exitCode).toBe(1); // the untagged snapshot is unassigned, so coverage fails
    expect(Bun.spawnSync(["bun", SCRIPT, resDir, capDir, "--adapter", ADAPTER]).stdout.toString()).toContain("1 by harness task id, 1 by content");
  } finally { rmSync(resDir, { recursive: true, force: true }); rmSync(capDir, { recursive: true, force: true }); }
});

test("an adapter with an unknown key or a template without {id} is a usage error", () => {
  const d = mkdtempSync(join(tmpdir(), "attr-adapter-"));
  try {
    writeFileSync(join(d, "task_results.jsonl"), "{}\n");
    writeFileSync(join(d, "bad1.json"), JSON.stringify({ trace_file: "x" }));
    writeFileSync(join(d, "bad2.json"), JSON.stringify({ trace: "traces/all.json" }));
    expect(Bun.spawnSync(["bun", SCRIPT, d, d, "--adapter", join(d, "bad1.json")]).exitCode).toBe(2);
    expect(Bun.spawnSync(["bun", SCRIPT, d, d, "--adapter", join(d, "bad2.json")]).exitCode).toBe(2);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a harness task id that names no task in the result rows is refused, and nothing is written", () => {
  // results hold only T1; the archive carries a mistyped T11: authoritative ids are trusted only for real tasks
  const resDir = mkdtempSync(join(tmpdir(), "attr-results-")), capDir = mkdtempSync(join(tmpdir(), "attr-capture-"));
  try {
    writeFileSync(join(resDir, "task_results.jsonl"), JSON.stringify({ instance_id: "T1" }) + "\n");
    writeFileSync(join(capDir, "task-g1.jsonl.gz"), Bun.gzipSync(Buffer.from(JSON.stringify(callSnap(1, '{"a":1}', { task_id: "T11" })) + "\n")));
    const manifest = JSON.stringify({ g1: { exchanges: 1, seq_first: 1, seq_last: 1, task_id: "T11" } });
    writeFileSync(join(capDir, "manifest.json"), manifest);
    const p = Bun.spawnSync(["bun", SCRIPT, resDir, capDir]);
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain("name no task in the result rows: T11 (1 snapshot)");
    expect(readFileSync(join(capDir, "manifest.json"), "utf8")).toBe(manifest);
    expect(require("node:fs").existsSync(join(capDir, "task-index.json"))).toBe(false);
    // the same capture with the right id passes
    writeFileSync(join(capDir, "task-g1.jsonl.gz"), Bun.gzipSync(Buffer.from(JSON.stringify(callSnap(1, '{"a":1}', { task_id: "T1" })) + "\n")));
    writeFileSync(join(capDir, "manifest.json"), JSON.stringify({ g1: { exchanges: 1, task_id: "T1" } })); fillManifest(capDir);
    expect(Bun.spawnSync(["bun", SCRIPT, resDir, capDir]).exitCode).toBe(0);
  } finally { rmSync(resDir, { recursive: true, force: true }); rmSync(capDir, { recursive: true, force: true }); }
});

// serial time windows: tasks a and b, done markers at T0+10s and T0+20s; snapshots carry no content to match
function serialRun(starts: Record<string, number> | null, reqOffsets: number[]) {
  const { utimesSync } = require("node:fs");
  const resDir = mkdtempSync(join(tmpdir(), "attr-serial-")), capDir = mkdtempSync(join(tmpdir(), "attr-serial-cap-"));
  const T0 = Date.parse("2026-01-01T00:00:00Z");
  writeFileSync(join(resDir, "task_results.jsonl"), ["a", "b"].map((id) => JSON.stringify({ instance_id: id })).join("\n") + "\n");
  mkdirSync(join(resDir, "done")); mkdirSync(join(resDir, "start"));
  for (const [id, end] of [["a", 10], ["b", 20]] as const) { const f = join(resDir, "done", `${id}`); writeFileSync(f, ""); utimesSync(f, (T0 + end * 1000) / 1000, (T0 + end * 1000) / 1000); }
  if (starts) for (const [id, st] of Object.entries(starts)) { const f = join(resDir, "start", id); writeFileSync(f, ""); utimesSync(f, (T0 + st * 1000) / 1000, (T0 + st * 1000) / 1000); }
  const adapter = join(resDir, "adapter.json");
  writeFileSync(adapter, JSON.stringify({ done_marker: "done/{id}", ...(starts ? { start_marker: "start/{id}" } : {}) }));
  const manifest: Record<string, unknown> = {};
  reqOffsets.forEach((off, i) => {
    const key = `g${i}`;
    const snap = { seq: i + 1, req_at: new Date(T0 + off * 1000).toISOString(), at: new Date(T0 + off * 1000 + 500).toISOString(), request: { messages: [{ role: "user", content: `q${i}` }] }, response: { choices: [{ message: { role: "assistant", content: "x" } }] } };
    writeFileSync(join(capDir, `task-${key}.jsonl.gz`), Bun.gzipSync(Buffer.from(JSON.stringify(snap) + "\n")));
    manifest[key] = { exchanges: 1 };
  });
  writeFileSync(join(capDir, "manifest.json"), JSON.stringify(manifest)); fillManifest(capDir);
  const p = Bun.spawnSync(["bun", SCRIPT, resDir, capDir, "--adapter", adapter, "--min-coverage", "0"]);
  const idx = p.exitCode === 0 ? JSON.parse(readFileSync(join(capDir, "task-index.json"), "utf8")) : null;
  rmSync(resDir, { recursive: true, force: true }); rmSync(capDir, { recursive: true, force: true });
  return { code: p.exitCode, out: p.stdout.toString(), idx };
}

test("serial windows do not overlap and end at the last task: (prev end, end], nothing after", () => {
  // 5 s -> a; 12 s is after a's end, so b's (no grace into b's window); 30 s is after the last end -> nobody
  const r = serialRun(null, [5, 12, 30]);
  expect(r.code).toBe(0);
  expect(r.idx).toEqual({ a: ["g0"], b: ["g1"] });
  expect(r.out).toContain("1 unassigned");
});

test("with start markers a task owns [start, end + 5 s] cut at the next start; gaps and the outside are nobody's", () => {
  // a: [0, 10], b: [15, 20]; 12 s is in a's grace (before b starts), 16 s is b's, -3 s is before the run, 26 s after it
  const r = serialRun({ a: 0, b: 15 }, [12, 16, -3, 26]);
  expect(r.code).toBe(0);
  expect(r.idx).toEqual({ a: ["g0"], b: ["g1"] });
  expect(r.out).toContain("2 unassigned");
});

test("{id} in an adapter template is a safe file name: ids like a/b and ../x read slug+hash traces inside <results-dir>", () => {
  const { safeId } = require("../safe-id");
  const top = mkdtempSync(join(tmpdir(), "attr-safe-"));
  const resDir = join(top, "res"), capDir = join(top, "cap");
  try {
    mkdirSync(join(resDir, "agent-logs", "a"), { recursive: true }); mkdirSync(capDir);
    writeFileSync(join(resDir, "task_results.jsonl"), ["a/b", "../x"].map((id) => JSON.stringify({ instance_id: id, model_calls: 1 })).join("\n") + "\n");
    writeFileSync(join(resDir, "agent-logs", `${safeId("a/b")}.json`), JSON.stringify(traceOf([{ tool: "edit_file", input: '{"a":1}' }])));
    writeFileSync(join(resDir, "agent-logs", `${safeId("../x")}.json`), JSON.stringify(traceOf([{ tool: "edit_file", input: '{"x":2}' }])));
    // decoys at the paths the raw ids would have produced: never read
    writeFileSync(join(resDir, "agent-logs", "a", "b.json"), JSON.stringify(traceOf([{ tool: "edit_file", input: '{"x":2}' }])));
    writeFileSync(join(resDir, "x.json"), JSON.stringify(traceOf([{ tool: "edit_file", input: '{"a":1}' }])));
    const snap = (seq: number, args: string) => ({ seq, at: new Date().toISOString(),
      request: { messages: [{ role: "user", content: "x" }], tools: [{ function: { name: "edit_file" } }] },
      response: { choices: [{ message: { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "edit_file", arguments: args } }] } }] } });
    writeFileSync(join(capDir, "task-k1.jsonl.gz"), Bun.gzipSync(Buffer.from(JSON.stringify(snap(1, '{"a":1}')) + "\n")));
    writeFileSync(join(capDir, "task-k2.jsonl.gz"), Bun.gzipSync(Buffer.from(JSON.stringify(snap(2, '{"x":2}')) + "\n")));
    writeFileSync(join(capDir, "manifest.json"), JSON.stringify({ k1: { exchanges: 1 }, k2: { exchanges: 1 } })); fillManifest(capDir);
    const p = Bun.spawnSync(["bun", SCRIPT, resDir, capDir, "--adapter", ADAPTER]);
    expect(p.stderr.toString()).toBe("");
    expect(p.exitCode).toBe(0);
    const idx = JSON.parse(readFileSync(join(capDir, "task-index.json"), "utf8"));
    expect(idx["a/b"]).toEqual(["k1"]);
    expect(idx["../x"]).toEqual(["k2"]);
  } finally { rmSync(top, { recursive: true, force: true }); }
});

test("an adapter template that resolves outside <results-dir> is a usage error", () => {
  const d = mkdtempSync(join(tmpdir(), "attr-adapter-"));
  try {
    writeFileSync(join(d, "task_results.jsonl"), "{}\n");
    writeFileSync(join(d, "esc.json"), JSON.stringify({ trace: "../elsewhere/{id}.json" }));
    const p = Bun.spawnSync(["bun", SCRIPT, d, d, "--adapter", join(d, "esc.json")]);
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain("inside <results-dir>");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("one archive spanning two tasks gets a per-seq map, so each task's trajectory is its own exchanges", () => {
  // two snapshots share a prompt head (one archive); their tool calls match t1's and t2's traces respectively
  const r = attributeSetup([callSnap(1, '{"a":1}'), callSnap(2, '{"b":2}')], { exchanges: 2 },
    [{ instance_id: "t1", model_calls: 1 }, { instance_id: "t2", model_calls: 1 }], { t1: trace('{"a":1}'), t2: trace('{"b":2}') });
  expect(r.code).toBe(0);
  expect(r.manifest.g1.instances.sort()).toEqual(["t1", "t2"]);
  expect(r.manifest.g1.seq_tasks).toEqual({ "1": "t1", "2": "t2" });
  // a single-task archive carries no map (and a stale one from an earlier attribution is dropped)
  const one = attributeSetup([callSnap(1, '{"a":1}')], { exchanges: 1, seq_tasks: { "1": "t2" } },
    [{ instance_id: "t1", model_calls: 1 }], { t1: trace('{"a":1}') });
  expect(one.code).toBe(0);
  expect(one.manifest.g1.instances).toEqual(["t1"]);
  expect(one.manifest.g1.seq_tasks).toBeUndefined();
});

// ---- round 15: a tool-free, one-exchange agent (QA, math), run concurrently ----
function qaRun(adapter: Record<string, unknown>, snaps: any[], rows: any[], traces: Record<string, any> = {}) {
  const resDir = mkdtempSync(join(tmpdir(), "attr-qa-")), capDir = mkdtempSync(join(tmpdir(), "attr-qa-cap-"));
  writeFileSync(join(resDir, "task_results.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  mkdirSync(join(resDir, "logs"));
  for (const [id, t] of Object.entries(traces)) writeFileSync(join(resDir, "logs", `${id}.json`), JSON.stringify(t));
  const ad = join(resDir, "adapter.json");
  writeFileSync(ad, JSON.stringify(adapter));
  // every snapshot shares one prompt head (the system prompt), so all land in one archive
  writeFileSync(join(capDir, "task-g1.jsonl.gz"), Bun.gzipSync(Buffer.from(snaps.map((s) => JSON.stringify(s)).join("\n") + "\n")));
  writeFileSync(join(capDir, "manifest.json"), JSON.stringify({ g1: {} })); fillManifest(capDir);
  const p = Bun.spawnSync(["bun", SCRIPT, resDir, capDir, "--adapter", ad]);
  const out = { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString(), manifest: JSON.parse(readFileSync(join(capDir, "manifest.json"), "utf8")) };
  rmSync(resDir, { recursive: true, force: true }); rmSync(capDir, { recursive: true, force: true });
  return out;
}
const qaSnap = (seq: number, question: string, answer: string) => ({
  seq, status: 200, at: "2026-01-01T00:00:00Z",
  request: { messages: [{ role: "system", content: "Answer the question." }, { role: "user", content: `Question:\n${question}` }] },
  response: { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: answer } }] },
});
const QA = [
  { instance_id: "q1", question: "What is the capital of Latvia?", model_calls: 1 },
  { instance_id: "q2", question: "What is the capital of Latvia? Answer in Latvian.", model_calls: 1 },
  { instance_id: "q3", question: "How many  sides\ndoes a hexagon have?", model_calls: 1 },
];

test("a concurrent, tool-free, one-exchange QA run attributes fully through the adapter's prompt_field", () => {
  // out of order, concurrency 4 (no time windows); q2's prompt contains q1's, so the longest match must win
  const snaps = [qaSnap(1, "How many sides does a hexagon have?", "6"), qaSnap(2, QA[1]!.question, "Rīga"), qaSnap(3, QA[0]!.question, "Riga")];
  const r = qaRun({ prompt_field: "question", calls_field: "model_calls", concurrency: 4 }, snaps, QA);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("0 unassigned");
  expect(r.stdout).toContain("3/3 tasks within +/-2 of reported model calls");
  expect(r.manifest.g1.seq_tasks).toEqual({ "1": "q3", "2": "q2", "3": "q1" });
  // without prompt_field there is no evidence at all, and coverage fails loudly instead of guessing
  const bare = qaRun({ calls_field: "model_calls", concurrency: 4 }, snaps, QA);
  expect(bare.code).toBe(1);
  expect(bare.stdout).toContain("3 unassigned");
});

test("a captured answer is matched against the agent text in the traces", () => {
  const long = (k: string) => `The answer to ${k} follows from the definition, and it is worked out step by step below.`;
  const snaps = [qaSnap(1, "first, unindexed", long("A")), qaSnap(2, "second, unindexed", long("B"))];
  const tr = (k: string) => ({ events: [{ who: "model", text: long(k), calls: [] }] });
  const r = qaRun({ trace: "logs/{id}.json", trace_steps: "events", step_calls: "calls", step_role: "who", agent_role: "model", concurrency: 2 },
    snaps, [{ instance_id: "a" }, { instance_id: "b" }], { a: tr("A"), b: tr("B") });
  expect(r.code).toBe(0);
  expect(r.manifest.g1.seq_tasks).toEqual({ "1": "a", "2": "b" });
});

test("calls_field counts every attributed exchange by default; calls_count tool_turns counts only tool-offering requests", () => {
  const rows = [{ instance_id: "q1", question: "Prove that the square root of two is irrational.", model_calls: 5 }];
  const snaps = [1, 2, 3, 4, 5].map((q) => qaSnap(q, rows[0]!.question, `step ${q}`));
  const r = qaRun({ prompt_field: "question", calls_field: "model_calls", concurrency: 2 }, snaps, rows);
  expect(r.stdout).toContain("1/1 tasks within +/-2");
  expect(r.code).toBe(0);
  // counted as tool turns, a text-only agent reports 5 calls but shows 0: the self-check fails
  const t = qaRun({ prompt_field: "question", calls_field: "model_calls", calls_count: "tool_turns", concurrency: 2 }, snaps, rows);
  expect(t.stdout).toContain("0/1 tasks within +/-2");
  expect(t.code).toBe(1);
  expect(qaRun({ calls_count: "turns" }, snaps, rows).code).toBe(2);
});

test("examples/attribution-adapter-qa.json attributes a concurrent tool-free QA run, short prompts included", () => {
  const ad = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "examples", "attribution-adapter-qa.json"), "utf8"));
  expect(ad.prompt_field).toBeDefined();
  const rows = [
    { id: "m1", question: "2+2?", model_calls: 1 },
    { id: "m2", question: "3*3?", model_calls: 1 },
    { id: "m3", question: "What is 2+2? Show your work.", model_calls: 1 },
  ];
  // the system prompt itself contains "2+2?", so a bare substring match would hand every snapshot to m1
  const snap = (seq: number, q: string, a: string) => ({ ...qaSnap(seq, q, a), request: { messages: [{ role: "system", content: "Example: 2+2? is 4. Answer briefly." }, { role: "user", content: `Question:\n${q}` }] } });
  const snaps = [snap(1, "3*3?", "9"), snap(2, rows[2]!.question, "4, because..."), snap(3, "2+2?", "4")];
  const r = qaRun(ad, snaps, rows);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("0 unassigned");
  expect(r.manifest.g1.seq_tasks).toEqual({ "1": "m2", "2": "m3", "3": "m1" });
});

test("a calls_field value that is missing, negative, fractional or not a number is refused before anything is written", () => {
  const snaps = [qaSnap(1, QA[0]!.question, "Riga")];
  for (const v of [undefined, -1, 1.5, "1", null]) {
    const rows = [{ instance_id: "q1", question: QA[0]!.question, model_calls: v }];
    const r = qaRun({ prompt_field: "question", calls_field: "model_calls", concurrency: 2 }, snaps, rows);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("calls_field");
    expect(r.manifest.g1.instances).toBeUndefined();
  }
});
