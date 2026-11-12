import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseChecks } from "./run-end";

const CLI = join(import.meta.dir, "run-end.ts");

test("parseChecks reads ok/fail with detail and requires rows and stack", () => {
  expect(parseChecks(["rows=ok", "stack=ok", "capture=fail:3 snapshots unparseable"])).toEqual({
    rows: { ok: true, detail: "" }, stack: { ok: true, detail: "" }, capture: { ok: false, detail: "3 snapshots unparseable" } });
  expect(() => parseChecks(["rows=ok"])).toThrow(/'stack' is missing/);
  expect(() => parseChecks(["rows=yes", "stack=ok"])).toThrow(/bad --check/);
  expect(() => parseChecks(["rows=ok", "rows=fail", "stack=ok"])).toThrow(/twice/);
});

test("the CLI writes the record once with an artifact hash, then refuses to overwrite it", () => {
  const d = mkdtempSync(join(tmpdir(), "run-end-"));
  writeFileSync(join(d, "task_results.jsonl"), `{"instance_id":"a","resolved":true}\n`);
  writeFileSync(join(d, "stack.json"), JSON.stringify({ model: "m", server: "s" }));
  const first = Bun.spawnSync(["bun", CLI, d, "--check", "rows=ok", "--check", "stack=ok", "--no-capture"]);
  expect(first.exitCode).toBe(0);
  const rec = JSON.parse(readFileSync(join(d, "instruments.runend.json"), "utf8"));
  expect(rec.artifact_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(Bun.spawnSync(["bun", CLI, d, "--check", "rows=ok", "--check", "stack=ok"]).exitCode).toBe(1);
});

test("the CLI refuses a run with no result rows or with missing required checks", () => {
  const d = mkdtempSync(join(tmpdir(), "run-end-"));
  expect(Bun.spawnSync(["bun", CLI, d, "--check", "rows=ok", "--check", "stack=ok"]).exitCode).toBe(1);
  writeFileSync(join(d, "task_results.jsonl"), "{}\n");
  expect(Bun.spawnSync(["bun", CLI, d, "--check", "rows=ok"]).exitCode).toBe(2);
  expect(existsSync(join(d, "instruments.runend.json"))).toBe(false);
});

test("stack=ok needs a readable stack.json, and raw snapshots in capture/ must be compacted first", () => {
  const d = mkdtempSync(join(tmpdir(), "run-end-"));
  writeFileSync(join(d, "task_results.jsonl"), `{"instance_id":"a","resolved":true}\n`);
  const go = () => Bun.spawnSync(["bun", CLI, d, "--check", "rows=ok", "--check", "stack=ok"]);
  let r = go();
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("no stack.json");
  writeFileSync(join(d, "stack.json"), "{not json");
  expect(go().stderr.toString()).toContain("stack.json does not parse");
  writeFileSync(join(d, "stack.json"), JSON.stringify({ model: "m" }));
  mkdirSync(join(d, "capture"));
  writeFileSync(join(d, "capture", "000001.json"), "{}");
  writeFileSync(join(d, "capture", "manifest.json"), "{}");
  r = go();
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("1 raw snapshot(s)");
  expect(existsSync(join(d, "instruments.runend.json"))).toBe(false);
  rmSync(join(d, "capture", "000001.json"));
  // an empty capture is refused unless waived on purpose
  expect(go().stderr.toString()).toContain("holds no exchange");
  expect(Bun.spawnSync(["bun", CLI, d, "--check", "rows=ok", "--check", "stack=ok", "--no-capture"]).exitCode).toBe(0);
  // a failed stack check needs no stack.json: the record then says the stack failed
  const f = mkdtempSync(join(tmpdir(), "run-end-"));
  writeFileSync(join(f, "task_results.jsonl"), "{}\n");
  expect(Bun.spawnSync(["bun", CLI, f, "--check", "rows=ok", "--check", "stack=fail:wrong image", "--no-capture"]).exitCode).toBe(0);
});

test("--artifact-only: needs a file in artifacts/ and the artifacts+stack checks; no task rows required", () => {
  const d = mkdtempSync(join(tmpdir(), "run-end-ao-"));
  writeFileSync(join(d, "stack.json"), "{}");
  const go = (...a: string[]) => Bun.spawnSync(["bun", CLI, d, ...a]);
  expect(go("--artifact-only", "--check", "artifacts=ok", "--check", "stack=ok").exitCode).toBe(1); // no artifacts/ yet
  mkdirSync(join(d, "artifacts"));
  writeFileSync(join(d, "artifacts", "submission.csv"), "id,y\n1,0.5\n");
  expect(go("--artifact-only", "--check", "rows=ok", "--check", "stack=ok").exitCode).toBe(2); // wrong required pair
  expect(go("--check", "artifacts=ok", "--check", "stack=ok").exitCode).toBe(2); // artifacts check without the flag
  // one close command serves a tabular pipeline and a platform-scored agent: it must say which (round 15)
  const silent = go("--artifact-only", "--check", "artifacts=ok", "--check", "stack=ok");
  expect(silent.exitCode).toBe(1);
  expect(silent.stderr.toString()).toContain("must say whether it was captured");
  expect(existsSync(join(d, "instruments.runend.json"))).toBe(false);
  expect(go("--artifact-only", "--no-capture", "--check", "artifacts=ok", "--check", "stack=ok").exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(d, "instruments.runend.json"), "utf8")).artifact_only).toBe(true);
});

