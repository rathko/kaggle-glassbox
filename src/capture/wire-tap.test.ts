import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "wire-tap.ts");
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function fakeUpstream() {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = req.method === "GET" ? null : await req.json();
      return Response.json({
        echo: body,
        choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { completion_tokens: 3, prompt_tokens: 7 },
      });
    },
  });
  cleanups.push(() => server.stop(true));
  return server;
}

// The server process never exits while the test holds it open, so reading its stdout stream to
// completion (e.g. `new Response(stream).text()`) would hang forever. Read only up to the first
// newline instead — the one line wire-tap.ts prints on startup.
async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let buf = "";
  while (!buf.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += Buffer.from(value).toString("utf8");
  }
  return buf;
}

async function waitUp(port: number) {
  for (let i = 0; i < 40; i++) {
    const ok = await fetch(`http://127.0.0.1:${port}/v1/models`).then((r) => r.ok || r.status === 404, () => false);
    if (ok) return;
    await Bun.sleep(50);
  }
  throw new Error(`wire-tap on :${port} never came up`);
}

test("proxies a chat-completions request unchanged and logs the exchange", async () => {
  const upstream = fakeUpstream();
  const dir = mkdtempSync(join(tmpdir(), "wire-tap-"));
  const logFile = join(dir, "log.jsonl");
  const proc = Bun.spawn(["bun", SCRIPT, "--port", "0", "--upstream", `http://127.0.0.1:${upstream.port}`, "--log", logFile], {
    stdout: "pipe", stderr: "pipe",
  });
  cleanups.push(() => { proc.kill(); rmSync(dir, { recursive: true, force: true }); });

  const line = await firstLine(proc.stdout);
  const port = Number(line.match(/127\.0\.0\.1:(\d+)/)?.[1]);
  expect(port).toBeGreaterThan(0);
  await waitUp(port);

  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], temperature: 0.2 }),
  });
  expect(res.ok).toBe(true);
  const j: any = await res.json();
  expect(j.choices[0].message.content).toBe("hi");

  const entries = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((e) => e.path === "/v1/chat/completions");
  expect(entries.length).toBe(1);
  expect(entries[0].injected).toBeNull();
  expect(entries[0].temperature).toBe(0.2);
  expect(entries[0].completion_tokens).toBe(3);
});

test("--inject merges keys into the outbound body and labels the entry as injected", async () => {
  const upstream = fakeUpstream();
  const dir = mkdtempSync(join(tmpdir(), "wire-tap-"));
  const logFile = join(dir, "log.jsonl");
  const proc = Bun.spawn(
    ["bun", SCRIPT, "--port", "0", "--upstream", `http://127.0.0.1:${upstream.port}`, "--log", logFile, "--inject", JSON.stringify({ reasoning_effort: "none" })],
    { stdout: "pipe", stderr: "pipe" }
  );
  cleanups.push(() => { proc.kill(); rmSync(dir, { recursive: true, force: true }); });

  const port = Number((await firstLine(proc.stdout)).match(/127\.0\.0\.1:(\d+)/)?.[1]);
  await waitUp(port);

  await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [] }),
  });

  const entries = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((e) => e.path === "/v1/chat/completions");
  const entry = entries[0];
  expect(entry.injected).toEqual(["reasoning_effort"]);
  expect(entry.reasoning_effort).toBe("none");
});

test("--capture-full writes one redacted snapshot per chat-completions exchange", async () => {
  const upstream = fakeUpstream();
  const dir = mkdtempSync(join(tmpdir(), "wire-tap-"));
  const logFile = join(dir, "log.jsonl");
  const capDir = join(dir, "capture");
  const proc = Bun.spawn(
    ["bun", SCRIPT, "--port", "0", "--upstream", `http://127.0.0.1:${upstream.port}`, "--log", logFile, "--capture-full", capDir],
    { stdout: "pipe", stderr: "pipe" }
  );
  cleanups.push(() => { proc.kill(); rmSync(dir, { recursive: true, force: true }); });

  const port = Number((await firstLine(proc.stdout)).match(/127\.0\.0\.1:(\d+)/)?.[1]);
  await waitUp(port);

  await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], api_key: "sk-super-secret-value" }),
  });

  const snapFiles = readdirSync(capDir).filter((f) => f.endsWith(".json"));
  expect(snapFiles.length).toBe(1);
  const raw = readFileSync(join(capDir, snapFiles[0]), "utf8");
  expect(raw).not.toContain("sk-super-secret-value");
  const snap = JSON.parse(raw);
  expect(snap.request.messages[0].content).toBe("hello");
  expect(snap.request.api_key).toBe("<redacted>");
  expect(snap.response.choices[0].message.content).toBe("hi");
});

