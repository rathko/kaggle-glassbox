// Integration test: fork-run.ts end to end with a mock model and a mock harness. The harness sends the same
// first request the source run did (so the forced step matches), asks once more live, and writes its result.
// A second harness changes its first request, so its rebuilt state diverges: that rollout must be invalid
// and excluded from the rate, never counted as a solve.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "src");
const dir = mkdtempSync(join(tmpdir(), "fork-run-"));
const model = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch: (req) => new URL(req.url).pathname.endsWith("/models") ? Response.json({ data: [{ id: "m" }] })
    : Response.json({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "live" } }] }),
});
afterAll(() => { model.stop(true); rmSync(dir, { recursive: true, force: true }); });

const tool = (out: string) => [{ role: "user", content: "task t1" }, { role: "tool", tool_call_id: "c0", content: out }];
const src = join(dir, "source");
mkdirSync(join(src, "capture"), { recursive: true });
const snap = { seq: 1, status: 200, at: "2026-01-01T00:00:00Z", request: { tools: [{}], messages: tool("ran ok") }, response: { choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "forced" } }] } };
writeFileSync(join(src, "capture", "task-k1.jsonl.gz"), Bun.gzipSync(Buffer.from(JSON.stringify(snap) + "\n")));
writeFileSync(join(src, "capture", "manifest.json"), JSON.stringify({ k1: { instances: ["t1"], exchanges: 1, seq_first: 1, seq_last: 1 } }));

function harness(name: string, firstToolOutput: string): string {
  const p = join(dir, `${name}.ts`);
  writeFileSync(p, `
const [url, out] = process.argv.slice(2);
const ask = async (messages: any[]) => (await (await fetch(url + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tools: [{}], messages }) })).json()).choices[0].message.content;
await ask(${JSON.stringify(tool(firstToolOutput))});
await ask([{ role: "user", content: "task t1" }]);
require("node:fs").mkdirSync(require("node:path").dirname(out), { recursive: true });
require("node:fs").writeFileSync(out, JSON.stringify({ instance_id: "t1", resolved: true }) + "\\n");
`);
  return p;
}

async function forkRun(h: string, tag: string) {
  const p = Bun.spawn(["bun", join(SRC, "replay/fork-run.ts"), "--source-dir", src, "--task", "t1", "--fork", "1", "--n", "2", "--fast", "--tag", tag,
    "--upstream", `http://127.0.0.1:${model.port}`, "--results-root", join(dir, "results"), "--harness-cmd", `bun,${h},{proxyUrl},{resultsRoot}/{runName}/task_results.jsonl`], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`fork-run exit ${code}: ${err}`);
  return JSON.parse(out.trim().split("\n").pop()!);
}

test("faithful rollouts are valid and counted; diverged rollouts are excluded with a reason", async () => {
  const ok = await forkRun(harness("same", "ran ok"), "same");
  expect(ok).toMatchObject({ n: 2, valid: 2, resolved: 2, rate: 1, invalid: 0, divergent: 0 });
  const bad = await forkRun(harness("diff", "ran DIFFERENTLY"), "diff");
  expect(bad).toMatchObject({ n: 2, valid: 0, resolved: 0, rate: null, invalid: 2, divergent: 2 });
  expect(bad.invalid_reasons).toEqual({ "N forced step(s) diverged": 2 });
}, 60000);