test("--artifact-only --check capture=ok verifies the capture, and covers every task row when rows are kept", () => {
  const d = mkdtempSync(join(tmpdir(), "run-end-aoc-"));
  writeFileSync(join(d, "stack.json"), "{}");
  mkdirSync(join(d, "artifacts"));
  writeFileSync(join(d, "artifacts", "answers.csv"), "id,answer\nA,4\nB,7\n");
  const go = (...a: string[]) => Bun.spawnSync(["bun", CLI, d, "--artifact-only", "--check", "artifacts=ok", "--check", "stack=ok", "--check", "capture=ok", ...a]);
  expect(go().stderr.toString()).toContain("no capture/ directory");
  mkdirSync(join(d, "capture"));
  writeFileSync(join(d, "capture", "task-k1.jsonl.gz"), Bun.gzipSync(Buffer.from('{"status":200,"request":{"messages":[{"role":"user","content":"go"}]},"response":{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}]},"seq":1}\n')));
  writeFileSync(join(d, "capture", "manifest.json"), JSON.stringify({ k1: { exchanges: 1, seq_first: 1, seq_last: 1, task_id: "A", instances: ["A"] } }));
  // the agent kept its per-task rows: B has no captured exchange
  writeFileSync(join(d, "task_results.jsonl"), '{"instance_id":"A"}\n{"instance_id":"B"}\n');
  expect(go().stderr.toString()).toContain("1 of 2 task(s) have no captured exchange (B)");
  expect(go("--uncaptured-ok", "B").exitCode).toBe(0);
});

test("a symlink in artifacts/ is refused before any record is written", () => {
  const { symlinkSync } = require("node:fs");
  const d = mkdtempSync(join(tmpdir(), "run-end-ln-"));
  writeFileSync(join(d, "task_results.jsonl"), `{"instance_id":"a","resolved":true}\n`);
  writeFileSync(join(d, "stack.json"), "{}");
  mkdirSync(join(d, "artifacts"));
  symlinkSync("/etc/hostname", join(d, "artifacts", "model.bin"));
  const p = Bun.spawnSync(["bun", CLI, d, "--check", "rows=ok", "--check", "stack=ok"]);
  expect(p.exitCode).toBe(1);
  expect(p.stderr.toString()).toMatch(/symlink/);
  expect(existsSync(join(d, "instruments.runend.json"))).toBe(false);
});