test("a streamed answer is forwarded as a stream with the upstream status and headers, and captured reassembled", async () => {
  const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const upstream = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      await req.text();
      const parts = [
        ev({ id: "s", choices: [{ index: 0, delta: { role: "assistant", content: "str" } }] }),
        ev({ id: "s", choices: [{ index: 0, delta: { content: "eamed" }, finish_reason: "stop" }] }),
        ev({ id: "s", choices: [], usage: { completion_tokens: 2, prompt_tokens: 4 } }),
        "data: [DONE]\n\n",
      ];
      const body = new ReadableStream({ async start(c) { for (const p of parts) { c.enqueue(new TextEncoder().encode(p)); await Bun.sleep(20); } c.close(); } });
      return new Response(body, { status: 201, headers: { "content-type": "text/event-stream", "x-request-id": "abc" } });
    },
  });
  cleanups.push(() => upstream.stop(true));
  const dir = mkdtempSync(join(tmpdir(), "wire-tap-sse-"));
  const cap = join(dir, "cap");
  const proc = Bun.spawn(["bun", SCRIPT, "--port", "0", "--upstream", `http://127.0.0.1:${upstream.port}`, "--log", join(dir, "log.jsonl"), "--capture-full", cap], { stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => { proc.kill(); rmSync(dir, { recursive: true, force: true }); });
  const port = Number((await firstLine(proc.stdout)).match(/127\.0\.0\.1:(\d+)/)?.[1]);
  await waitUp(port);

  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stream: true, messages: [] }) });
  expect(res.status).toBe(201);
  expect(res.headers.get("x-request-id")).toBe("abc");
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const text = await res.text();
  expect(text).toContain('"content":"str"');
  expect(text).toContain("[DONE]");

  // drain barrier: the snapshot is on disk the moment the client has read the end of the stream, no polling
  const files = readdirSync(cap).filter((f) => f.endsWith(".json"));
  expect(files.length).toBe(1);
  const snap = JSON.parse(readFileSync(join(cap, files[0]!), "utf8"));
  expect(snap.streamed).toBe(true);
  expect(snap.response.choices[0].message.content).toBe("streamed");
  expect(snap.response.usage.completion_tokens).toBe(2);
});

test("captures are owner-only by default, and nested or camel-case credentials never reach disk", async () => {
  const upstream = fakeUpstream();
  const dir = mkdtempSync(join(tmpdir(), "wire-tap-perm-"));
  const capDir = join(dir, "capture");
  const proc = Bun.spawn(["bun", SCRIPT, "--port", "0", "--upstream", `http://127.0.0.1:${upstream.port}`, "--log", join(dir, "log.jsonl"), "--capture-full", capDir], { stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => { proc.kill(); rmSync(dir, { recursive: true, force: true }); });
  const port = Number((await firstLine(proc.stdout)).match(/127\.0\.0\.1:(\d+)/)?.[1]);
  await waitUp(port);
  await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "m", apiKey: "SECRET1", extra: { access_token: "SECRET2", note: "Bearer SECRET3" }, messages: [{ role: "user", content: "hi" }] }) });
  await Bun.sleep(150);
  const { statSync, readdirSync, readFileSync } = await import("node:fs");
  expect(statSync(capDir).mode & 0o777).toBe(0o700);
  const files = readdirSync(capDir).filter((f) => f.endsWith(".json"));
  expect(files.length).toBe(1);
  expect(statSync(join(capDir, files[0]!)).mode & 0o777).toBe(0o600);
  const raw = readFileSync(join(capDir, files[0]!), "utf8");
  expect(raw).not.toMatch(/SECRET[123]/);
  expect(() => JSON.parse(raw)).not.toThrow();
});