// A text-only harness (no tools) on a hosted-style upstream that refuses anything unauthenticated, /v1/models
// included: readiness must come from the proxy itself, and a changed system prompt (the intervention) must not
// make the forced prefix divergent, while a changed task message still must.
test("text-only fork: a new system prompt over the same prefix stays valid; readiness never touches the upstream", async () => {
  const hosted = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: (req) => req.headers.get("authorization") !== "Bearer k" ? new Response("unauthorized", { status: 401 })
      : Response.json({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "live answer" } }] }),
  });
  try {
    const tsrc = join(dir, "text-source");
    mkdirSync(join(tsrc, "capture"), { recursive: true });
    const first = { seq: 1, at: "2026-01-01T00:00:00Z", status: 200,
      request: { messages: [{ role: "system", content: "OLD prompt" }, { role: "user", content: "What is 2+2?" }] },
      response: { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "4" } }] } };
    writeFileSync(join(tsrc, "capture", "task-k1.jsonl.gz"), Bun.gzipSync(Buffer.from(JSON.stringify(first) + "\n")));
    writeFileSync(join(tsrc, "capture", "manifest.json"), JSON.stringify({ k1: { instances: ["q1"], exchanges: 1, seq_first: 1, seq_last: 1 } }));
    const textHarness = (name: string, userText: string) => {
      const p = join(dir, `${name}.ts`);
      writeFileSync(p, `
const [url, out] = process.argv.slice(2);
const ask = async (messages: any[]) => (await (await fetch(url + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer k" }, body: JSON.stringify({ messages }) })).json()).choices[0].message.content;
const a1 = await ask([{ role: "system", content: "NEW prompt" }, { role: "user", content: ${JSON.stringify(userText)} }]);
await ask([{ role: "system", content: "NEW prompt" }, { role: "user", content: ${JSON.stringify(userText)} }, { role: "assistant", content: a1 }, { role: "user", content: "Sure?" }]);
require("node:fs").mkdirSync(require("node:path").dirname(out), { recursive: true });
require("node:fs").writeFileSync(out, JSON.stringify({ instance_id: "q1", resolved: true }) + "\\n");
`);
      return p;
    };
    const run = async (h: string, tag: string, extra: string[] = []) => {
      const p = Bun.spawn(["bun", join(SRC, "replay/fork-run.ts"), "--source-dir", tsrc, "--task", "q1", "--fork", "1", "--n", "1", "--fast", "--tag", tag, ...extra,
        "--upstream", `http://127.0.0.1:${hosted.port}`, "--results-root", join(dir, "results"), "--harness-cmd", `bun,${h},{proxyUrl},{resultsRoot}/{runName}/task_results.jsonl`], { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      if (code !== 0) throw new Error(`fork-run exit ${code}: ${err}`);
      return JSON.parse(out.trim().split("\n").pop()!);
    };
    expect(await run(textHarness("text-same", "What is 2+2?"), "text-same")).toMatchObject({ n: 1, valid: 1, resolved: 1, divergent: 0 });
    expect(await run(textHarness("text-diff", "What is 3+3?"), "text-diff")).toMatchObject({ n: 1, valid: 0, divergent: 1 });
    // comparing every role makes the system-prompt change itself divergent
    expect(await run(textHarness("text-all", "What is 2+2?"), "text-all", ["--ignore-roles", "none"])).toMatchObject({ n: 1, valid: 0, divergent: 1 });
  } finally {
    hosted.stop(true);
  }
}, 60000);

test("count flags of zero, negative or fractional value are refused before any output or rollout", () => {
  for (const [f, v] of [["--n", "0"], ["--pool", "0"], ["--n", "2.5"], ["--pool", "-1"]]) {
    const root = join(dir, `results-bad-${f.slice(2)}-${v}`);
    const p = Bun.spawnSync(["bun", join(SRC, "replay/fork-run.ts"), "--source-dir", src, "--task", "t1", "--fork", "1", f, v, "--fast",
      "--upstream", `http://127.0.0.1:${model.port}`, "--results-root", root, "--harness-cmd", "bun,-e,0"]);
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain(`${f} must be a whole number`);
    expect(require("node:fs").existsSync(root)).toBe(false);
  }
});

