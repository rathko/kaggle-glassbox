#!/usr/bin/env bun
// generate: rebuilds the dashboard's sample runs in examples/sample-runs/ with the real tooling and a mock model, so
// `bun run dashboard` has something to show straight after clone. No GPU, no key, about a minute.
//
//   bun examples/sample-runs/generate.ts
//
// Seven runs of one mock agent, each a full lifecycle: capture through wire-tap, compact, stack.json, run-end record,
// and (for most) one sealed read through score-reader. "baseline" and "candidate" are THE SAME AGENT: every gap
// between them is noise, which is the point. Two runs are left short of a score on purpose: candidate-r3 is closed
// but never read (the dashboard hides its score), baseline-r4 is never closed (open). baseline-r1 also gets a
// step-replay screen and a fork screen, so the drill-down has both to show.
// Behaviour and outcomes are seeded and repeat exactly; timestamps and latencies are real, so they differ per run.
// live-gemma4-qa/ (a real run against Gemma 4 31B on vLLM) is not touched.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { mulberry32 } from "../../src/stats/seeded-random.ts";
import { hash } from "./mock-agent.ts";

const ROOT = join(import.meta.dir, "../.."), OUT = relative(ROOT, import.meta.dir); // relative: no absolute path lands in a record
const RUNS: { name: string; close: boolean; read: boolean }[] = [
  ...["baseline-r1", "baseline-r2", "baseline-r3", "candidate-r1", "candidate-r2"].map((name) => ({ name, close: true, read: true })),
  { name: "candidate-r3", close: true, read: false },
  { name: "baseline-r4", close: false, read: false },
];

// ---- a mock OpenAI-compatible model: a seeded tool plan per (seed, task), a little latency, growing token counts ----
const model = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(req) {
    const body: any = await req.json();
    const msgs: any[] = body.messages ?? [];
    const sys = String(msgs.find((m) => m.role === "system")?.content ?? "");
    const task = String(msgs.find((m) => m.role === "user")?.content ?? "").match(/task-\d+/)?.[0] ?? "task";
    const turn = msgs.filter((m) => m.role === "assistant").length, seed = Number(body.seed ?? 0);
    const r = mulberry32(hash(seed, task, turn));
    const len = 3 + Math.floor(mulberry32(hash("len", seed, task))() * 7);
    await Bun.sleep(15 + Math.floor(r() * 120));
    const usage = { prompt_tokens: 220 + 140 * turn + Math.floor(r() * 40), completion_tokens: 18 + Math.floor(r() * 90) };
    const call = (name: string, args: unknown) => Response.json({ choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: `call_${turn}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage });
    if (turn === 0) return sys.includes("check first") ? call("run_tests", {}) : call("read_file", { path: "src/app.py" });
    if (turn >= len - 1) {
      if (mulberry32(hash("gives-up", seed, task))() < 0.12) return Response.json({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "I could not find the bug." } }], usage });
      return call("submit_patch", {});
    }
    const pick = ["search", "read_file", "edit_file", "run_tests"][Math.floor(r() * 4)]!;
    return call(pick, pick === "search" ? { query: "def total" } : pick === "edit_file" ? { path: "src/app.py", old: "xs[1:]", new: "xs" } : pick === "read_file" ? { path: "src/app.py" } : {});
  },
});
const MODEL_URL = `http://127.0.0.1:${model.port}`;

async function sh(args: string[], env: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawn(args, { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${args.join(" ")} exited ${code}\n${out}\n${err}`);
  return out;
}

async function captureRun(name: string): Promise<void> {
  const dir = join(OUT, name);
  const tap = Bun.spawn(["bun", "src/capture/wire-tap.ts", "--port", "0", "--upstream", MODEL_URL, "--log", join(dir, "wire-tap.jsonl"), "--capture-full", join(dir, "capture")], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  try {
    const reader = (tap.stdout as ReadableStream<Uint8Array>).getReader();
    let first = "";
    while (!/127\.0\.0\.1:(\d+)/.test(first)) { const { value, done } = await reader.read(); if (done) throw new Error("wire-tap did not start"); first += new TextDecoder().decode(value); }
    await sh(["bun", join(OUT, "mock-agent.ts"), OUT, name], { MODEL_BASE_URL: `http://127.0.0.1:${first.match(/127\.0\.0\.1:(\d+)/)![1]}` });
  } finally {
    tap.kill();
    const code = await tap.exited;
    if (code !== 0) throw new Error(`wire-tap exited ${code}: the capture may be incomplete`);
  }
}

try {
  for (const d of readdirSync(join(ROOT, OUT))) if (/^(baseline|candidate)-r\d+$/.test(d)) rmSync(join(ROOT, OUT, d), { recursive: true, force: true });
  for (const run of RUNS) {
    const dir = join(OUT, run.name);
    mkdirSync(join(ROOT, dir), { recursive: true });
    await captureRun(run.name);
    await sh(["bun", "src/capture/capture-compact.ts", join(dir, "capture")]);
    writeFileSync(join(ROOT, dir, "stack.json"), JSON.stringify({ model: "mock-coder", server: "mock OpenAI-compatible (examples/sample-runs/generate.ts)", harness: "examples/sample-runs/mock-agent.ts" }) + "\n");
    if (run.close) await sh(["bun", "src/integrity/run-end.ts", dir, "--check", "rows=ok", "--check", "stack=ok", "--check", "capture=ok"]);
    if (run.read) await sh(["bun", "src/integrity/score-reader.ts", dir]);
    console.log(`${run.name}: ${run.read ? "sealed" : run.close ? "closed, not read" : "open"}`);
  }
  // a cheap screen on baseline-r1: the first step of every task, re-sent with a "check first" system prompt
  const r1 = join(OUT, "baseline-r1");
  const prompt = join(r1, "candidate-prompt.md");
  const firstSeqs = Object.values(JSON.parse(readFileSync(join(ROOT, r1, "capture", "manifest.json"), "utf8")) as { seq_first: number }[]).map((m) => m.seq_first).sort((a, b) => a - b).join(",");
  writeFileSync(join(ROOT, prompt), "You are a coding agent. Always check first: run the tests before reading any code.\n");
  await sh(["bun", "src/replay/step-replay.ts", "--dir", join(r1, "capture"), "--seq", firstSeqs, "--system-file", prompt, "--base", MODEL_URL, "--out", join(r1, "replay-check-first.jsonl")]);
  // a fork screen: task-11 replayed exactly through its first two calls, then continued live 4 times
  await sh(["bun", "src/replay/fork-run.ts", "--source-dir", r1, "--task", "task-11", "--fork", "2", "--n", "4", "--tag", "task-11-k2",
    "--harness-cmd", `bun,${join(OUT, "mock-agent.ts")},${join(r1, "forks")},{runName},{taskFile}`, "--env", '{"MODEL_BASE_URL":"{proxyUrl}"}',
    "--upstream", MODEL_URL, "--results-root", join(r1, "forks")]);
  rmSync(join(ROOT, r1, "forks", "fork"), { recursive: true, force: true }); // fork-run's working files (plans, proxy logs)
  if (!existsSync(join(ROOT, r1, "forks", "fork-runs.jsonl"))) throw new Error("fork-run wrote no ledger");
  console.log(`baseline-r1: step replay + fork screen written\ndone: bun run dashboard`);
} finally {
  model.stop(true);
}