test("a non-empty capture dir is refused unless --append, which resumes numbering; snapshots carry req_at", async () => {
  const upstream = fakeUpstream();
  const dir = mkdtempSync(join(tmpdir(), "wire-tap-append-"));
  const capDir = join(dir, "capture");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(capDir);
  writeFileSync(join(capDir, "000007.json"), JSON.stringify({ seq: 7 }));
  const args = ["bun", SCRIPT, "--port", "0", "--upstream", `http://127.0.0.1:${upstream.port}`, "--log", join(dir, "log.jsonl"), "--capture-full", capDir];
  const refused = Bun.spawnSync(args);
  expect(refused.exitCode).toBe(2);
  expect(refused.stderr.toString()).toContain("is not empty");
  const proc = Bun.spawn([...args, "--append"], { stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => proc.kill());
  const port = Number((await firstLine(proc.stdout)).match(/127\.0\.0\.1:(\d+)/)?.[1]);
  await waitUp(port);
  await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) });
  await Bun.sleep(150);
  const files = readdirSync(capDir).filter((f) => f.endsWith(".json")).sort();
  expect(files[0]).toBe("000007.json");
  const fresh = JSON.parse(readFileSync(join(capDir, files[files.length - 1]!), "utf8"));
  expect(fresh.seq).toBeGreaterThan(7);
  expect(Date.parse(fresh.req_at)).toBeLessThanOrEqual(Date.parse(fresh.at));
});

test("any entry in the capture dir counts as non-empty, not only snapshot-shaped names", () => {
  const dir = mkdtempSync(join(tmpdir(), "wire-tap-nonempty-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const stale of ["task-index.json", "snapshot-1.json", "notes.txt"]) {
    const capDir = join(dir, `cap-${stale}`);
    require("node:fs").mkdirSync(capDir);
    writeFileSync(join(capDir, stale), "{}");
    const r = Bun.spawnSync(["bun", SCRIPT, "--port", "0", "--upstream", "http://127.0.0.1:9", "--log", join(dir, "log.jsonl"), "--capture-full", capDir]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain(stale);
  }
});

test("a streamed exchange whose capture cannot be written ends in an error event without [DONE], never a clean answer", async () => {
  const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    await req.text();
    return new Response(ev({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  cleanups.push(() => upstream.stop(true));
  const dir = mkdtempSync(join(tmpdir(), "wire-tap-fail-"));
  const cap = join(dir, "cap");
  const proc = Bun.spawn(["bun", SCRIPT, "--port", "0", "--upstream", `http://127.0.0.1:${upstream.port}`, "--log", join(dir, "log.jsonl"), "--capture-full", cap], { stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => { proc.kill(); rmSync(dir, { recursive: true, force: true }); });
  const port = Number((await firstLine(proc.stdout)).match(/127\.0\.0\.1:(\d+)/)?.[1]);
  await waitUp(port);
  // the capture dir becomes a plain file, so writing the snapshot fails
  rmSync(cap, { recursive: true, force: true });
  writeFileSync(cap, "not a directory");
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stream: true, messages: [] }) });
  // Bun ends a chunked body cleanly even when its stream errors, so the failure arrives in-band: an error event
  // and no [DONE], which an OpenAI-style client raises on and sse.ts marks invalid
  const text = await res.text();
  expect(text).toContain('"content":"x"');
  expect(text).toContain("event: error");
  expect(text).toContain("capture_failed");
  expect(text).not.toContain("[DONE]");
  const { assembleSse } = await import("./sse");
  expect(assembleSse(text).stream_invalid).toBe(true);
});

test("an upstream with a path prefix ending in /v1 is joined once with the harness's /v1 path", async () => {
  const seen: string[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    seen.push(new URL(req.url).pathname); await req.text();
    return Response.json({ choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] });
  } });
  cleanups.push(() => upstream.stop(true));
  const dir = mkdtempSync(join(tmpdir(), "wire-tap-prefix-"));
  const proc = Bun.spawn(["bun", SCRIPT, "--port", "0", "--upstream", `http://127.0.0.1:${upstream.port}/api/v1`, "--log", join(dir, "log.jsonl")], { stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => { proc.kill(); rmSync(dir, { recursive: true, force: true }); });
  const port = Number((await firstLine(proc.stdout)).match(/127\.0\.0\.1:(\d+)/)?.[1]);
  await waitUp(port);
  seen.length = 0;
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [] }) });
  expect(res.ok).toBe(true);
  expect(seen).toEqual(["/api/v1/chat/completions"]);
});

