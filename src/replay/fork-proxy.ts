#!/usr/bin/env bun
// fork-proxy: a model-endpoint proxy that makes a REAL agent harness resume a captured run from
// a fork step. For the first K model requests of a task it returns the CAPTURED responses of a
// source run, so the harness re-executes the same tool calls and rebuilds the same repo/sandbox
// state; from request K on it forwards to the real model server, so the model continues live
// under whatever package (prompt, tools, skills) the harness was started with. Grading stays
// entirely with the harness's own scoring — this proxy never changes it, it only changes which
// requests are answered from a recording versus answered live.
//
// WHY THIS IS CHEAP: re-running a task from scratch costs every step, including the steps whose
// outcome you already know and are not trying to change. Forking lets you pay only for the steps
// after the point you actually want to vary, N times over, to see how sensitive the outcome is to
// what happens next.
//
// Clock fidelity: forced response i is released no earlier than (first request time) + (at_i -
// req_at_0) of the source capture, where req_at_0 is when the source run's FIRST request arrived (wire-tap
// records it; captures without it fall back to at_0). The first answer's own latency is therefore replayed
// too, and the live part starts with the same wall-clock budget left as the original run had. `--fast` drops that and is useful only for debugging the proxy itself —
// never use it to produce a number you intend to compare against a timed run.
//
// Divergence: each forced step logs whether the tool-result messages the harness sent match the
// captured ones (for a harness that sends no tool messages, whether the message history matches, leaving out
// the roles in --ignore-roles, default "system": the system prompt is where an intervention usually goes, so
// comparing it would mark every forced step of a prompt fork divergent; pass --ignore-roles none to compare
// every message). A mismatch means the rebuilt state differs from the source run (e.g. a test with
// timing-dependent output, or a sandbox path that isn't deterministic); it is logged, never
// hidden, and fork-run.ts reports how many rollouts diverged.
//
// usage: bun src/replay/fork-proxy.ts --port P --upstream http://127.0.0.1:8010 \
//          --plan plan.json --log out.jsonl [--fast] [--ignore-roles system]
// The upstream may carry a path prefix (`--upstream https://host/api/v1`); the version segment is used once
// (see upstreamUrl in endpoint.ts).
//
// Readiness: GET /__fork/ready is answered by the proxy itself and never reaches the upstream, so a hosted
// endpoint that needs credentials (or has no /v1/models) cannot make a healthy proxy look down.
// plan.json: { "steps": [ { "at": iso, "req_at": iso (optional), "request": {...}, "response": {...} }, ... ] }
//   steps[i] is the i-th captured model exchange of the task (agent turns AND any
//   compaction/summary calls, in seq order); K = steps.length. A fork run serves exactly one
//   task, so requests are matched by ORDINAL within their KIND: the n-th agent turn (a request
//   that carries tools) gets the n-th captured agent turn; the n-th non-tool request (e.g. a
//   context-compaction summary call) gets the n-th captured one of those. A global ordinal would
//   break under compaction, where the message history shrinks and a summary call's position
//   among turns shifts.
import { readFileSync, appendFileSync } from "node:fs";
import { strictArgs } from "../cli-args";
import { upstreamUrl } from "./endpoint";
import { PROXY_IDLE_TIMEOUT, forwardHeaders, listenHost, urlHost } from "../capture/proxy-net";

const a = process.argv.slice(2);
if (a.includes("--help") || a.includes("-h")) { console.log("usage: bun src/replay/fork-proxy.ts --port P --plan plan.json --log forced.jsonl [--upstream URL] [--fast] [--kinds tools|single] [--normalise <regex>] [--ignore-roles system] [--listen-host 127.0.0.1] [--task-header x-task-id]\n(normally started for you by src/replay/fork-run.ts; see the replay section of the README)"); process.exit(0); }
strictArgs(a, { valued: ["port", "plan", "log", "upstream", "kinds", "normalise", "ignore-roles", "listen-host", "task-header"], bool: ["fast"] },
  "usage: bun src/replay/fork-proxy.ts --port P --plan plan.json --log forced.jsonl [--upstream URL] [--fast] [--kinds tools|single] [--normalise <regex>] [--ignore-roles system] [--listen-host 127.0.0.1] [--task-header x-task-id]");
