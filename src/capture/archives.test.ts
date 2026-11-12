import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestArchives, manifestArchive } from "./archives";

const gz = (s: string) => Bun.gzipSync(Buffer.from(s));

test("manifestArchives lists exactly the manifest's archives and refuses strays, missing files and unsafe keys", () => {
  const d = mkdtempSync(join(tmpdir(), "archives-"));
  try {
    expect(manifestArchives(d)).toEqual([]);
    writeFileSync(join(d, "task-b.jsonl.gz"), gz("{}\n"));
    expect(() => manifestArchives(d)).toThrow(/not in manifest\.json \(task-b\.jsonl\.gz\)/);
    writeFileSync(join(d, "task-a.jsonl.gz"), gz("{}\n"));
    writeFileSync(join(d, "manifest.json"), JSON.stringify({ b: {}, a: {} }));
    expect(manifestArchives(d).map((a) => a.name)).toEqual(["task-a.jsonl.gz", "task-b.jsonl.gz"]);
    expect(manifestArchive(d, "a")).toBe(join(d, "task-a.jsonl.gz"));
    expect(() => manifestArchive(d, "c")).toThrow(/does not list/);
    writeFileSync(join(d, "manifest.json"), JSON.stringify({ a: {}, b: {}, c: {} }));
    expect(() => manifestArchives(d)).toThrow(/do not exist \(task-c\.jsonl\.gz\)/);
    writeFileSync(join(d, "manifest.json"), JSON.stringify({ a: {}, b: {}, "../x": {} }));
    expect(() => manifestArchives(d)).toThrow(/not safe archive names/);
    writeFileSync(join(d, "manifest.json"), "[]");
    expect(() => manifestArchives(d)).toThrow(/not a JSON object/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- round 15: one archive holding several tasks' exchanges ----
import { snapTask, taskSnaps, manifestArchives as listArchives } from "./archives";
import { fillManifest as fillM } from "./test-fixture";
import { loadSteps as loadForkSteps } from "../replay/fork-run-steps";
import { loadTaskExchanges as loadFrontier } from "../analysis/frontier";
import { capturedTaskIds as coveredIds } from "../integrity/run-end";

function sharedArchiveRun(seqTasks: Record<string, string> | null): string {
  const { mkdtempSync: mk, mkdirSync: md, writeFileSync: wf } = require("node:fs");
  const { tmpdir: td } = require("node:os");
  const { join: j } = require("node:path");
  const dir = mk(j(td(), "multi-task-"));
  md(j(dir, "capture"));
  const ex = (seq: number, who: string) => ({ seq, status: 200, at: `2026-01-01T00:00:0${seq}Z`, request: { messages: [{ role: "user", content: "shared head" }] }, response: { choices: [{ message: { role: "assistant", content: who } }] } });
  wf(j(dir, "capture", "task-g1.jsonl.gz"), Bun.gzipSync(Buffer.from([ex(1, "A"), ex(2, "B"), ex(3, "A")].map((r) => JSON.stringify(r)).join("\n") + "\n")));
  wf(j(dir, "capture", "manifest.json"), JSON.stringify({ g1: { instances: ["A", "B"], ...(seqTasks ? { seq_tasks: seqTasks } : {}) } }));
  fillM(j(dir, "capture"));
  return dir;
}

test("an archive spanning two tasks yields each task exactly its own exchanges, everywhere", () => {
  const { rmSync: rm } = require("node:fs");
  const { join: j } = require("node:path");
  const dir = sharedArchiveRun({ "1": "A", "2": "B", "3": "A" });
  try {
    expect(taskSnaps(listArchives(j(dir, "capture")), "A").map((s) => s.seq)).toEqual([1, 3]);
    expect(taskSnaps(listArchives(j(dir, "capture")), "B").map((s) => s.seq)).toEqual([2]);
    expect(loadForkSteps(dir, "A").map((s) => s.seq)).toEqual([1, 3]);
    expect(loadForkSteps(dir, "B").map((s) => s.seq)).toEqual([2]);
    expect(loadFrontier(j(dir, "capture"), "B").map((s: any) => s.seq)).toEqual([2]);
    expect([...coveredIds(dir)].sort()).toEqual(["A", "B"]);
  } finally { rm(dir, { recursive: true, force: true }); }
});

test("an archive listing several tasks with no per-seq map is refused, and covers none of them", () => {
  const { rmSync: rm } = require("node:fs");
  const { join: j } = require("node:path");
  const dir = sharedArchiveRun(null);
  try {
    expect(() => taskSnaps(listArchives(j(dir, "capture")), "A")).toThrow(/no per-seq attribution/);
    expect(() => loadForkSteps(dir, "B")).toThrow(/re-run capture-attribute/);
    expect(() => loadFrontier(j(dir, "capture"), "A")).toThrow(/no per-seq attribution/);
    expect(coveredIds(dir).size).toBe(0);
  } finally { rm(dir, { recursive: true, force: true }); }
});

test("a per-seq map leaving a snapshot out excludes it; frontier refuses a task with no exchanges", () => {
  const { rmSync: rm } = require("node:fs");
  const { join: j } = require("node:path");
  const dir = sharedArchiveRun({ "1": "A", "3": "A" });
  try {
    expect(snapTask({ instances: ["A"], seq_tasks: { "1": "A" } }, { seq: 2 })).toBeNull();
    expect(snapTask({ instances: ["A"] }, { seq: 2 })).toBe("A");
    expect(snapTask({ instances: ["A", "B"], seq_tasks: { "2": "B" } }, { seq: 2, task_id: "X" })).toBe("X");
    expect(taskSnaps(listArchives(j(dir, "capture")), "A").map((s) => s.seq)).toEqual([1, 3]);
    expect(() => loadFrontier(j(dir, "capture"), "B")).toThrow(/no captured exchange is attributed/);
    expect(() => loadFrontier(j(dir, "nope"), "B")).toThrow(/compact and attribute/);
    expect([...coveredIds(dir)]).toEqual(["A"]);
  } finally { rm(dir, { recursive: true, force: true }); }
});