test("the audit log redacts nested credentials in every summarised request object, not only full_params", async () => {
  const upstream = fakeUpstream();
  const dir = mkdtempSync(join(tmpdir(), "wire-tap-"));
  const logFile = join(dir, "log.jsonl");
  const proc = Bun.spawn(["bun", SCRIPT, "--port", "0", "--upstream", `http://127.0.0.1:${upstream.port}`, "--log", logFile], { stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => { proc.kill(); rmSync(dir, { recursive: true, force: true }); });
  const port = Number((await firstLine(proc.stdout)).match(/127\.0\.0\.1:(\d+)/)?.[1]);
  await waitUp(port);
  // five calls, so the later ones carry no full_params and only the summarised objects could leak
  for (let i = 0; i < 5; i++)
    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
        thinking_config: { budget: 10, api_key: "LEAK-A" },
        extra_body: { hf_token: "LEAK-B", nested: { authorization: "LEAK-C" } },
        chat_template_kwargs: { enable_thinking: true, password: "LEAK-D", eos_token: "</s>" },
      }),
    }).then((r) => r.text());
  const raw = readFileSync(logFile, "utf8");
  for (const s of ["LEAK-A", "LEAK-B", "LEAK-C", "LEAK-D"]) expect(raw).not.toContain(s);
  const entries = raw.trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.path === "/v1/chat/completions");
  expect(entries.length).toBe(5);
  expect(entries[4].thinking_config.budget).toBe(10);
  expect(entries[4].chat_template_kwargs.eos_token).toBe("</s>");
  expect(entries[4].completion_tokens).toBe(3);
  expect(entries[4].max_tokens).toBeNull();
});

test("a capture failure never forwards an unterminated [DONE] still pending: only the error event follows", async () => {
  const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    await req.text();
    // the last event has no blank line after it, so it sits in pending (not held) at end of stream
    return new Response(ev({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }] }) + "data: [DONE]", { headers: { "content-type": "text/event-stream" } });
  } });
  cleanups.push(() => upstream.stop(true));
  const dir = mkdtempSync(join(tmpdir(), "wire-tap-fail2-"));
  const cap = join(dir, "cap");
  const proc = Bun.spawn(["bun", SCRIPT, "--port", "0", "--upstream", `http://127.0.0.1:${upstream.port}`, "--log", join(dir, "log.jsonl"), "--capture-full", cap], { stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => { proc.kill(); rmSync(dir, { recursive: true, force: true }); });
  const port = Number((await firstLine(proc.stdout)).match(/127\.0\.0\.1:(\d+)/)?.[1]);
  await waitUp(port);
  rmSync(cap, { recursive: true, force: true });
  writeFileSync(cap, "not a directory");
  const text = await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stream: true, messages: [] }) })).text();
  expect(text).toContain("capture_failed");
  expect(text).not.toContain("[DONE]");
});

test("the task-id header and hop-by-hop headers never reach the upstream; other headers do", async () => {
  const seen: Record<string, string>[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const h: Record<string, string> = {}; req.headers.forEach((v, k) => { h[k] = v; }); seen.push(h); await req.text();
    return Response.json({ choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] });
  } });
  cleanups.push(() => upstream.stop(true));
  const dir = mkdtempSync(join(tmpdir(), "wire-tap-hdr-"));
  const proc = Bun.spawn(["bun", SCRIPT, "--port", "0", "--upstream", `http://127.0.0.1:${upstream.port}`, "--log", join(dir, "log.jsonl"), "--task-header", "x-my-task"], { stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => { proc.kill(); rmSync(dir, { recursive: true, force: true }); });
  const port = Number((await firstLine(proc.stdout)).match(/127\.0\.0\.1:(\d+)/)?.[1]);
  await waitUp(port);
  seen.length = 0;
  await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "x-my-task": "secret-task-7", "proxy-authorization": "p", authorization: "Bearer k", "x-keep": "1" }, body: JSON.stringify({ messages: [] }) }).then((r) => r.text());
  expect(seen.length).toBe(1);
  expect(seen[0]!["x-my-task"]).toBeUndefined();
  expect(seen[0]!["proxy-authorization"]).toBeUndefined();
  expect(seen[0]!.authorization).toBe("Bearer k");
  expect(seen[0]!["x-keep"]).toBe("1");
  // the proxy itself still recorded the task id
  expect(readFileSync(join(dir, "log.jsonl"), "utf8")).toContain('"task_id":"secret-task-7"');
});

