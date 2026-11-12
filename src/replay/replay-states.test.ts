import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { fillManifest } from "../capture/test-fixture";

test("replay-states: control vs a prompt arm, with a user-supplied classifier", async () => {
  const d = mkdtempSync(join(tmpdir(), "replay-states-"));
  const req = { messages: [{ role: "system", content: "Base prompt. <<ANCHOR>>" }, { role: "user", content: "go" }], tools: [] };
  const snaps = [1, 2].map((seq) => ({ seq, status: 200, request: req, response: { choices: [{ message: { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "search", arguments: '{"q":1}' } }] } }] } }));
  mkdirSync(join(d, "c1", "capture"), { recursive: true });
  writeFileSync(join(d, "c1", "capture", "task-g1.jsonl.gz"), gzipSync(snaps.map((s) => JSON.stringify(s)).join("\n")));
  writeFileSync(join(d, "c1", "capture", "manifest.json"), JSON.stringify({ g1: {} })); fillManifest(join(d, "c1", "capture"));
  writeFileSync(join(d, "states.jsonl"), JSON.stringify({ corpus: "c1", run: "r1", group: "g1", seq: 1, flagged: true, fingerprint: "f", outcome: "fail" }) + "\n");
  writeFileSync(join(d, "anchor.txt"), "<<ANCHOR>>");
  writeFileSync(join(d, "arm.md"), "Use the browser.");
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(r) {
      const b: any = await r.json();
      const browse = String(b.messages[0].content).includes("browser");
      return Response.json({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: browse ? "browse" : "search", arguments: browse ? '{"u":2}' : '{"q":1}' } }] } }] });
    },
  });
  try {
    const p = Bun.spawn(["bun", join(import.meta.dir, "replay-states.ts"), "--states-file", join(d, "states.jsonl"), "--capture-root", d,
      "--anchor-file", join(d, "anchor.txt"), "--arms", join(d, "arm.md"), "--kinds", "onset", "--n", "2", "--pool", "2",
      "--base", `http://127.0.0.1:${server.port}`, "--out", join(d, "out", "r.jsonl"), "--classifier", join(import.meta.dir, "../../examples/classify-next-call.ts")], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(err).toBe("");
    expect(code).toBe(0);
    const recs = readFileSync(join(d, "out", "r.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(recs.filter((r) => r.arm === "control").map((r) => r.next)).toEqual(["repeat", "repeat"]); // same args as the onset
    expect(recs.filter((r) => r.arm === "arm").map((r) => r.next)).toEqual(["browse", "browse"]);
    expect(out).toContain("states: 0 entry, 1 onset, 0 retry");
  } finally { server.stop(true); }
});

test("replay-states: the retry after an onset is the run's next call even when it sits in another capture group", async () => {
  const d = mkdtempSync(join(tmpdir(), "replay-states-groups-"));
  const snap = (seq: number) => ({ seq, status: 200, request: { messages: [{ role: "user", content: "go" }], tools: [] }, response: { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "search", arguments: `{"s":${seq}}` } }] } }] } });
  mkdirSync(join(d, "c1", "capture"), { recursive: true });
  const gz = (seqs: number[]) => gzipSync(seqs.map((q) => JSON.stringify(snap(q))).join("\n"));
  writeFileSync(join(d, "c1", "capture", "task-gA.jsonl.gz"), gz([10, 12]));
  writeFileSync(join(d, "c1", "capture", "task-gB.jsonl.gz"), gz([11]));
  writeFileSync(join(d, "c1", "capture", "manifest.json"), JSON.stringify({ gA: {}, gB: {} })); fillManifest(join(d, "c1", "capture"));
  writeFileSync(join(d, "states.jsonl"), [
    { corpus: "c1", run: "r1", group: "gA", seq: 10, flagged: true, fingerprint: "a", outcome: "fail" },
    { corpus: "c1", run: "r1", group: "gB", seq: 11, flagged: false, fingerprint: "b", outcome: "fail" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "search", arguments: "{}" } }] } }] }) });
  try {
    const p = Bun.spawn(["bun", join(import.meta.dir, "replay-states.ts"), "--states-file", join(d, "states.jsonl"), "--capture-root", d,
      "--kinds", "onset,retry", "--n", "1", "--pool", "1", "--base", `http://127.0.0.1:${server.port}`, "--out", join(d, "out", "r.jsonl")], { stdout: "pipe", stderr: "pipe" });
    const [, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(err).toBe("");
    expect(code).toBe(0);
    const recs = readFileSync(join(d, "out", "r.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect([...new Set(recs.filter((r) => r.kind === "retry").map((r) => r.seq))]).toEqual([11]);
  } finally { server.stop(true); }
});

test("replay-states: a seq that appears in two groups of one run is refused as one broken trajectory", async () => {
  const d = mkdtempSync(join(tmpdir(), "replay-states-dup-"));
  const snap = (seq: number) => ({ seq, status: 200, request: { messages: [{ role: "user", content: "go" }] }, response: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "x" } }] } });
  mkdirSync(join(d, "c1", "capture"), { recursive: true });
  writeFileSync(join(d, "c1", "capture", "task-gA.jsonl.gz"), gzipSync(JSON.stringify(snap(5))));
  writeFileSync(join(d, "c1", "capture", "task-gB.jsonl.gz"), gzipSync(JSON.stringify(snap(5))));
  writeFileSync(join(d, "c1", "capture", "manifest.json"), JSON.stringify({ gA: {}, gB: {} })); fillManifest(join(d, "c1", "capture"));
  writeFileSync(join(d, "states.jsonl"), [
    { corpus: "c1", run: "r1", group: "gA", seq: 5, flagged: true, fingerprint: "a", outcome: "fail" },
    { corpus: "c1", run: "r1", group: "gB", seq: 5, flagged: false, fingerprint: "b", outcome: "fail" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const p = Bun.spawn(["bun", join(import.meta.dir, "replay-states.ts"), "--states-file", join(d, "states.jsonl"), "--capture-root", d,
    "--kinds", "onset", "--base", "http://127.0.0.1:9", "--out", join(d, "out", "r.jsonl")], { stdout: "pipe", stderr: "pipe" });
  const [, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(code).not.toBe(0);
  expect(err).toMatch(/seq 5/);
});

test("replay-states: a group holding only ambiguous rows still belongs to the run, so the true next call is the retry", async () => {
  const d = mkdtempSync(join(tmpdir(), "replay-states-amb-"));
  const snap = (seq: number) => ({ seq, status: 200, request: { messages: [{ role: "user", content: "go" }], tools: [] }, response: { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "search", arguments: `{"s":${seq}}` } }] } }] } });
  mkdirSync(join(d, "c1", "capture"), { recursive: true });
  const gz = (seqs: number[]) => gzipSync(seqs.map((q) => JSON.stringify(snap(q))).join("\n"));
  writeFileSync(join(d, "c1", "capture", "task-gA.jsonl.gz"), gz([1, 3]));
  writeFileSync(join(d, "c1", "capture", "task-gB.jsonl.gz"), gz([2]));
  writeFileSync(join(d, "c1", "capture", "manifest.json"), JSON.stringify({ gA: {}, gB: {} })); fillManifest(join(d, "c1", "capture"));
  writeFileSync(join(d, "states.jsonl"), [
    { corpus: "c1", run: "r1", group: "gA", seq: 1, flagged: true, fingerprint: "a", outcome: "fail" },
    { corpus: "c1", run: "r1", group: "gB", seq: 2, flagged: false, fingerprint: "b", outcome: "fail", ambiguous: true },
    { corpus: "c1", run: "r1", group: "gA", seq: 3, flagged: false, fingerprint: "c", outcome: "fail" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "search", arguments: "{}" } }] } }] }) });
  try {
    const p = Bun.spawn(["bun", join(import.meta.dir, "replay-states.ts"), "--states-file", join(d, "states.jsonl"), "--capture-root", d,
      "--kinds", "onset,retry", "--n", "1", "--pool", "1", "--base", `http://127.0.0.1:${server.port}`, "--out", join(d, "out", "r.jsonl")], { stdout: "pipe", stderr: "pipe" });
    const [, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(err).toBe("");
    expect(code).toBe(0);
    const recs = readFileSync(join(d, "out", "r.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect([...new Set(recs.filter((r) => r.kind === "retry").map((r) => r.seq))]).toEqual([2]);
  } finally { server.stop(true); }
});

test("replay-states: duplicate arm names and bad sampling arms are usage errors before any output", () => {
  const d = mkdtempSync(join(tmpdir(), "replay-states-arms-"));
  writeFileSync(join(d, "states.jsonl"), "");
  mkdirSync(join(d, "a"), { recursive: true }); mkdirSync(join(d, "b"), { recursive: true });
  writeFileSync(join(d, "a", "x.md"), "A"); writeFileSync(join(d, "b", "x.md"), "B");
  const run = (extra: string[]) => {
    const out = join(d, `out-${Math.random().toString(36).slice(2)}`, "r.jsonl");
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "replay-states.ts"), "--states-file", join(d, "states.jsonl"), "--capture-root", d, "--out", out, ...extra]);
    return { code: p.exitCode, err: p.stderr.toString(), made: require("node:fs").existsSync(require("node:path").dirname(out)) };
  };
  const cases: [string[], RegExp][] = [
    [["--sampling-arms", "hot:temperature=0;hot:temperature=1"], /unique.*hot/],
    [["--sampling-arms", "control:temperature=1"], /unique.*control/],
    [["--arms", `${join(d, "a", "x.md")},${join(d, "b", "x.md")}`], /unique.*x/],
    [["--arms", join(d, "a", "x.md"), "--sampling-arms", "x:temperature=1"], /unique.*x/],
    [["--sampling-arms", "t:temperature=abc"], /finite number/],
    [["--sampling-arms", "t:temperature=Infinity"], /finite number/],
    [["--sampling-arms", "t:temp-x=1"], /parameter name/],
    [["--sampling-arms", "t:temperature=1,temperature=2"], /given twice/],
    [["--sampling-arms", "notanarm"], /name:key=value/],
  ];
  for (const [extra, re] of cases) {
    const r = run(extra);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(re);
    expect(r.made).toBe(false);
  }
});

