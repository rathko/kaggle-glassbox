// Integration test: the whole capture -> compact -> attribute -> fork chain, end to end, on CPU.
// A deterministic mock model server and a tiny mock harness stand in for vLLM and the agent; every
// instrument runs as the real CLI subprocess a user would run. It checks the property the paper's
// fork self-test relies on: replaying the first K captured steps rebuilds the same tool outputs
// byte for byte (every forced step logs same:true), and only steps after K reach the live model.
//
// Set LIVE_UPSTREAM=http://127.0.0.1:8010 to also send one tiny request through wire-tap to a real
// OpenAI-compatible server (skipped by default: CI and containers have no model server).
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSteps } from "../../src/replay/fork-run-steps";

const SRC = join(import.meta.dir, "..", "..", "src");
const dir = mkdtempSync(join(tmpdir(), "capture-fork-"));
const procs: ReturnType<typeof Bun.spawn>[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => { for (const p of procs) p.kill(); for (const s of servers) s.stop(true); rmSync(dir, { recursive: true, force: true }); });

const TOOLS = [{ type: "function", function: { name: "run_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } } },
  { type: "function", function: { name: "submit_patch", parameters: { type: "object", properties: {} } } }];
const STEPS_PER_TASK = 4; // three commands, then submit

/** Deterministic "model": the next tool call depends only on the task and how many tool results it has seen. */
function mockModel(tag: string) {
  let calls = 0;
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const j: any = await req.json();
      calls++;
      const task = String(j.messages.find((m: any) => m.role === "user")?.content ?? "").split(" ")[1];
      const n = j.messages.filter((m: any) => m.role === "tool").length;
      const call = n < STEPS_PER_TASK - 1
        ? { id: `c${n}`, type: "function", function: { name: "run_command", arguments: JSON.stringify({ cmd: `${tag}-${task}-${n}` }) } }
        : { id: `c${n}`, type: "function", function: { name: "submit_patch", arguments: "{}" } };
      return Response.json({ id: `r-${calls}`, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: [call] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10 + n, completion_tokens: 5 } });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, calls: () => calls };
}

/** Mock harness: runs one task against a model URL, executes tool calls deterministically, returns its trace. */
async function runTask(base: string, task: string) {
  const messages: any[] = [{ role: "system", content: "sys" }, { role: "user", content: `task ${task} please` }];
  const steps: any[] = [];
  let llm = 0;
  for (;;) {
    const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "m", messages, tools: TOOLS }) });
    const j: any = await r.json();
    llm++;
    const msg = j.choices[0].message;
    messages.push(msg);
    steps.push({ who: "model", text: "", calls: msg.tool_calls.map((t: any) => ({ tool: t.function.name, input: JSON.parse(t.function.arguments) })) });
    const t = msg.tool_calls[0];
    if (t.function.name === "submit_patch") break;
    messages.push({ role: "tool", tool_call_id: t.id, content: `ran ${JSON.parse(t.function.arguments).cmd} in sandbox_${Math.random().toString(36).slice(2, 10)}` });
  }
  return { steps, llm, toolOutputs: messages.filter((m) => m.role === "tool").map((m) => m.content) };
}

/** Start a CLI that binds port 0 and wait (bounded) for its startup line; return the port it reports. */
async function startCli(args: string[], ready: RegExp): Promise<number> {
  const p = Bun.spawn(["bun", ...args], { stdout: "pipe", stderr: "pipe" });
  procs.push(p);
  const reader = p.stdout.getReader();
  let buf = "";
  const deadline = Date.now() + 15000;
  for (;;) {
    const m = buf.match(ready);
    if (m) return Number(m[1]);
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`${args[0]} did not report ready: ${buf}`);
    const next = await Promise.race([reader.read(), Bun.sleep(left).then(() => null)]);
    if (next === null) continue; // deadline reached; the check above throws
    if (next.done) throw new Error(`${args[0]} exited: ${buf} ${await new Response(p.stderr).text()}`);
    buf += Buffer.from(next.value).toString("utf8");
  }
}