test("--listen-host rejects a malformed host before binding", () => {
  const r = Bun.spawnSync(["bun", SCRIPT, "--port", "0", "--listen-host", "bad host", "--log", join(tmpdir(), "never.jsonl")]);
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("--listen-host");
});

test("/__wiretap/ready answers locally once listening, without proxying, logging or using a seq", async () => {
  let upstreamHits = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { upstreamHits++; await req.text(); return Response.json({ choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] }); } });
  cleanups.push(() => upstream.stop(true));
  const dir = mkdtempSync(join(tmpdir(), "wire-tap-ready-"));
  const logFile = join(dir, "log.jsonl"), capDir = join(dir, "capture");
  const proc = Bun.spawn(["bun", SCRIPT, "--port", "0", "--upstream", `http://127.0.0.1:${upstream.port}`, "--log", logFile, "--capture-full", capDir], { stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => { proc.kill(); rmSync(dir, { recursive: true, force: true }); });
  const port = Number((await firstLine(proc.stdout)).match(/127\.0\.0\.1:(\d+)/)?.[1]);
  const ready = await fetch(`http://127.0.0.1:${port}/__wiretap/ready`);
  expect(ready.status).toBe(200);
  expect(await ready.text()).toBe("ready\n");
  expect(upstreamHits).toBe(0);
  await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }) });
  // the first real exchange is still seq 1, and the log holds only that exchange
  expect(readdirSync(capDir)).toEqual(["000001.json"]);
  expect(readFileSync(logFile, "utf8").trim().split("\n").length).toBe(1);
});

test("SIGTERM lets an in-flight streamed exchange finish, writes its capture, and exits 0", async () => {
  // the upstream holds its stream open, so the signal arrives while the exchange is in flight
  const upstream = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      await req.text();
      const enc = new TextEncoder();
      const body = new ReadableStream({
        async start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "par" } }] })}\n\n`));
          await Bun.sleep(400);
          c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "tial" }, finish_reason: "stop" }] })}\n\n`));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  cleanups.push(() => upstream.stop(true));
  const dir = mkdtempSync(join(tmpdir(), "wire-tap-term-"));
  const capDir = join(dir, "capture");
  const proc = Bun.spawn(["bun", SCRIPT, "--port", "0", "--upstream", `http://127.0.0.1:${upstream.port}`, "--log", join(dir, "log.jsonl"), "--capture-full", capDir], { stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => { proc.kill(); rmSync(dir, { recursive: true, force: true }); });
  const port = Number((await firstLine(proc.stdout)).match(/127\.0\.0\.1:(\d+)/)?.[1]);
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "x" }] }) });
  const text = res.text();
  await Bun.sleep(100); // first event is through; the exchange is still open
  proc.kill("SIGTERM");
  const body = await text;
  expect(body).toContain("data: [DONE]");
  expect(await proc.exited).toBe(0);
  const snap = JSON.parse(readFileSync(join(capDir, "000001.json"), "utf8"));
  expect(snap.response.choices[0].message.content).toBe("partial");
});

test("SIGINT with nothing in flight exits 0 at once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wire-tap-int-"));
  const proc = Bun.spawn(["bun", SCRIPT, "--port", "0", "--upstream", "http://127.0.0.1:9", "--log", join(dir, "log.jsonl")], { stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => { proc.kill(); rmSync(dir, { recursive: true, force: true }); });
  await firstLine(proc.stdout);
  proc.kill("SIGINT");
  expect(await proc.exited).toBe(0);
});