for (const req of ["port", "plan", "log"]) if (!a.includes(`--${req}`)) { console.error(`missing --${req}\n`+"usage: bun src/replay/fork-proxy.ts --port P --plan plan.json --log forced.jsonl [--upstream URL] [--fast]\n(normally started for you by src/replay/fork-run.ts; see the replay section of the README)"); process.exit(2); }
const flag = (n: string) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };
const PORT = Number(flag("port")), UPSTREAM = flag("upstream") ?? "http://127.0.0.1:8010";
const plan = JSON.parse(readFileSync(flag("plan")!, "utf8"));
const LOG = flag("log")!, FAST = a.includes("--fast");
// loopback unless --listen-host opens another interface (a harness in a container); the task-id header is read by
// nobody here but is still removed before the live request goes upstream (see capture/proxy-net.ts)
let HOST: string;
try { HOST = listenHost(flag("listen-host"), "fork-proxy"); } catch (e) { console.error((e as Error).message); process.exit(2); }
const TASK_HEADER = (flag("task-header") ?? "x-task-id").toLowerCase();
const K: number = plan.steps.length;
const t0src = Date.parse(plan.steps[0]?.req_at ?? plan.steps[0]?.at ?? new Date().toISOString());
let t0live: number | null = null;
// --kinds tools (default): agent turns (requests that carry tools) and other calls (e.g. compaction summaries)
// are matched by ordinal within their own kind. --kinds single: one ordinal queue, for agents that never send
// tools or that change their tool list between turns.
const KINDS = flag("kinds") ?? "tools";
if (KINDS !== "tools" && KINDS !== "single") { console.error("--kinds must be tools or single"); process.exit(2); }
const isTurn = (r: any) => KINDS === "single" ? true : !!r?.tools?.length;
plan.steps.forEach((st: any, i: number) => { st.__i = i; });
const queue = { turn: plan.steps.filter((s: any) => isTurn(s.request)), summary: plan.steps.filter((s: any) => !isTurn(s.request)) };
// The two queues are matched by ordinal within their kind, but the SOURCE ORDER across kinds must hold too: a
// summary call that arrives before the agent turn that preceded it in the capture would otherwise get a future
// captured answer. Out-of-order service is logged as divergent (order_ok false), never silently forced.
const served = new Set<number>();
let nextExpected = 0;
const used = { turn: 0, summary: 0 };
let step = 0;

// A fresh sandbox usually lives under a fresh random temp/work dir per run; normalise any such
// path before comparing tool output, or every forced step looks "divergent" for a reason that has
// nothing to do with the thing you're testing. Pass --normalise <regex> to match your own harness's paths.
const SANDBOX_PATH_PATTERN = flag("normalise") ? new RegExp(flag("normalise")!, "g") : /\b(?:sandbox|workdir|tmp)_[A-Za-z0-9_-]{6,}\b/g;
// The live request's history is compared, message by message, with the captured request's: role, text, every
// assistant tool call (name, arguments, id) and every tool result (its call id and content). Comparing tool
// output alone misses a forced prefix that rebuilt different state behind the same output: two different
// write_file calls that both answer "Done!" are not the same step. System messages are skipped by default
// (--ignore-roles, default "system"; "none" compares every message), because the system prompt is the usual
// thing a fork experiment changes.
const IGNORE_ROLES = new Set((flag("ignore-roles") ?? "system") === "none" ? [] : (flag("ignore-roles") ?? "system").split(",").map((r) => r.trim()).filter(Boolean));
const text = (c: unknown) => typeof c === "string" ? c : JSON.stringify(c ?? null);
function normaliseHistory(msgs: any[], ignore: Set<string> = IGNORE_ROLES, pattern: RegExp = SANDBOX_PATH_PATTERN): string[] {
  return msgs.filter((m) => !ignore.has(m?.role)).map((m) => JSON.stringify([
    m?.role ?? null, text(m?.content),
    (m?.tool_calls ?? []).map((t: any) => [t?.id ?? null, t?.function?.name ?? null, text(t?.function?.arguments)]),
    m?.tool_call_id ?? null,
  ]).replace(pattern, "sandbox_X"));
}
const history = (msgs: any[]) => normaliseHistory(msgs);
const log = (o: Record<string, unknown>) => appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n");

