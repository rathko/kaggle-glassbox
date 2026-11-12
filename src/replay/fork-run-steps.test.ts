import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSteps, invalidReasons } from "./fork-run-steps";
import { fillManifest } from "../capture/test-fixture";

function makeSourceRun(): string {
  const dir = mkdtempSync(join(tmpdir(), "fork-steps-"));
  mkdirSync(join(dir, "capture"));
  const rows = [
    { seq: 2, status: 200, at: "2026-01-01T00:00:02Z", request: { messages: [{ role: "user", content: "x" }] }, response: { choices: [{ message: { role: "assistant", content: "a" } }] } },
    { seq: 1, status: 200, at: "2026-01-01T00:00:01Z", request: { messages: [{ role: "user", content: "x" }] }, response: { choices: [{ message: { role: "assistant", content: "a" } }] } },
  ];
  writeFileSync(join(dir, "capture", "task-k1.jsonl.gz"), Bun.gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n")));
  writeFileSync(join(dir, "capture", "task-k2.jsonl.gz"), Bun.gzipSync(Buffer.from(JSON.stringify({ ...rows[0], seq: 3 }) + "\n")));
  writeFileSync(join(dir, "capture", "manifest.json"), JSON.stringify({ k1: { instances: ["t1"] }, k2: { instances: ["t2"] } })); fillManifest(join(dir, "capture"));
  return dir;
}

test("loads a task's captured steps across its groups, sorted by seq", () => {
  const dir = makeSourceRun();
  try {
    const steps = loadSteps(dir, "t1");
    expect(steps.map((s) => s.seq)).toEqual([1, 2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("throws when no capture group is attributed to the requested task alone", () => {
  const dir = makeSourceRun();
  try {
    expect(() => loadSteps(dir, "does-not-exist")).toThrow(/no captured exchange attributed to does-not-exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readOutcome: JSON, JSON array or JSONL; the task's own row; common truthy spellings", async () => {
  const { readOutcome } = await import("./fork-run-steps");
  expect(readOutcome(`{"instance_id":"a","resolved":true}\n`, "a", "instance_id", "resolved")).toBe(true);
  expect(readOutcome(`{"id":"x","ok":0}\n{"id":"a","ok":1}\n`, "a", "id", "ok")).toBe(true);
  expect(readOutcome(`[{"task":"a","status":"passed"}]`, "a", "task", "status")).toBe(true);
  expect(readOutcome(`{"task":"a","status":"failed"}`, "a", "task", "status")).toBe(false);
  expect(readOutcome(`{"task":"a","status":"timeout"}`, "a", "task", "status")).toBeNull(); // unknown is not "failed"
  expect(readOutcome(`{"id":"x","ok":1}\n{"id":"y","ok":1}\n`, "a", "id", "ok")).toBeNull(); // no row for task a
  expect(readOutcome(`{"ok":1}`, "a", "id", "ok")).toBe(true); // a single row with no task field is the task's row
  expect(readOutcome(`{"id":"x","ok":1}`, "a", "id", "ok")).toBeNull(); // a single row naming ANOTHER task is not
  expect(readOutcome(`{"instance_id":"B","resolved":true}`, "A", "instance_id", "resolved")).toBeNull();
  expect(readOutcome(`{"task":"a"}`, "a", "task", "status")).toBeNull(); // missing field is not "failed"
  expect(readOutcome(``, "a", "task", "status")).toBeNull();
  expect(readOutcome(`not json`, "a", "task", "status")).toBeNull();
});

test("refuses a task whose capture holds an invalid stream, naming its seq", () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-steps-"));
  mkdirSync(join(dir, "capture"));
  const rows = [
    { seq: 1, status: 200, request: { messages: [{ role: "user", content: "x" }] }, response: { choices: [{ message: { role: "assistant", content: "a" } }] } },
    { seq: 2, status: 200, request: { messages: [{ role: "user", content: "x" }] }, response: { choices: [{ message: { role: "assistant", content: "a" } }], stream_invalid: true } },
  ];
  writeFileSync(join(dir, "capture", "task-k1.jsonl.gz"), Bun.gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n")));
  writeFileSync(join(dir, "capture", "manifest.json"), JSON.stringify({ k1: { instances: ["t1"] } })); fillManifest(join(dir, "capture"));
  try {
    expect(() => loadSteps(dir, "t1")).toThrow(/seq 2: invalid stream/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rollout is valid only with exit 0, a readable outcome, all K steps forced and none diverged", () => {
  expect(invalidReasons({ rc: 0, outcome: true, forced: 3, divergent: 0 }, 3)).toEqual([]);
  expect(invalidReasons({ rc: 0, outcome: false, forced: 3, divergent: 0 }, 3)).toEqual([]);
  // a solve on a diverged rebuild is not a solve of the forked state
  expect(invalidReasons({ rc: 0, outcome: true, forced: 3, divergent: 1 }, 3)).toEqual(["1 forced step(s) diverged"]);
  expect(invalidReasons({ rc: 2, outcome: true, forced: 3, divergent: 0 }, 3)).toEqual(["harness exit 2"]);
  expect(invalidReasons({ rc: 0, outcome: true, forced: 1, divergent: 0 }, 3)).toEqual(["forced 1 of 3 captured steps"]);
  expect(invalidReasons({ rc: 0, outcome: null, forced: 3, divergent: 0 }, 3)).toEqual(["no readable outcome"]);
});

test("a non-2xx, errored or choiceless exchange refuses the whole trajectory instead of being dropped", () => {
  const u = { messages: [{ role: "user", content: "x" }] };
  for (const [bad, why] of [
    [{ seq: 1, status: 500, request: u, response: { error: { message: "boom" } } }, /seq 1: HTTP 500, error in response, no choices/],
    [{ seq: 1, status: 200, request: u, response: { choices: [] } }, /seq 1: no choices/],
    [{ seq: 1, status: 429, request: u, response: { choices: [{}] } }, /seq 1: HTTP 429/],
    [{ seq: 1, status: 200, request: u, response: { choices: [{}] } }, /seq 1: choice 0 has no message/],
    [{ seq: 1, status: 200, request: u, response: { choices: [{ message: { role: "assistant", content: 5 } }] } }, /seq 1: choice 0 content is neither text nor null/],
    [{ seq: 1, status: 200, request: u, response: { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: {} }] } }] } }, /seq 1: choice 0 has a malformed tool call/],
  ] as const) {
    const dir = mkdtempSync(join(tmpdir(), "fork-steps-"));
    mkdirSync(join(dir, "capture"));
    // an HTTP 500 followed by an identical-history retry: dropping the 500 would renumber the retry as step 1
    const rows = [bad, { seq: 2, status: 200, request: u, response: { choices: [{ message: { role: "assistant", content: "ok" } }] } }];
    writeFileSync(join(dir, "capture", "task-k1.jsonl.gz"), Bun.gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n")));
    writeFileSync(join(dir, "capture", "manifest.json"), JSON.stringify({ k1: { instances: ["t1"] } })); fillManifest(join(dir, "capture"));
    try { expect(() => loadSteps(dir, "t1")).toThrow(why); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("assertValidCaptures refuses a missing, non-positive or repeated seq (seq is the step order)", () => {
  const { assertValidCaptures } = require("./capture-valid");
  const ok = (seq: any) => ({ seq, status: 200, request: { messages: [{ role: "user", content: "q" }] }, response: { choices: [{ message: { role: "assistant", content: "a" } }] } });
  expect(() => assertValidCaptures([ok(1), ok(2)], "t")).not.toThrow();
  expect(() => assertValidCaptures([ok(1), ok(1)], "t")).toThrow(/duplicate seq/);
  expect(() => assertValidCaptures([ok(0)], "t")).toThrow(/positive whole number/);
  expect(() => assertValidCaptures([ok(undefined)], "t")).toThrow(/positive whole number/);
  expect(() => assertValidCaptures([ok(2.5)], "t")).toThrow(/positive whole number/);
});

test("readOutcome: two rows for the task are unknowable (null), even if one says solved", async () => {
  const { readOutcome } = await import("./fork-run-steps");
  const dup = `{"instance_id":"T1","resolved":true}\n{"instance_id":"T1","resolved":false}\n`;
  expect(readOutcome(dup, "T1", "instance_id", "resolved")).toBeNull();
  expect(readOutcome(`{"instance_id":"T1","resolved":true}\n{"instance_id":"T2","resolved":false}\n`, "T1", "instance_id", "resolved")).toBe(true);
});

test("readOutcome: a numeric outcome needs a threshold; with one, >= T solves and below misses", async () => {
  const { readOutcome } = await import("./fork-run-steps");
  const row = (v: unknown) => JSON.stringify({ instance_id: "a", reward: v });
  expect(readOutcome(row(0.73), "a", "instance_id", "reward")).toBeNull();
  expect(readOutcome(row(0.73), "a", "instance_id", "reward", 0.5)).toBe(true);
  expect(readOutcome(row(0.2), "a", "instance_id", "reward", 0.5)).toBe(false);
  expect(readOutcome(row("0.9"), "a", "instance_id", "reward", 0.5)).toBe(true);
  expect(readOutcome(row(true), "a", "instance_id", "reward", 0.5)).toBe(true);
  expect(readOutcome(row("n/a"), "a", "instance_id", "reward", 0.5)).toBeNull();
  expect(readOutcome(row(null), "a", "instance_id", "reward", 0.5)).toBeNull();
});

test("loadSteps refuses an archive that disagrees with its manifest entry (a truncated trajectory)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-steps-trunc-"));
  mkdirSync(join(dir, "capture"));
  const row = (seq: number) => ({ seq, status: 200, request: { messages: [{ role: "user", content: "x" }] }, response: { choices: [{ index: 0, message: { role: "assistant", content: "a" } }] } });
  writeFileSync(join(dir, "capture", "task-k1.jsonl.gz"), Bun.gzipSync(Buffer.from(JSON.stringify(row(1)) + "\n")));
  try {
    writeFileSync(join(dir, "capture", "manifest.json"), JSON.stringify({ k1: { instances: ["t1"], exchanges: 2, seq_first: 1, seq_last: 2 } }));
    expect(() => loadSteps(dir, "t1")).toThrow(/1 line\(s\), manifest says 2/);
    writeFileSync(join(dir, "capture", "manifest.json"), JSON.stringify({ k1: { instances: ["t1"] } }));
    expect(() => loadSteps(dir, "t1")).toThrow(/manifest says undefined/);
    writeFileSync(join(dir, "capture", "manifest.json"), JSON.stringify({ k1: { instances: ["t1"], exchanges: 1, seq_first: 1, seq_last: 1 } }));
    expect(loadSteps(dir, "t1").map((s) => s.seq)).toEqual([1]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
