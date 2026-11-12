import { expect, test } from "bun:test";
import { PROXY_IDLE_TIMEOUT, forwardHeaders, isLoopback, listenHost, urlHost } from "./proxy-net";

test("no idle timeout, so a long non-streamed answer is not cut off at Bun's 255 s maximum", () => {
  expect(PROXY_IDLE_TIMEOUT).toBe(0);
  const s = Bun.serve({ port: 0, idleTimeout: PROXY_IDLE_TIMEOUT, fetch: () => new Response("") });
  s.stop(true);
});

test("forwardHeaders drops the task header, hop-by-hop, proxy-* and Connection-named headers", () => {
  const h = new Headers({
    host: "a", "content-length": "3", connection: "keep-alive, x-hop", "keep-alive": "1", te: "trailers", trailer: "x",
    upgrade: "h2c", "proxy-authorization": "p", "x-hop": "1", "X-Task-Id": "t1", authorization: "Bearer k", "content-type": "application/json",
  });
  const out = forwardHeaders(h, "x-task-id");
  expect([...out.keys()].sort()).toEqual(["authorization", "content-type"]);
  expect(forwardHeaders(new Headers({ "x-run": "r" }), "X-Run").has("x-run")).toBe(false);
});

test("loopback detection and listen-host validation", () => {
  for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"]) expect(isLoopback(h)).toBe(true);
  for (const h of ["0.0.0.0", "172.17.0.1", "::", "example.com"]) expect(isLoopback(h)).toBe(false);
  expect(listenHost(undefined, "t")).toBe("127.0.0.1");
  expect(() => listenHost("", "t")).toThrow(/listen-host/);
  expect(() => listenHost("a b", "t")).toThrow(/listen-host/);
  expect(urlHost("::1")).toBe("[::1]");
  expect(urlHost("10.0.0.2")).toBe("10.0.0.2");
});
