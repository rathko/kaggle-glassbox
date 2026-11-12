import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fillManifest } from "../capture/test-fixture";
import {
  condenseExchanges, problemStatement, buildTaskPrompt, parseSections, renderAnalysis,
  analysisCoverage, readAnalysisMeta, synthInputs, classifyMechanism, parseTaxonomy, tallyClasses,
  loadReferencePatches, requiredSections, FRONTIER_MARK,
} from "./frontier";

// Two synthetic exchanges in the capture format wire-tap.ts --capture-full writes: the second
// request carries the tool result of the first response's tool call.
const ex = [
  {
    seq: 1,
    request: { messages: [{ role: "system", content: "sys" }, { role: "user", content: "Fix the widget overflow in pkg/widget.py" }] },
    response: { usage: { prompt_tokens: 900 }, choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"pkg/widget.py\"}" } }] } }] },
  },
  {
    seq: 2,
    request: { messages: [
      { role: "system", content: "sys" }, { role: "user", content: "Fix the widget overflow in pkg/widget.py" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"pkg/widget.py\"}" } }] },
      { role: "tool", tool_call_id: "c1", content: "x".repeat(50) },
    ] },
    response: { usage: { prompt_tokens: 1400 }, choices: [{ message: { role: "assistant", content: "Done, submitting." } }] },
  },
];

test("condenseExchanges builds a bounded step table with tool results joined by call id", () => {
  const c = condenseExchanges(ex, { resultClip: 20, argsClip: 400 });
  expect(c.steps).toBe(2);
  expect(c.toolCalls).toBe(1);
  expect(c.table).toContain("step 1 seq=1 ctx=900 tool=read_file");
  expect(c.table).toContain("pkg/widget.py");
  expect(c.table).toContain("result[0:20]=" + "x".repeat(20) + " …[+30 chars]");
  expect(c.table).toContain("step 2 seq=2 ctx=1400 text: Done, submitting.");
  expect(c.peakPromptTokens).toBe(1400);
});

test("problemStatement is the first user message of the first exchange", () => {
  expect(problemStatement(ex)).toBe("Fix the widget overflow in pkg/widget.py");
  expect(problemStatement([])).toBe("(no captured task prompt)");
});

test("the default prompt carries no reference patch and asks for no comparison section", () => {
  const p = buildTaskPrompt({ id: "t1", row: { instance_id: "t1", resolved: false }, exchanges: ex, agentPatch: "diff --git a b" });
  expect(p.system).not.toMatch(/VS-REFERENCE/);
  expect(p.user).not.toMatch(/REFERENCE PATCH/);
  expect(p.user).toContain("THE AGENT'S OWN PATCH (14 bytes)");
  expect(p.user).toContain("Fix the widget overflow");
  expect(requiredSections(false)).toEqual(["VERDICT", "TIMELINE", "WASTE", "CONTEXT", "FIX-IDEAS"]);
});

test("an opt-in reference patch adds the labelled block and the VS-REFERENCE section", () => {
  const p = buildTaskPrompt({ id: "t1", row: { instance_id: "t1" }, exchanges: ex, agentPatch: "", referencePatch: "REFDIFF" });
  expect(p.system).toContain("VS-REFERENCE");
  expect(p.user).toContain("REFERENCE PATCH (opt-in, user-supplied");
  expect(p.user).toContain("REFDIFF");
  expect(p.user).toContain("(empty: the agent produced no patch)");
  expect(requiredSections(true)).toContain("VS-REFERENCE");
});

test("buildTaskPrompt includes an optional known-findings context", () => {
  const p = buildTaskPrompt({ id: "t1", row: {}, exchanges: ex, agentPatch: "", context: "Reads dominate context growth." });
  expect(p.system).toContain("KNOWN FINDINGS");
  expect(p.system).toContain("Reads dominate context growth.");
});

test("parseSections tolerates colon, markdown-header and bold section styles", () => {
  const md = "VERDICT: not resolved.\nmore verdict\n## TIMELINE\nsteps 1-3\n**WASTE:** loops\nVS GOLD: right file\nFIX IDEAS: cap reads";
  const s = parseSections(md);
  expect(s.VERDICT).toBe("not resolved.\nmore verdict");
  expect(s.TIMELINE).toBe("steps 1-3");
  expect(s.WASTE).toBe("loops");
  expect(s["VS-REFERENCE"]).toBe("right file");
  expect(s["FIX-IDEAS"]).toBe("cap reads");
});

