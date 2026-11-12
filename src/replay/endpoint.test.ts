import { test, expect } from "bun:test";
import { chatUrl, authHeaders, postChat } from "./endpoint";

test("chatUrl accepts a bare host, a /v1 base, or the full endpoint", () => {
  expect(chatUrl("http://127.0.0.1:8010")).toBe("http://127.0.0.1:8010/v1/chat/completions");
  expect(chatUrl("http://127.0.0.1:8010/")).toBe("http://127.0.0.1:8010/v1/chat/completions");
  expect(chatUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1/chat/completions");
  expect(chatUrl("https://h/x/chat/completions")).toBe("https://h/x/chat/completions");
});

test("the key comes from REPLAY_API_KEY only", () => {
  expect(authHeaders({}).authorization).toBeUndefined();
  expect(authHeaders({ REPLAY_API_KEY: "k" }).authorization).toBe("Bearer k");
});

test("postChat throws on a non-2xx status or a body without choices, and returns the body otherwise", async () => {
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname.startsWith("/limited")) return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
      if (u.pathname.startsWith("/empty")) return Response.json({ choices: [] });
      if (u.pathname.startsWith("/hollow")) return Response.json({ choices: [{}] });
      return Response.json({ choices: [{ message: { role: "assistant", content: "ok", auth: req.headers.get("authorization") } }] });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await expect(postChat(`${base}/limited/v1`, {})).rejects.toThrow("HTTP 429");
    await expect(postChat(`${base}/empty/v1`, {})).rejects.toThrow("no choices");
    await expect(postChat(`${base}/hollow/v1`, {})).rejects.toThrow("choice 0 has no message");
    const ok = await postChat(base, {});
    expect(ok.choices[0].message.content).toBe("ok");
  } finally { server.stop(true); }
});

test("postChat assembles a text/event-stream answer and throws on an invalid stream", async () => {
  const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const sse = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname.startsWith("/cut")) return sse(ev({ choices: [{ index: 0, delta: { content: "par" } }] }));
      if (u.pathname.startsWith("/err")) return sse(ev({ choices: [{ index: 0, delta: { content: "a" } }] }) + ev({ error: { message: "boom" } }) + "data: [DONE]\n\n");
      return sse(ev({ choices: [{ index: 0, delta: { role: "assistant", content: "str" } }] }) + ev({ choices: [{ index: 0, delta: { content: "eamed" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const ok = await postChat(base, { stream: true });
    expect(ok.choices[0].message.content).toBe("streamed");
    await expect(postChat(`${base}/cut/v1`, {})).rejects.toThrow("invalid event stream");
    await expect(postChat(`${base}/err/v1`, {})).rejects.toThrow("error event");
  } finally { server.stop(true); }
});

test("upstreamUrl joins a /v1-ending upstream path with a /v1 request path once, and appends anything else", () => {
  const { upstreamUrl } = require("./endpoint");
  expect(upstreamUrl("https://h/api/v1", "/v1/chat/completions")).toBe("https://h/api/v1/chat/completions");
  expect(upstreamUrl("https://h/api/v1/", "/v1/chat/completions?x=1")).toBe("https://h/api/v1/chat/completions?x=1");
  expect(upstreamUrl("https://h/api/v1", "/v1")).toBe("https://h/api/v1");
  expect(upstreamUrl("http://127.0.0.1:8010", "/v1/chat/completions")).toBe("http://127.0.0.1:8010/v1/chat/completions");
  expect(upstreamUrl("https://h/api", "/v1/models")).toBe("https://h/api/v1/models");
  // only a whole /v1 segment counts: /v1beta and /v1x are not the same version prefix
  expect(upstreamUrl("https://h/api/v1", "/v1x/y")).toBe("https://h/api/v1/v1x/y");
  expect(upstreamUrl("https://h/api/v1", "/v1beta/x")).toBe("https://h/api/v1/v1beta/x");
  expect(upstreamUrl("https://h/api/v1", "/health")).toBe("https://h/api/v1/health");
});

test("choiceProblems wants an assistant message with text or a well-formed tool call list", () => {
  const { choiceProblems } = require("./capture-valid");
  const ok = (message: unknown) => choiceProblems([{ index: 0, message }]);
  expect(ok({ role: "assistant", content: "hi" })).toEqual([]);
  expect(ok({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] })).toEqual([]);
  for (const bad of [
    {},
    { content: "hi" },
    { role: "user", content: "hi" },
    { role: "assistant", content: null },
    { role: "assistant", content: 3 },
    { role: "assistant", tool_calls: [] },
    { role: "assistant", tool_calls: [{ type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "assistant", tool_calls: [{ id: "c1", function: { name: "f", arguments: "{}" } }] },
    { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "f" } }] },
    { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: {} } }] },
    { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { arguments: "{}" } }] },
  ]) expect({ bad, n: ok(bad).length > 0 }).toEqual({ bad, n: true });
});

test("postChat refuses a 200 body that carries an error, even beside a usable choices array", async () => {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ error: { message: "quota" }, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }] }) });
  try { await expect(postChat(`http://127.0.0.1:${s.port}`, { messages: [] })).rejects.toThrow(/carries an error/); }
  finally { s.stop(true); }
});