test("--outcome-threshold counts a numeric reward against T; without it the reward is unreadable", async () => {
  const h = join(dir, "reward.ts");
  writeFileSync(h, `
const [url, out] = process.argv.slice(2);
const ask = async (messages: any[]) => (await (await fetch(url + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tools: [{}], messages }) })).json()).choices[0].message.content;
await ask(${JSON.stringify(tool("ran ok"))});
require("node:fs").mkdirSync(require("node:path").dirname(out), { recursive: true });
require("node:fs").writeFileSync(out, JSON.stringify({ instance_id: "t1", reward: 0.73 }) + "\\n");
`);
  const run = async (tag: string, extra: string[]) => {
    const p = Bun.spawn(["bun", join(SRC, "replay/fork-run.ts"), "--source-dir", src, "--task", "t1", "--fork", "1", "--n", "1", "--fast", "--tag", tag,
      "--upstream", `http://127.0.0.1:${model.port}`, "--results-root", join(dir, "results"), "--outcome-field", "reward", ...extra,
      "--harness-cmd", `bun,${h},{proxyUrl},{resultsRoot}/{runName}/task_results.jsonl`], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, err, rec: code === 0 ? JSON.parse(out.trim().split("\n").pop()!) : null };
  };
  expect((await run("reward-pass", ["--outcome-threshold", "0.5"])).rec).toMatchObject({ n: 1, valid: 1, resolved: 1 });
  expect((await run("reward-miss", ["--outcome-threshold", "0.9"])).rec).toMatchObject({ n: 1, valid: 1, resolved: 0 });
  expect((await run("reward-none", [])).rec).toMatchObject({ n: 1, valid: 0, invalid: 1 });
  const bad = await run("reward-bad", ["--outcome-threshold", "abc"]);
  expect(bad.code).toBe(2);
  expect(bad.err).toContain("--outcome-threshold must be a finite number");
  // a lower-is-better outcome (a loss): 0.73 <= 0.9 is a success, 0.73 <= 0.5 is a miss, and the direction is recorded
  const low = await run("reward-low-pass", ["--outcome-threshold", "0.9", "--outcome-direction", "lower"]);
  expect(low.rec).toMatchObject({ valid: 1, resolved: 1, outcome: { field: "reward", threshold: 0.9, direction: "lower" } });
  expect((await run("reward-low-miss", ["--outcome-threshold", "0.5", "--outcome-direction", "lower"])).rec).toMatchObject({ valid: 1, resolved: 0 });
  expect((await run("reward-pass-2", ["--outcome-threshold", "0.5"])).rec.outcome).toEqual({ field: "reward", threshold: 0.5, direction: "higher" });
  expect((await run("reward-dir-bad", ["--outcome-threshold", "0.5", "--outcome-direction", "down"])).code).toBe(2);
  expect((await run("reward-dir-alone", ["--outcome-direction", "lower"])).err).toContain("needs --outcome-threshold");
}, 60000);

test("exactly one of --fork / --seq, a whole number, is required before any capture is read", async () => {
  const go = (extra: string[]) => Bun.spawnSync(["bun", join(SRC, "replay/fork-run.ts"), "--source-dir", join(dir, "no-such-source"), "--task", "t1",
    "--results-root", join(dir, "results-x"), "--harness-cmd", "true", "--fast", ...extra]);
  for (const [extra, msg] of [
    [["--fork", "1", "--seq", "1"], "exactly one of --fork K or --seq S"],
    [[], "exactly one of --fork K or --seq S"],
    [["--fork", "-1"], "must be a whole number >= 0"],
    [["--seq", "1.5"], "must be a whole number >= 0"],
    [["--fork", "abc"], "must be a whole number >= 0"],
  ] as [string[], string][]) {
    const r = go(extra);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain(msg);
  }
});