test("replay-states: --kinds must name known kinds, checked before any output", () => {
  const d = mkdtempSync(join(tmpdir(), "replay-states-kinds-"));
  writeFileSync(join(d, "states.jsonl"), "");
  for (const k of ["onsett", "", "onset,", "onset,bogus"]) {
    const out = join(d, `out-${Math.random().toString(36).slice(2)}`, "r.jsonl");
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "replay-states.ts"), "--states-file", join(d, "states.jsonl"), "--capture-root", d, "--out", out, "--kinds", k]);
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain("--kinds");
    expect(require("node:fs").existsSync(require("node:path").dirname(out))).toBe(false);
  }
});

test("replay-states: an entry state is cut from its run's whole validated trajectory, so a broken exchange in another group rejects it", async () => {
  const d = mkdtempSync(join(tmpdir(), "replay-states-entry-"));
  const good = (seq: number) => ({ seq, status: 200, request: { messages: [{ role: "user", content: "go" }] }, response: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }] } });
  const broken = (seq: number) => ({ seq, status: 500, request: { messages: [{ role: "user", content: "go" }] }, response: { error: { message: "boom" } } });
  mkdirSync(join(d, "c1", "capture"), { recursive: true });
  writeFileSync(join(d, "c1", "capture", "task-gA.jsonl.gz"), gzipSync(JSON.stringify(good(1))));
  writeFileSync(join(d, "c1", "capture", "task-gB.jsonl.gz"), gzipSync(JSON.stringify(broken(2))));
  writeFileSync(join(d, "c1", "capture", "manifest.json"), JSON.stringify({ gA: {}, gB: {} })); fillManifest(join(d, "c1", "capture"));
  writeFileSync(join(d, "states.jsonl"), [
    { corpus: "c1", run: "r1", group: "gA", seq: 1, flagged: false, fingerprint: "a", outcome: "success" },
    { corpus: "c1", run: "r1", group: "gB", seq: 2, flagged: false, fingerprint: "b", outcome: "fail", ambiguous: true },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  let hits = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { hits++; return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "x" } }] }); } });
  try {
    const p = Bun.spawn(["bun", join(import.meta.dir, "replay-states.ts"), "--states-file", join(d, "states.jsonl"), "--capture-root", d,
      "--kinds", "entry", "--entry", "5", "--n", "1", "--pool", "1", "--base", `http://127.0.0.1:${server.port}`, "--out", join(d, "out", "r.jsonl")], { stdout: "pipe", stderr: "pipe" });
    const [, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code).not.toBe(0);
    expect(err).toMatch(/run c1\/r1/);
    expect(hits).toBe(0);
    expect(require("node:fs").existsSync(join(d, "out", "r.jsonl"))).toBe(false);
  } finally { server.stop(true); }
});