// A harness that asked for a stream gets the captured answer as server-sent events: one chunk per choice carrying
// the whole message as its delta, then [DONE]. Clients that accumulate deltas rebuild the same message.
function toSse(response: any): string {
  const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const choices = (response?.choices ?? []).map((c: any, i: number) => ({
    index: c.index ?? i, finish_reason: c.finish_reason ?? null,
    delta: { ...c.message, tool_calls: c.message?.tool_calls?.map((t: any, k: number) => ({ index: k, ...t })) },
  }));
  return ev({ id: response?.id, object: "chat.completion.chunk", model: response?.model, choices }) +
    (response?.usage ? ev({ id: response?.id, object: "chat.completion.chunk", choices: [], usage: response.usage }) : "") + "data: [DONE]\n\n";
}

const DROP = new Set(["content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive"]);

const server = Bun.serve({
  port: PORT, hostname: HOST, idleTimeout: PROXY_IDLE_TIMEOUT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/__fork/ready") return Response.json({ ready: true, forcing: K });
    const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
    if (url.pathname.includes("chat/completions") && body) {
      let j: any = null;
      try { j = JSON.parse(body); } catch {}
      const msgs: any[] = j?.messages ?? [];
      const kind = isTurn(j) ? "turn" : "summary";
      const src: any = queue[kind][used[kind]];
      step++;
      if (src) {
        used[kind]++;
        t0live ??= Date.now();
        const wait = FAST ? 0 : t0live + (Date.parse(src.at) - t0src) - Date.now();
        if (wait > 0) await Bun.sleep(wait);
        const orderOk = src.__i === nextExpected;
        served.add(src.__i);
        while (served.has(nextExpected)) nextExpected++;
        const want = history(src.request.messages ?? []), got = history(msgs);
        const compared = "history";
        const same = orderOk && want.length === got.length && want.every((w, i) => w === got[i]);
        const diffAt = same ? -1 : want.findIndex((w, i) => w !== got[i]);
        log({ kind: "forced", req: kind, step: step - 1, same, order_ok: orderOk, source_step: src.__i, compared, diff_at: diffAt, msgs: got.length, want_msgs: want.length, tool_msgs: msgs.filter((m) => m?.role === "tool").length });
        if (j?.stream) return new Response(toSse(src.response), { status: 200, headers: { "Content-Type": "text/event-stream" } });
        return new Response(JSON.stringify(src.response), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      log({ kind: "live", req: kind, step: step - 1 });
    }
    const headers = forwardHeaders(req.headers, TASK_HEADER);
    try {
      // the live suffix is passed through as it arrives (a streamed answer stays a stream), never buffered
      const r = await fetch(upstreamUrl(UPSTREAM, url.pathname + url.search), { method: req.method, headers, body: body || undefined });
      const out = new Headers();
      r.headers.forEach((v, k) => { if (!DROP.has(k.toLowerCase())) out.set(k, v); });
      return new Response(r.body, { status: r.status, headers: out });
    } catch (e) {
      log({ kind: "upstream-error", error: String(e) });
      return new Response(JSON.stringify({ error: String(e) }), { status: 502 });
    }
  },
});
console.log(`fork-proxy :${server.port} on ${urlHost(HOST)} -> ${UPSTREAM} · forcing ${K} steps · clock ${FAST ? "off" : "faithful"}`);