test("an unsafe task id gets a slug+hash default tag inside <results-root>/fork; an unsafe explicit --tag is refused", async () => {
  const { readdirSync, existsSync } = require("node:fs");
  for (const id of ["a/b", "../x"]) {
    const usrc = join(dir, `unsafe-src-${id.length}`), root = join(dir, `unsafe-results-${id.length}`);
    mkdirSync(join(usrc, "capture"), { recursive: true });
    writeFileSync(join(usrc, "capture", "task-k1.jsonl.gz"), Bun.gzipSync(Buffer.from(JSON.stringify(snap) + "\n")));
    writeFileSync(join(usrc, "capture", "manifest.json"), JSON.stringify({ k1: { instances: [id], exchanges: 1, seq_first: 1, seq_last: 1 } }));
    const h = join(dir, `unsafe-h-${id.length}.ts`);
    writeFileSync(h, `
const [url, out] = process.argv.slice(2);
await fetch(url + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tools: [{}], messages: ${JSON.stringify(tool("ran ok"))} }) });
require("node:fs").mkdirSync(require("node:path").dirname(out), { recursive: true });
require("node:fs").writeFileSync(out, JSON.stringify({ instance_id: ${JSON.stringify(id)}, resolved: true }) + "\\n");
`);
    const args = ["bun", join(SRC, "replay/fork-run.ts"), "--source-dir", usrc, "--task", id, "--fork", "1", "--n", "1", "--fast",
      "--upstream", `http://127.0.0.1:${model.port}`, "--results-root", root, "--harness-cmd", `bun,${h},{proxyUrl},{resultsRoot}/{runName}/task_results.jsonl`];
    const p = Bun.spawnSync(args);
    expect({ id, code: p.exitCode, err: p.stderr.toString() }).toMatchObject({ id, code: 0 });
    const tags = readdirSync(join(root, "fork"));
    expect(tags.length).toBe(1);
    expect(tags[0]).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]*-[0-9a-f]{10}-k1-/);
    expect(existsSync(join(root, "x"))).toBe(false);
    expect(existsSync(join(dir, "x-k1"))).toBe(false);
    for (const tag of ["a/b", "../x", "..", ".hidden"]) {
      const q = Bun.spawnSync([...args, "--tag", tag]);
      expect({ tag, code: q.exitCode }).toEqual({ tag, code: 2 });
      expect(q.stderr.toString()).toContain("--tag must be one safe file name");
    }
    expect(readdirSync(join(root, "fork")).length).toBe(1);
  }
}, 60000);

test("--advertise-host is the host the harness gets in {proxyUrl}, and the live request reaches the upstream without the task header", async () => {
  const seen: (string | null)[] = [];
  const up = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => { seen.push(req.headers.get("x-task-id")); return Response.json({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "live" } }] }); } });
  try {
    const p = join(dir, "adv.ts");
    writeFileSync(p, `
const [url, out] = process.argv.slice(2);
const ask = async (messages: any[]) => (await (await fetch(url + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-task-id": "t1" }, body: JSON.stringify({ tools: [{}], messages }) })).json()).choices[0].message.content;
await ask(${JSON.stringify(tool("ran ok"))});
await ask([{ role: "user", content: "task t1" }]);
require("node:fs").mkdirSync(require("node:path").dirname(out), { recursive: true });
require("node:fs").writeFileSync(out, JSON.stringify({ instance_id: "t1", resolved: true, url }) + "\\n");
`);
    const root = join(dir, "results-adv");
    const r = Bun.spawn(["bun", join(SRC, "replay/fork-run.ts"), "--source-dir", src, "--task", "t1", "--fork", "1", "--n", "1", "--fast", "--tag", "adv", "--advertise-host", "localhost",
      "--upstream", `http://127.0.0.1:${up.port}`, "--results-root", root, "--harness-cmd", `bun,${p},{proxyUrl},{resultsRoot}/{runName}/task_results.jsonl`], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(r.stdout).text(), new Response(r.stderr).text(), r.exited]);
    if (code !== 0) throw new Error(`fork-run exit ${code}: ${err}`);
    expect(JSON.parse(out.trim().split("\n").pop()!)).toMatchObject({ valid: 1, resolved: 1 });
    const row = JSON.parse(require("node:fs").readFileSync(join(root, "fork-adv-0", "task_results.jsonl"), "utf8"));
    expect(row.url).toMatch(/^http:\/\/localhost:\d+$/);
    expect(seen).toEqual([null]); // one live request, and its x-task-id was removed
  } finally { up.stop(true); }
}, 60000);

test("fork-run refuses a malformed --listen-host or --advertise-host before reading any capture", () => {
  for (const [f, v] of [["--listen-host", "a b"], ["--advertise-host", "x/y"]]) {
    const r = Bun.spawnSync(["bun", join(SRC, "replay/fork-run.ts"), "--source-dir", join(dir, "nope"), "--task", "t1", "--fork", "1", f!, v!, "--results-root", join(dir, "r"), "--harness-cmd", "true"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain(f!);
  }
});