test("a run with a capture/ directory needs a real capture: manifest, at least one exchange, no unlisted archive", () => {
  const mk = () => {
    const d = mkdtempSync(join(tmpdir(), "run-end-cap-"));
    writeFileSync(join(d, "task_results.jsonl"), `{"instance_id":"a","resolved":true}\n`);
    writeFileSync(join(d, "stack.json"), "{}");
    mkdirSync(join(d, "capture"));
    return d;
  };
  const go = (d: string, ...extra: string[]) => Bun.spawnSync(["bun", CLI, d, "--check", "rows=ok", "--check", "stack=ok", ...extra]);
  // a bypassed proxy: capture/ exists, nothing in it
  const empty = mk();
  expect(go(empty).stderr.toString()).toContain("no manifest.json");
  expect(go(empty, "--check", "capture=ok").exitCode).toBe(1);
  expect(existsSync(join(empty, "instruments.runend.json"))).toBe(false);
  // an explicit capture=fail is recorded as given (repairable), not refused
  expect(go(empty, "--check", "capture=fail:proxy down").exitCode).toBe(0);
  // a real capture gets a computed capture=ok
  const good = mk();
  writeFileSync(join(good, "capture", "task-k1.jsonl.gz"), Bun.gzipSync(Buffer.from('{"status":200,"request":{"messages":[{"role":"user","content":"go"}]},"response":{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}]},"seq":1}\n{"status":200,"request":{"messages":[{"role":"user","content":"go"}]},"response":{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}]},"seq":2}\n')));
  writeFileSync(join(good, "capture", "manifest.json"), JSON.stringify({ k1: { exchanges: 2, seq_first: 1, seq_last: 2, task_id: "a", instances: ["a"] } }));
  writeFileSync(join(good, "capture", "extra.jsonl.gz"), Bun.gzipSync(Buffer.from('{"status":200,"request":{"messages":[{"role":"user","content":"go"}]},"response":{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}]},"seq":3}\n')));
  expect(go(good).stderr.toString()).toContain("not in manifest.json (extra.jsonl.gz)");
  rmSync(join(good, "capture", "extra.jsonl.gz"));
  expect(go(good).exitCode).toBe(0);
  const rec = JSON.parse(readFileSync(join(good, "instruments.runend.json"), "utf8"));
  expect(rec.checks.capture).toEqual({ ok: true, detail: "2 exchange(s) in 1 archive(s)" });
  // an artifact-only run that declares --no-capture is exempt (its empty capture/ is not checked)
  const art = mk();
  mkdirSync(join(art, "artifacts"));
  writeFileSync(join(art, "artifacts", "sub.csv"), "x\n");
  expect(Bun.spawnSync(["bun", CLI, art, "--artifact-only", "--no-capture", "--check", "artifacts=ok", "--check", "stack=ok"]).exitCode).toBe(0);
});