test("replay-states: an entry whose seq is not in the group the index names is refused before any call", async () => {
  const d = mkdtempSync(join(tmpdir(), "replay-states-entry-grp-"));
  const good = (seq: number) => ({ seq, status: 200, request: { messages: [{ role: "user", content: "go" }] }, response: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }] } });
  mkdirSync(join(d, "c1", "capture"), { recursive: true });
  writeFileSync(join(d, "c1", "capture", "task-gA.jsonl.gz"), gzipSync(JSON.stringify(good(1))));
  writeFileSync(join(d, "c1", "capture", "task-gB.jsonl.gz"), gzipSync(JSON.stringify(good(2))));
  writeFileSync(join(d, "c1", "capture", "manifest.json"), JSON.stringify({ gA: {}, gB: {} })); fillManifest(join(d, "c1", "capture"));
  writeFileSync(join(d, "states.jsonl"), [
    { corpus: "c1", run: "r1", group: "gB", seq: 1, flagged: false, fingerprint: "a", outcome: "success" },
    { corpus: "c1", run: "r1", group: "gA", seq: 2, flagged: false, fingerprint: "b", outcome: "fail", ambiguous: true },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const p = Bun.spawn(["bun", join(import.meta.dir, "replay-states.ts"), "--states-file", join(d, "states.jsonl"), "--capture-root", d,
    "--kinds", "entry", "--base", "http://127.0.0.1:9", "--out", join(d, "out", "r.jsonl")], { stdout: "pipe", stderr: "pipe" });
  const [, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(code).toBe(1);
  expect(err).toMatch(/seq 1 is not in capture group gB|the index lists seq \d+ for run c1\/r1, but the capture has no such exchange/);
});

test("replay-states: a states index with a numeric run or a duplicate row is refused before anything is selected", () => {
  const d = mkdtempSync(join(tmpdir(), "replay-states-ids-"));
  const run = (rows: any[]) => {
    writeFileSync(join(d, "states.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "replay-states.ts"), "--states-file", join(d, "states.jsonl"), "--capture-root", d,
      "--kinds", "onset", "--base", "http://127.0.0.1:9", "--out", join(d, "out", "r.jsonl")]);
    return { code: p.exitCode, err: p.stderr.toString() };
  };
  const row = { corpus: "c1", run: "r1", group: "g", seq: 1, flagged: true, fingerprint: "a", outcome: "fail" };
  let r = run([row, { ...row, run: 1, seq: 2 }]);
  expect(r.code).toBe(1); expect(r.err).toMatch(/"run" must be a non-empty string/);
  r = run([row, { ...row }]);
  expect(r.code).toBe(1); expect(r.err).toMatch(/appears twice/);
});
