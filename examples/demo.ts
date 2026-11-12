#!/usr/bin/env bun
// demo: the agent path (a Chat Completions agent scored pass/fail per task) on your machine in a few seconds,
// with no GPU, no API key and no data of your own. A mock model server and a tiny mock agent harness stand in
// for yours; everything else is the real tooling in src/, run as you would run it.
//
//   bun run demo            (or: bun examples/demo.ts [--keep])
//
// Steps: 1 capture every model exchange through wire-tap (with a task id header), 2 close the run (compact per
// task, stack.json, run-end record), 3 replay one captured step with a different system prompt, 4 read the score
// through the sealed reader, 5 ask the noise questions with the leaderboard CLI. Work files go to a temp dir,
// removed unless --keep.
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
import { strictArgs } from "../src/cli-args";
strictArgs(process.argv.slice(2), { bool: ["keep"] }, "usage: bun examples/demo.ts [--keep]");
const KEEP = process.argv.includes("--keep");
const work = mkdtempSync(join(tmpdir(), "measurement-demo-"));
const say = (s: string) => console.log(`\n=== ${s}`);

// ---- a mock OpenAI-compatible model: it reads a file, then edits, then stops ----------------------------
// If the system prompt says "check first", its first call is a test run instead: that is the behaviour
// change step 3 detects.
const model = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(req) {
    const body: any = await req.json();
    const sys = String(body.messages?.find((m: any) => m.role === "system")?.content ?? "");
    const turns = body.messages.filter((m: any) => m.role === "assistant").length;
    const call = (name: string, args: unknown) => ({ choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: `c${turns}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 50 + 20 * turns, completion_tokens: 12 } });
    if (turns === 0) return Response.json(sys.includes("check first") ? call("run_tests", {}) : call("read_file", { path: "app.py" }));
    if (turns === 1) return Response.json(call("edit_file", { path: "app.py", old: "a", new: "b" }));
    return Response.json({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "done" } }], usage: { prompt_tokens: 90, completion_tokens: 3 } });
  },
});

async function cli(args: string[], opts: { quiet?: boolean } = {}): Promise<string> {
  const p = Bun.spawn(["bun", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (!opts.quiet && out.trim()) console.log(out.trimEnd().replace(/^/gm, "  "));
  if (code !== 0) throw new Error(`bun ${args.join(" ")} exited ${code}\n${err}`);
  return out;
}

// the wire-tap child lives outside the try, so a failure in any step still stops it (and waits for it to exit)
// before the work directory is deleted underneath it
let tap: ReturnType<typeof Bun.spawn> | null = null;
try {
  // ---- 1. capture -----------------------------------------------------------------------------------
  say("1. capture: the harness talks to wire-tap instead of the model; wire-tap records every exchange");
  const cap = join(work, "run-1", "capture");
  tap = Bun.spawn(["bun", "src/capture/wire-tap.ts", "--port", "0", "--upstream", `http://127.0.0.1:${model.port}`, "--log", join(work, "run-1", "wire-tap.jsonl"), "--capture-full", cap], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const reader = (tap.stdout as ReadableStream<Uint8Array>).getReader();
  let first = "";
  while (!/127\.0\.0\.1:(\d+)/.test(first)) { const { value, done } = await reader.read(); if (done) throw new Error("wire-tap did not start"); first += new TextDecoder().decode(value); }
  const tapUrl = `http://127.0.0.1:${first.match(/127\.0\.0\.1:(\d+)/)![1]}`;
  console.log(first.trimEnd().replace(/^/gm, "  "));

  // the mock harness: three tasks, each a short tool loop; it reports its own result rows
  const tasks = ["task-1", "task-2", "task-3"], solved: Record<string, boolean> = { "task-1": true, "task-2": false, "task-3": true };
  const tools = ["read_file", "edit_file", "run_tests"].map((name) => ({ type: "function", function: { name, parameters: { type: "object" } } }));
  for (const t of tasks) {
    const messages: any[] = [{ role: "system", content: "You are a coding agent." }, { role: "user", content: `Fix the bug described in ${t}.` }];
    for (let turn = 0; turn < 5; turn++) {
      const r: any = await (await fetch(`${tapUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "x-task-id": t }, body: JSON.stringify({ model: "mock", messages, tools }) })).json();
      const msg = r.choices[0].message;
      messages.push(msg);
      if (!msg.tool_calls) break;
      messages.push({ role: "tool", tool_call_id: msg.tool_calls[0].id, content: `ok (${msg.tool_calls[0].function.name})` });
    }
  }
  tap.kill();
  // wire-tap exits 0 only when every open exchange finished and its capture landed; anything else means a lost
  // exchange, so the run must not be closed as if its capture were complete
  const tapCode = await tap.exited;
  if (tapCode !== 0) throw new Error(`wire-tap exited ${tapCode}: an exchange may be missing from the capture`);
  writeFileSync(join(work, "run-1", "task_results.jsonl"), tasks.map((t) => JSON.stringify({ instance_id: t, resolved: solved[t] })).join("\n") + "\n");
  await Bun.sleep(100);
  console.log(`  captured ${readdirSync(cap).length} exchanges for ${tasks.length} tasks`);

  // ---- 2. close the run the moment it ends ------------------------------------------------------------
  say("2. close the run: compact per task (grouped by the x-task-id header), write stack.json, record the run end");
  await cli(["src/capture/capture-compact.ts", cap]);
  const manifest = JSON.parse(readFileSync(join(cap, "manifest.json"), "utf8"));
  for (const m of Object.values(manifest) as any[]) console.log(`  ${m.task_id}: ${m.exchanges} exchanges`);
  writeFileSync(join(work, "run-1", "stack.json"), JSON.stringify({ model: "mock", server: "mock OpenAI-compatible", harness: "examples/demo.ts" }));
  await cli(["src/integrity/run-end.ts", join(work, "run-1"), "--check", "rows=ok", "--check", "stack=ok", "--check", "capture=ok"]);

  // ---- 3. replay one step with a mutation -------------------------------------------------------------
  say("3. replay: re-send the first step of every task with a different system prompt, nothing else re-run");
  writeFileSync(join(work, "candidate-prompt.md"), "You are a coding agent. Always check first: run the tests before reading code.");
  await cli(["src/replay/step-replay.ts", "--dir", cap, "--seq", "1,4,7", "--system-file", join(work, "candidate-prompt.md"), "--base", `http://127.0.0.1:${model.port}`, "--out", join(work, "replay.jsonl")]);

  // ---- 4. sealed score read ---------------------------------------------------------------------------
  say("4. score: the reader verifies the run-end record, seals the run, and only then prints the number");
  await cli(["src/integrity/score-reader.ts", join(work, "run-1")]);
  console.log(`  sealed: ${readdirSync(join(work, "run-1")).includes("score-read.json") ? "yes (score-read.json; repairs are now refused)" : "NO"}`);

  // ---- 5. noise questions -----------------------------------------------------------------------------
  say("5. noise: is a leaderboard move real? (canned example numbers; on a real competition measure noise before you tune anything)");
  await cli(["src/cli/leaderboard.ts", "compare", "--tasks", "50", "--a", "15", "--b", "19"]);
  await cli(["src/cli/leaderboard.ts", "aa", "--scores", ...[readFileSync(join(ROOT, "examples", "repeat-runs.txt"), "utf8").trim().split(/\s+/).join(",")]]);
  await cli(["src/cli/leaderboard.ts", "draws", "--sd", "1.5", "--bar", "1"]);

  say(`done. ${KEEP ? `work files kept in ${work}` : "work files removed (pass --keep to look at them)"}`);
} finally {
  if (tap && tap.exitCode === null && tap.signalCode === null) { tap.kill(); await tap.exited; }
  model.stop(true);
  if (!KEEP) rmSync(work, { recursive: true, force: true });
}