async function cli(args: string[]) {
  const p = Bun.spawn(["bun", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
  if (code !== 0) throw new Error(`${args[0]} exit ${code}: ${out}\n${err}`);
  return out;
}

test("capture -> compact -> attribute -> fork: forced steps rebuild identical tool output; only later steps go live", async () => {
  // 1. source run through wire-tap with full capture
  const model = mockModel("src");
  const res = join(dir, "run"), cap = join(res, "capture");
  mkdirSync(join(res, "agent-logs"), { recursive: true }); // the layout examples/attribution-adapter.json describes
  const tapPort = await startCli([join(SRC, "capture/wire-tap.ts"), "--port", "0", "--upstream", model.url, "--log", join(res, "wire.jsonl"), "--capture-full", cap], /wire-tap on http:\/\/127\.0\.0\.1:(\d+)/);
  const tasks = ["alpha_1", "beta_2"], results: string[] = [], source: Record<string, string[]> = {};
  for (const t of tasks) {
    const r = await runTask(`http://127.0.0.1:${tapPort}`, t);
    source[t] = r.toolOutputs;
    writeFileSync(join(res, "agent-logs", `${t}.json`), JSON.stringify({ events: r.steps }));
    writeFileSync(join(res, "agent-logs", `${t}.done`), "done\n");
    results.push(JSON.stringify({ instance_id: t, model_calls: r.llm, resolved: true }));
  }
  writeFileSync(join(res, "task_results.jsonl"), results.join("\n") + "\n");
  const snaps = readdirSync(cap).filter((f) => f.endsWith(".json"));
  expect(snaps.length).toBe(tasks.length * STEPS_PER_TASK);
  // Deterministic clock. capture-attribute cross-checks content against done-marker mtime windows (5 s of slack)
  // on a serial run, and real tasks take minutes. Instead of sleeping, place task i's snapshots at T0 + i*60 s
  // (+1 s per step) and its done marker's mtime at T0 + i*60 + 30 s.
  const T0 = Date.parse("2026-01-01T00:00:00Z");
  for (const f of snaps) {
    const j = JSON.parse(readFileSync(join(cap, f), "utf8"));
    const ti = tasks.findIndex((t) => JSON.stringify(j.request.messages).includes(`task ${t} `));
    const step = j.request.messages.filter((m: any) => m.role === "tool").length;
    j.at = new Date(T0 + ti * 60_000 + step * 1000).toISOString();
    writeFileSync(join(cap, f), JSON.stringify(j));
  }
  tasks.forEach((t, i) => { const at = new Date(T0 + i * 60_000 + 30_000); utimesSync(join(res, "agent-logs", `${t}.done`), at, at); });

  // 2. compact and attribute with the real CLIs
  await cli([join(SRC, "capture/capture-compact.ts"), cap]);
  // this harness sends no task header, so attribution goes by content (traces) and the serial clock
  const attr = await cli([join(SRC, "capture/capture-attribute.ts"), res, cap, "--adapter", join(import.meta.dir, "..", "..", "examples", "attribution-adapter.json")]);
  expect(attr).toContain(`${tasks.length * STEPS_PER_TASK} by content`);
  const idx = JSON.parse(readFileSync(join(cap, "task-index.json"), "utf8"));
  expect(Object.keys(idx).sort()).toEqual(tasks);

  // 3. fork task beta_2 at K = 2: the proxy answers 2 turns from the capture, the rest go to a DIFFERENT live model
  const steps = loadSteps(res, "beta_2");
  expect(steps.length).toBe(STEPS_PER_TASK);
  const K = 2, plan = join(dir, "plan.json"), flog = join(dir, "fork.jsonl");
  writeFileSync(plan, JSON.stringify({ steps: steps.slice(0, K).map((s) => ({ at: s.at, request: s.request, response: s.response })) }));
  const live = mockModel("live");
  const forkPort = await startCli([join(SRC, "replay/fork-proxy.ts"), "--port", "0", "--upstream", live.url, "--plan", plan, "--log", flog, "--fast"], /fork-proxy :(\d+)/);
  const fork = await runTask(`http://127.0.0.1:${forkPort}`, "beta_2");

  const log = readFileSync(flog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const forced = log.filter((x) => x.kind === "forced");
  expect(forced.length).toBe(K);
  expect(forced.every((x) => x.same === true)).toBe(true); // sandbox paths differ per run; the normaliser must absorb them
  expect(live.calls()).toBe(STEPS_PER_TASK - K);
  // the forced prefix reproduces the source tool outputs (modulo the random sandbox path)
  const norm = (s: string) => s.replace(/sandbox_[a-z0-9]+/g, "sandbox_X");
  expect(fork.toolOutputs.slice(0, K).map(norm)).toEqual(source.beta_2!.slice(0, K).map(norm));
  // and the live suffix really came from the new model
  expect(fork.toolOutputs[K]).toContain("live-beta_2-");
}, 60000);

test.skipIf(!process.env.LIVE_UPSTREAM)("live: one tiny request through wire-tap to a real model server is captured", async () => {
  const cap = join(dir, "live-capture");
  const tapPort = await startCli([join(SRC, "capture/wire-tap.ts"), "--port", "0", "--upstream", process.env.LIVE_UPSTREAM!, "--log", join(dir, "live.jsonl"), "--capture-full", cap], /wire-tap on http:\/\/127\.0\.0\.1:(\d+)/);
  const models: any = await (await fetch(`http://127.0.0.1:${tapPort}/v1/models`)).json();
  const r = await fetch(`http://127.0.0.1:${tapPort}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: models.data[0].id, messages: [{ role: "user", content: "Reply with the word ok." }], max_tokens: 8 }) });
  expect(r.status).toBe(200);
  const snaps = readdirSync(cap).filter((f) => f.endsWith(".json"));
  expect(snaps.length).toBe(1);
  const snap = JSON.parse(readFileSync(join(cap, snaps[0]!), "utf8"));
  expect(snap.response.usage.completion_tokens).toBeGreaterThan(0);
}, 60000);