test("capture=ok is computed from a line-by-line parse: a truncated or malformed archive is refused", () => {
  const mk = (lines: string, entry: object) => {
    const d = mkdtempSync(join(tmpdir(), "run-end-cap2-"));
    writeFileSync(join(d, "task_results.jsonl"), `{"instance_id":"a","resolved":true}\n`);
    writeFileSync(join(d, "stack.json"), "{}");
    mkdirSync(join(d, "capture"));
    writeFileSync(join(d, "capture", "task-k1.jsonl.gz"), Bun.gzipSync(Buffer.from(lines)));
    writeFileSync(join(d, "capture", "manifest.json"), JSON.stringify({ k1: entry }));
    return d;
  };
  const go = (d: string, ...extra: string[]) => Bun.spawnSync(["bun", CLI, d, "--check", "rows=ok", "--check", "stack=ok", ...extra]);
  // the manifest promises two exchanges, the archive holds one
  let r = go(mk('{"status":200,"request":{"messages":[{"role":"user","content":"go"}]},"response":{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}]},"seq":1}\n', { exchanges: 2, seq_first: 1, seq_last: 2 }));
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("1 line(s), manifest says 2");
  // a line that is not JSON, a duplicate seq, a non-positive seq, first/last disagreeing
  expect(go(mk('{"status":200,"request":{"messages":[{"role":"user","content":"go"}]},"response":{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}]},"seq":1}\nnope\n', { exchanges: 2, seq_first: 1, seq_last: 1 })).stderr.toString()).toContain("not JSON");
  expect(go(mk('{"status":200,"request":{"messages":[{"role":"user","content":"go"}]},"response":{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}]},"seq":1}\n{"status":200,"request":{"messages":[{"role":"user","content":"go"}]},"response":{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}]},"seq":1}\n', { exchanges: 2, seq_first: 1, seq_last: 1 })).stderr.toString()).toContain("seq 1 also in");
  expect(go(mk('{"status":200,"request":{"messages":[{"role":"user","content":"go"}]},"response":{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}]},"seq":0}\n', { exchanges: 1, seq_first: 0, seq_last: 0 })).stderr.toString()).toContain("not a positive whole number");
  expect(go(mk('{"status":200,"request":{"messages":[{"role":"user","content":"go"}]},"response":{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}]},"seq":1}\n{"status":200,"request":{"messages":[{"role":"user","content":"go"}]},"response":{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}]},"seq":2}\n', { exchanges: 2, seq_first: 1, seq_last: 5 })).stderr.toString()).toContain("manifest says 1-5");
  expect(go(mk('{"status":200,"request":{"messages":[{"role":"user","content":"go"}]},"response":{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}]},"seq":1}\n{"status":200,"request":{"messages":[{"role":"user","content":"go"}]},"response":{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}]},"seq":2}\n', { exchanges: 2, seq_first: 1, seq_last: 2, instances: ["a"] })).exitCode).toBe(0);
});

test("a rows-based run with no capture/ is refused unless --no-capture; an artifact-only capture=ok is verified", () => {
  const d = mkdtempSync(join(tmpdir(), "run-end-nocap-"));
  writeFileSync(join(d, "task_results.jsonl"), `{"instance_id":"a","resolved":true}\n`);
  writeFileSync(join(d, "stack.json"), "{}");
  const r = Bun.spawnSync(["bun", CLI, d, "--check", "rows=ok", "--check", "stack=ok"]);
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("no capture/ directory");
  expect(Bun.spawnSync(["bun", CLI, d, "--check", "rows=ok", "--check", "stack=ok", "--no-capture", "--check", "capture=ok"]).stderr.toString()).toContain("contradicts");
  expect(Bun.spawnSync(["bun", CLI, d, "--check", "rows=ok", "--check", "stack=ok", "--no-capture"]).exitCode).toBe(0);
  // artifact-only: exempt by default, verified when it claims capture=ok
  const a = mkdtempSync(join(tmpdir(), "run-end-artcap-"));
  mkdirSync(join(a, "artifacts"));
  writeFileSync(join(a, "artifacts", "sub.csv"), "x\n");
  writeFileSync(join(a, "stack.json"), "{}");
  const art = (...extra: string[]) => Bun.spawnSync(["bun", CLI, a, "--artifact-only", "--check", "artifacts=ok", "--check", "stack=ok", ...extra]);
  expect(art("--check", "capture=ok").stderr.toString()).toContain("no capture/ directory");
  mkdirSync(join(a, "capture"));
  writeFileSync(join(a, "capture", "task-k1.jsonl.gz"), Bun.gzipSync(Buffer.from('{"status":200,"request":{"messages":[{"role":"user","content":"go"}]},"response":{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}]},"seq":1}\n')));
  writeFileSync(join(a, "capture", "manifest.json"), JSON.stringify({ k1: { exchanges: 2, seq_first: 1, seq_last: 1 } }));
  expect(art("--check", "capture=ok").stderr.toString()).toContain("manifest says 2");
  writeFileSync(join(a, "capture", "manifest.json"), JSON.stringify({ k1: { exchanges: 1, seq_first: 1, seq_last: 1, instances: ["t1"] } }));
  // with no task inventory, one captured task would vouch for every task that bypassed the proxy
  expect(art("--check", "capture=ok").stderr.toString()).toContain("needs a task inventory");
  // an id-only inventory (no outcomes: the platform scores the run) is checked for coverage
  writeFileSync(join(a, "task_results.jsonl"), '{"instance_id":"t1"}\n{"instance_id":"t2"}\n');
  expect(art("--check", "capture=ok").stderr.toString()).toContain("1 of 2 task(s) have no captured exchange (t2)");
  writeFileSync(join(a, "task_results.jsonl"), '{"instance_id":"t1"}\n');
  expect(art("--check", "capture=ok").exitCode).toBe(0);
});

