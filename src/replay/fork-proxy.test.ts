import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROXY = join(import.meta.dir, "fork-proxy.ts");
const plan: any = {
  steps: [
    { at: "2026-01-01T00:00:00Z", request: { tools: [{}], messages: [] }, response: { choices: [{ message: { role: "assistant", content: "TURN-1" } }] } },
    { at: "2026-01-01T00:00:01Z", request: { messages: [] }, response: { choices: [{ message: { role: "assistant", content: "SUMMARY-1" } }] } },
  ],
};

async function startProxy(extra: string[], opts: { upstream?: string; fast?: boolean; plan?: any } = {}) {
  const d = mkdtempSync(join(tmpdir(), "fork-proxy-"));
  writeFileSync(join(d, "plan.json"), JSON.stringify(opts.plan ?? plan));
  const p = Bun.spawn(["bun", PROXY, "--port", "0", "--upstream", opts.upstream ?? "http://127.0.0.1:9", "--plan", join(d, "plan.json"), "--log", join(d, "log.jsonl"), ...(opts.fast === false ? [] : ["--fast"]), ...extra], { stdout: "pipe", stderr: "pipe" });
  const reader = p.stdout.getReader();
  let buf = "";
  while (!/fork-proxy :(\d+)/.test(buf)) { const { value, done } = await reader.read(); if (done) break; buf += new TextDecoder().decode(value); }
  return { p, port: Number(buf.match(/fork-proxy :(\d+)/)![1]), d };
}
const ask = async (port: number, body: unknown) =>
  ((await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as any).choices[0].message.content;

test("--kinds tools (default) matches a tool-less call to the captured summary, and flags it when it jumps the source order; --kinds single uses one queue", async () => {
  const a = await startProxy([]);
  try {
    expect(await ask(a.port, { messages: [] })).toBe("SUMMARY-1"); // source step 1 served before step 0
    const log = readFileSync(join(a.d, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log[0]).toMatchObject({ order_ok: false, source_step: 1, same: false });
  } finally { a.p.kill(); }
  const c = await startProxy([]); // in source order: both forced steps are in order
  try {
    expect(await ask(c.port, { tools: [{}], messages: [] })).toBe("TURN-1");
    expect(await ask(c.port, { messages: [] })).toBe("SUMMARY-1");
    const log = readFileSync(join(c.d, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log.map((e: any) => e.order_ok)).toEqual([true, true]);
  } finally { c.p.kill(); }
  const b = await startProxy(["--kinds", "single"]);
  try {
    expect(await ask(b.port, { messages: [] })).toBe("TURN-1");
    expect(await ask(b.port, { messages: [] })).toBe("SUMMARY-1");
  } finally { b.p.kill(); }
});

test("--normalise blanks a harness-specific path before comparing tool output", async () => {
  const withTool = (path: string) => ({ tools: [{}], messages: [{ role: "tool", content: `wrote ${path}/out.txt` }] });
  plan.steps[0]!.request = withTool("/runs/job-AAAA");
  const a = await startProxy(["--normalise", "job-[A-Z]+"]);
  try {
    await ask(a.port, withTool("/runs/job-BBBB"));
    const log = readFileSync(join(a.d, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log[0].same).toBe(true);
  } finally { a.p.kill(); }
  const b = await startProxy([]); // the default pattern does not know this harness's paths
  try {
    await ask(b.port, withTool("/runs/job-BBBB"));
    expect(JSON.parse(readFileSync(join(b.d, "log.jsonl"), "utf8").trim().split("\n")[0]!).same).toBe(false);
  } finally { b.p.kill(); }
});

test("a forced step is answered as a stream when the harness asks for one, and rebuilds to the captured message", async () => {
  const { assembleSse } = await import("../capture/sse");
  plan.steps[0] = { at: "2026-01-01T00:00:00Z", request: { tools: [{}], messages: [] }, response: { id: "r", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "run", arguments: "{\"x\":1}" } }] } }], usage: { completion_tokens: 4 } } };
  const a = await startProxy([]);
  try {
    const res = await fetch(`http://127.0.0.1:${a.port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stream: true, tools: [{}], messages: [] }) });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const rebuilt = assembleSse(await res.text());
    expect(rebuilt.choices[0].message.tool_calls[0].function).toEqual({ name: "run", arguments: "{\"x\":1}" });
    expect(rebuilt.choices[0].finish_reason).toBe("tool_calls");
    expect(rebuilt.usage.completion_tokens).toBe(4);
  } finally { a.p.kill(); }
});

test("clock fidelity counts from the source's first request arrival, so the first answer's latency is replayed", async () => {
  const timed = { steps: [{ req_at: "2026-01-01T00:00:00.000Z", at: "2026-01-01T00:00:00.800Z", request: { tools: [{}], messages: [] }, response: { choices: [{ message: { role: "assistant", content: "T" } }] } }] };
  const a = await startProxy([], { fast: false, plan: timed });
  try {
    const t = Date.now();
    expect(await ask(a.port, { tools: [{}], messages: [] })).toBe("T");
    expect(Date.now() - t).toBeGreaterThanOrEqual(750);
  } finally { a.p.kill(); }
  const legacy = { steps: [{ at: "2026-01-01T00:00:00.800Z", request: { tools: [{}], messages: [] }, response: { choices: [{ message: { role: "assistant", content: "T" } }] } }] };
  const b = await startProxy([], { fast: false, plan: legacy }); // no req_at: falls back to at, released at once
  try {
    const t = Date.now();
    await ask(b.port, { tools: [{}], messages: [] });
    expect(Date.now() - t).toBeLessThan(500);
  } finally { b.p.kill(); }
});

test("with no tool messages on either side, a different message history is divergent", async () => {
  const text = { steps: [{ at: "2026-01-01T00:00:00Z", request: { messages: [{ role: "user", content: "solve 2+2" }] }, response: { choices: [{ message: { role: "assistant", content: "4" } }] } }] };
  const a = await startProxy(["--kinds", "single"], { plan: text });
  try {
    await ask(a.port, { messages: [{ role: "user", content: "solve 3+3" }] });
    const e = JSON.parse(readFileSync(join(a.d, "log.jsonl"), "utf8").trim().split("\n")[0]!);
    expect(e).toMatchObject({ compared: "history", same: false });
  } finally { a.p.kill(); }
  const b = await startProxy(["--kinds", "single"], { plan: text });
  try {
    await ask(b.port, { messages: [{ role: "user", content: "solve 2+2" }] });
    expect(JSON.parse(readFileSync(join(b.d, "log.jsonl"), "utf8").trim().split("\n")[0]!)).toMatchObject({ compared: "history", same: true });
  } finally { b.p.kill(); }
});

test("past the forced steps, a streamed live answer is passed through as a stream", async () => {
  const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(ev({ choices: [{ index: 0, delta: { content: "li" } }] }) + ev({ choices: [{ index: 0, delta: { content: "ve" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }) });
  const a = await startProxy([], { upstream: `http://127.0.0.1:${upstream.port}`, plan: { steps: [] } });
  try {
    const res = await fetch(`http://127.0.0.1:${a.port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stream: true, messages: [] }) });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const { assembleSse } = await import("../capture/sse");
    expect(assembleSse(await res.text()).choices[0].message.content).toBe("live");
  } finally { a.p.kill(); upstream.stop(true); }
});

test("divergence compares tool calls too: two different write_file calls that both answer 'Done!' are not the same step", async () => {
  const hist = (path: string) => ({ tools: [{}], messages: [
    { role: "user", content: "fix it" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path }) } }] },
    { role: "tool", tool_call_id: "c1", content: "Done!" },
  ] });
  const p2 = { steps: [{ at: "2026-01-01T00:00:00Z", request: hist("a.py"), response: { choices: [{ message: { role: "assistant", content: "NEXT" } }] } }] };
  const same = await startProxy([], { plan: p2 });
  try {
    await ask(same.port, hist("a.py"));
    expect(JSON.parse(readFileSync(join(same.d, "log.jsonl"), "utf8").trim())).toMatchObject({ same: true, compared: "history" });
  } finally { same.p.kill(); }
  const diff = await startProxy([], { plan: p2 });
  try {
    await ask(diff.port, hist("b.py"));
    expect(JSON.parse(readFileSync(join(diff.d, "log.jsonl"), "utf8").trim())).toMatchObject({ same: false, diff_at: 1 });
  } finally { diff.p.kill(); }
});

test("an upstream with a path prefix ending in /v1 gets /v1 once, not twice", async () => {
  const seen: string[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => { seen.push(new URL(req.url).pathname); return Response.json({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "live" } }] }); } });
  const a = await startProxy([], { upstream: `http://127.0.0.1:${upstream.port}/api/v1`, plan: { steps: [] } });
  try {
    expect(await ask(a.port, { messages: [] })).toBe("live");
    expect(seen).toEqual(["/api/v1/chat/completions"]);
  } finally { a.p.kill(); upstream.stop(true); }
});
