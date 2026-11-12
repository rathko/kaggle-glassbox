import { test, expect, afterAll } from "bun:test";
import { chatComplete, resolveChatConfig, stripThinking } from "./openai-chat";

const seen: any[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body: any = await req.json();
    seen.push({ url: new URL(req.url).pathname, auth: req.headers.get("authorization"), body });
    if (body.model === "fail") return new Response("boom", { status: 500 });
    if (body.model === "empty") return Response.json({ choices: [{ message: { role: "assistant", content: "" } }] });
    return Response.json({ choices: [{ message: { role: "assistant", content: "<think>hidden</think>VERDICT: ok" } }] });
  },
});
const base = `http://127.0.0.1:${server.port}/v1`;
afterAll(() => server.stop(true));

test("resolveChatConfig: flags beat env, and base URL + model are required", () => {
  const env = { FRONTIER_BASE_URL: "http://env/v1", FRONTIER_MODEL: "m-env", FRONTIER_API_KEY: "k-env" };
  expect(resolveChatConfig([], env)).toMatchObject({ baseUrl: "http://env/v1", model: "m-env", apiKey: "k-env" });
  expect(resolveChatConfig(["--model", "m-flag", "--base-url", "http://flag/v1/"], env)).toMatchObject({ baseUrl: "http://flag/v1", model: "m-flag" });
  expect(() => resolveChatConfig([], {})).toThrow(/FRONTIER_BASE_URL/);
  expect(() => resolveChatConfig(["--base-url", "http://x"], {})).toThrow(/FRONTIER_MODEL/);
});

test("chatComplete posts an OpenAI-compatible body, sends the key, and strips think blocks", async () => {
  const out = await chatComplete({ baseUrl: base, model: "m", apiKey: "secret", maxTokens: 100, temperature: 0, timeoutMs: 5000 }, "SYS", "USER");
  expect(out).toBe("VERDICT: ok");
  const last = seen[seen.length - 1];
  expect(last.url).toBe("/v1/chat/completions");
  expect(last.auth).toBe("Bearer secret");
  expect(last.body.messages).toEqual([{ role: "system", content: "SYS" }, { role: "user", content: "USER" }]);
  expect(last.body.max_tokens).toBe(100);
});

test("chatComplete omits the auth header when no key is set (local vLLM)", async () => {
  await chatComplete({ baseUrl: base, model: "m", maxTokens: 10, temperature: 0, timeoutMs: 5000 }, "s", "u");
  expect(seen[seen.length - 1].auth).toBeNull();
});

test("chatComplete throws on HTTP errors and empty content instead of returning nothing", async () => {
  const cfg = { baseUrl: base, maxTokens: 10, temperature: 0, timeoutMs: 5000 };
  await expect(chatComplete({ ...cfg, model: "fail" }, "s", "u")).rejects.toThrow(/HTTP 500.*boom/);
  await expect(chatComplete({ ...cfg, model: "empty" }, "s", "u")).rejects.toThrow(/empty/);
});

test("stripThinking removes reasoning blocks only", () => {
  expect(stripThinking("<think>a\nb</think>\nX")).toBe("X");
  expect(stripThinking("plain")).toBe("plain");
});