test("capture=ok means replayable: an exchange the replay tools would refuse blocks it, capture=fail records it", () => {
  const d = mkdtempSync(join(tmpdir(), "run-end-replayable-"));
  writeFileSync(join(d, "task_results.jsonl"), `{"instance_id":"a","resolved":true}\n`);
  writeFileSync(join(d, "stack.json"), "{}");
  mkdirSync(join(d, "capture"));
  const good = { seq: 1, status: 200, request: { messages: [{ role: "user", content: "go" }] }, response: { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }] } };
  writeFileSync(join(d, "capture", "task-k1.jsonl.gz"), Bun.gzipSync(Buffer.from(JSON.stringify(good) + "\n" + JSON.stringify({ ...good, seq: 2, status: 500 }) + "\n")));
  writeFileSync(join(d, "capture", "manifest.json"), JSON.stringify({ k1: { exchanges: 2, seq_first: 1, seq_last: 2, instances: ["a"] } }));
  const r = Bun.spawnSync(["bun", CLI, d, "--check", "rows=ok", "--check", "stack=ok"]);
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("1 captured exchange(s) are not replayable (task-k1.jsonl.gz seq 2: HTTP 500)");
  expect(Bun.spawnSync(["bun", CLI, d, "--check", "rows=ok", "--check", "stack=ok", "--check", "capture=fail:upstream 500 at seq 2"]).exitCode).toBe(0);
});

test("boolean flags given twice are usage errors", () => {
  const d = mkdtempSync(join(tmpdir(), "run-end-dup-"));
  expect(Bun.spawnSync(["bun", CLI, d, "--no-capture", "--no-capture", "--check", "rows=ok", "--check", "stack=ok"]).exitCode).toBe(2);
  expect(Bun.spawnSync(["bun", CLI, d, "--artifact-only", "--artifact-only", "--check", "artifacts=ok", "--check", "stack=ok"]).exitCode).toBe(2);
});