test("renderAnalysis writes the marker and metadata that coverage and synthesis read back", () => {
  const md = renderAnalysis({ id: "t1", row: { instance_id: "t1", resolved: false, tool_calls: 9 }, patchBytes: 0, reference: null, body: "VERDICT: x" });
  expect(md.startsWith(FRONTIER_MARK)).toBe(true);
  expect(readAnalysisMeta(md)).toEqual({ frontier: true, patchBytes: 0, referenceUsed: false });
  expect(md).toContain("tool_calls=9");
});

function runDir(): string {
  const d = mkdtempSync(join(tmpdir(), "frontier-"));
  mkdirSync(join(d, "analysis"));
  writeFileSync(join(d, "task_results.jsonl"), [
    { instance_id: "a_1", resolved: false }, { instance_id: "b_2", resolved: true }, { instance_id: "c_3", resolved: false },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const full = "VERDICT: v\nTIMELINE: t\nWASTE: w\nCONTEXT: c\nFIX-IDEAS: f";
  writeFileSync(join(d, "analysis", "a_1.md"), renderAnalysis({ id: "a_1", row: {}, patchBytes: 0, reference: null, body: full }));
  writeFileSync(join(d, "analysis", "b_2.md"), renderAnalysis({ id: "b_2", row: {}, patchBytes: 40, reference: null, body: "VERDICT: only" }));
  return d;
}

test("analysisCoverage reports missing and incomplete analyses", () => {
  const d = runDir();
  try {
    const c = analysisCoverage(d);
    expect(c.completedTasks).toBe(3);
    expect(c.missing).toEqual(["b_2", "c_3"]);
    expect(c.complete).toBe(false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("synthInputs defaults to failed tasks and splits no-patch vs wrong-patch deterministically", () => {
  const d = runDir();
  try {
    writeFileSync(join(d, "analysis", "c_3.md"), renderAnalysis({ id: "c_3", row: {}, patchBytes: 120, reference: "refs.jsonl", body: "VERDICT: wrong site\nVS-REFERENCE: adjacent fn\nFIX-IDEAS: test first" }));
    const s = synthInputs([d]);
    expect(s.ids).toEqual(["a_1", "c_3"]);
    expect(s.noPatch).toBe(1);
    expect(s.wrongPatch).toBe(1);
    expect(s.missing).toBe(0);
    expect(s.referenceUsed).toBe(true);
    expect(s.blocks.join("\n")).toContain("VS-REFERENCE: adjacent fn");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("loadReferencePatches reads a JSONL map, and a bare patch only with a single task", () => {
  const d = mkdtempSync(join(tmpdir(), "frontier-ref-"));
  try {
    writeFileSync(join(d, "refs.jsonl"), JSON.stringify({ instance_id: "a_1", patch: "P1" }) + "\n");
    expect(loadReferencePatches(join(d, "refs.jsonl")).get("a_1")).toBe("P1");
    writeFileSync(join(d, "one.diff"), "P2");
    expect(loadReferencePatches(join(d, "one.diff"), "a_1").get("a_1")).toBe("P2");
    expect(() => loadReferencePatches(join(d, "one.diff"))).toThrow(/--only/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("classifyMechanism maps free-text mechanism names onto generic classes", () => {
  expect(classifyMechanism("Budget exhaustion via redundant re-exploration")).toBe("budget");
  expect(classifyMechanism("Correct root-cause, wrong surgical fix-site")).toBe("misdiagnosis");
  expect(classifyMechanism("Incomplete reimplementation diverging from spec")).toBe("incomplete");
  expect(classifyMechanism("Something novel")).toBe("other");
});

test("parseTaxonomy + tallyClasses size each class and its expected recoverable share", () => {
  const md = "## Taxonomy\n\n| Mechanism | Count | Task IDs | Definition |\n|---|---|---|---|\n| Budget exhaustion | 1 | a_1 | x |\n| Wrong fix site, misdiagnosis | 1 | c_3 | y |\n";
  const known = new Set(["a_1", "b_2", "c_3"]);
  const tax = parseTaxonomy(md, known);
  expect(tax).toEqual({ a_1: ["budget"], c_3: ["misdiagnosis"] });
  // a_1 is solved in a second draw, so half of it counts as expected recoverable.
  const t = tallyClasses([
    { res: { a_1: false, b_2: true, c_3: false }, failCls: tax },
    { res: { a_1: true, b_2: true, c_3: false }, failCls: {} },
  ]);
  expect(t.taskDraws).toBe(6);
  expect(t.classes.budget).toEqual({ fails: 1, onSolvable: 1, expRecoverable: 0.5 });
  expect(t.classes.misdiagnosis).toEqual({ fails: 1, onSolvable: 0, expRecoverable: 0 });
});

test("loadTaskExchanges refuses a trajectory with an invalid exchange instead of analysing it with a hole", () => {
  const { loadTaskExchanges } = require("./frontier");
  const d = mkdtempSync(join(tmpdir(), "frontier-load-"));
  try {
    const good = (seq: number) => ({ seq, status: 200, request: { messages: [{ role: "user", content: "q" }] }, response: { choices: [{ message: { role: "assistant", content: "a" } }] } });
    const write = (rows: any[]) => {
      writeFileSync(join(d, "task-k1.jsonl.gz"), Bun.gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n")));
      writeFileSync(join(d, "manifest.json"), JSON.stringify({ k1: { instances: ["t1"] } })); fillManifest(d);
    };
    write([good(2), good(1)]);
    expect(loadTaskExchanges(d, "t1").map((e: any) => e.seq)).toEqual([1, 2]);
    write([good(1), { ...good(2), status: 500 }]);
    expect(() => loadTaskExchanges(d, "t1")).toThrow(/seq 2: HTTP 500/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("loadTaskExchanges refuses a missing listed archive and an archive short of the manifest's count", () => {
  const { loadTaskExchanges } = require("./frontier");
  const d = mkdtempSync(join(tmpdir(), "frontier-load-"));
  try {
    const good = (seq: number) => ({ seq, status: 200, request: { messages: [{ role: "user", content: "q" }] }, response: { choices: [{ message: { role: "assistant", content: "a" } }] } });
    const gz = (rows: any[]) => Bun.gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n"));
    writeFileSync(join(d, "task-k1.jsonl.gz"), gz([good(1)]));
    writeFileSync(join(d, "task-k2.jsonl.gz"), gz([good(2)]));
    writeFileSync(join(d, "manifest.json"), JSON.stringify({ k1: { instances: ["t1"], exchanges: 1 }, k2: { instances: ["t1"], exchanges: 1 } })); fillManifest(d);
    expect(loadTaskExchanges(d, "t1").map((e: any) => e.seq)).toEqual([1, 2]);
    rmSync(join(d, "task-k2.jsonl.gz"));
    expect(() => loadTaskExchanges(d, "t1")).toThrow(/do(es)? not exist/);
    writeFileSync(join(d, "task-k2.jsonl.gz"), gz([good(2)]));
    writeFileSync(join(d, "manifest.json"), JSON.stringify({ k1: { instances: ["t1"], exchanges: 1 }, k2: { instances: ["t1"], exchanges: 3 } })); fillManifest(d);
    expect(() => loadTaskExchanges(d, "t1")).toThrow(/1 line\(s\), manifest says 3/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("loadRows refuses the whole results file on a malformed, id-less, non-scalar-id or duplicate row, naming the line", () => {
  const { loadRows } = require("./frontier");
  const d = mkdtempSync(join(tmpdir(), "frontier-rows-"));
  const w = (s: string) => writeFileSync(join(d, "task_results.jsonl"), s);
  try {
    w('{"instance_id":"a","resolved":true}\n{"instance_id":"b","resolved":false}\n');
    expect(loadRows(d).length).toBe(2);
    w('{"instance_id":"a","resolved":0}\n{not json\n');
    expect(() => loadRows(d)).toThrow(/line 2: not JSON/);
    w('{"instance_id":"a","resolved":0}\n{"resolved":true}\n');
    expect(() => loadRows(d)).toThrow(/line 2: no task id/);
    w('{"instance_id":{"x":1}}\n');
    expect(() => loadRows(d)).toThrow(/line 1: task id .* is not a string or number/);
    w('{"instance_id":"a","resolved":0}\n{"instance_id":"a","resolved":0}\n');
    expect(() => loadRows(d)).toThrow(/line 2: task id "a" repeats line 1/);
    // a row still being written (no newline yet) is skipped only when the caller says the run is in progress
    w('{"instance_id":"a","resolved":0}\n{"instance_id":"b","res');
    expect(() => loadRows(d)).toThrow(/line 2: not JSON/);
    expect(loadRows(d, { partialTail: true }).length).toBe(1);
    // the outcome is read exactly as the sealed reader reads it: 1/0 are outcomes, anything else is refused
    for (const bad of ['"yes"', "2", "null"]) { w(`{"instance_id":"a","resolved":${bad}}\n`); expect(() => loadRows(d)).toThrow(/line 1: "resolved" must be true\/false or 1\/0/); }
    w('{"instance_id":"a"}\n');
    expect(() => loadRows(d)).toThrow(/"resolved" must be/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