test("coverage: every row task needs a captured exchange, or a recorded --uncaptured-ok waiver", () => {
  const mk = (rows: string[], entries: Record<string, object>) => {
    const d = mkdtempSync(join(tmpdir(), "run-end-cov-"));
    writeFileSync(join(d, "task_results.jsonl"), rows.map((id) => JSON.stringify({ instance_id: id, resolved: true })).join("\n") + "\n");
    writeFileSync(join(d, "stack.json"), "{}");
    mkdirSync(join(d, "capture"));
    const man: Record<string, object> = {};
    let seq = 1;
    for (const [k, e] of Object.entries(entries)) {
      writeFileSync(join(d, "capture", `task-${k}.jsonl.gz`), Bun.gzipSync(Buffer.from(`{"status":200,"request":{"messages":[{"role":"user","content":"go"}]},"response":{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}]},"seq":${seq}}\n`)));
      man[k] = { exchanges: 1, seq_first: seq, seq_last: seq, ...e };
      seq++;
    }
    writeFileSync(join(d, "capture", "manifest.json"), JSON.stringify(man));
    return d;
  };
  const go = (d: string, ...extra: string[]) => Bun.spawnSync(["bun", CLI, d, "--check", "rows=ok", "--check", "stack=ok", ...extra]);
  // rows for A and B, a capture for A only: B bypassed the proxy
  const d = mk(["A", "B"], { k1: { task_id: "A", instances: ["A"] } });
  const r = go(d);
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("1 of 2 task(s) have no captured exchange (B)");
  expect(existsSync(join(d, "instruments.runend.json"))).toBe(false);
  // a waiver that names a task the rows do not have is refused
  expect(go(d, "--uncaptured-ok", "Z").stderr.toString()).toContain("not in task_results.jsonl: Z");
  // the waiver closes it, and is recorded
  expect(go(d, "--uncaptured-ok", "B").exitCode).toBe(0);
  const rec = JSON.parse(readFileSync(join(d, "instruments.runend.json"), "utf8"));
  expect(rec.checks.uncaptured).toEqual({ ok: true, detail: "no model call, waived: B" });
  // attribution through instances (capture-attribute) counts, and a numeric id matches its string form
  expect(go(mk(["7", "B"], { k1: { instances: [7] }, k2: { instances: ["B"] } })).exitCode).toBe(0);
  // one archive listing two tasks covers only the task its per-seq map names (round 15): the union of instances is
  // not evidence that both trajectories were captured, and with no map at all neither is covered
  const two = mk(["A", "B"], { k1: { instances: ["A", "B"], seq_tasks: { "1": "A" } } });
  expect(go(two).stderr.toString()).toContain("1 of 2 task(s) have no captured exchange (B)");
  expect(go(mk(["A", "B"], { k1: { instances: ["A", "B"] } })).stderr.toString()).toContain("2 of 2 task(s) have no captured exchange (A, B)");
  // --task-field reads another id field
  const t = mk(["A"], { k1: { instances: ["A"] } });
  writeFileSync(join(t, "task_results.jsonl"), '{"tid":"A","resolved":true}\n');
  expect(go(t).stderr.toString()).toContain('has no "instance_id"');
  expect(go(t, "--task-field", "tid").exitCode).toBe(0);
  // usage errors: a repeated or malformed waiver, a waiver with --no-capture
  expect(go(mk(["A"], { k1: { instances: ["A"] } }), "--uncaptured-ok", "A,A").exitCode).toBe(2);
  const n = mk(["A"], { k1: { instances: ["A"] } });
  expect(go(n, "--no-capture", "--uncaptured-ok", "A").stderr.toString()).toContain("only applies");
});

test("an attributed archive with an exchange attributed to no task is refused, even when its task has other exchanges", () => {
  const d = mkdtempSync(join(tmpdir(), "run-end-unattr-"));
  writeFileSync(join(d, "task_results.jsonl"), '{"instance_id":"A","resolved":true}\n');
  writeFileSync(join(d, "stack.json"), "{}");
  mkdirSync(join(d, "capture"));
  writeFileSync(join(d, "capture", "task-k1.jsonl.gz"), Bun.gzipSync(Buffer.from('{"status":200,"request":{"messages":[{"role":"user","content":"go"}]},"response":{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}]},"seq":1}\n{"status":200,"request":{"messages":[{"role":"user","content":"go"}]},"response":{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}]},"seq":2}\n')));
  const write = (e: object) => writeFileSync(join(d, "capture", "manifest.json"), JSON.stringify({ k1: { exchanges: 2, seq_first: 1, seq_last: 2, ...e } }));
  const go = () => Bun.spawnSync(["bun", CLI, d, "--check", "rows=ok", "--check", "stack=ok"]);
  // seq 2 is missing from the per-seq map: A is "covered" by seq 1, but seq 2 would vanish from every trajectory
  write({ instances: ["A"], seq_tasks: { "1": "A" } });
  let r = go();
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("1 of 2 exchange(s) attributed to no task");
  // attribution that compaction marked stale is refused by name
  write({ attribution_stale: "1 exchange(s) merged after capture-attribute ran; re-run capture-attribute" });
  r = go();
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("re-run capture-attribute");
  // a complete map closes it
  write({ instances: ["A"], seq_tasks: { "1": "A", "2": "A" } });
  expect(go().exitCode).toBe(0);
});
