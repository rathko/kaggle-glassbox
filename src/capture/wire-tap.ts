#!/usr/bin/env bun
// wire-tap: a transparent forward proxy that observes exactly what an evaluator/agent harness
// sends to, and receives from, an OpenAI-compatible chat-completions endpoint.
//
// WHY THIS EXISTS. Config files tell you what a harness is *supposed* to send. They do not tell
// you what actually went over the wire. The only way to settle a dispute about a sampling
// parameter, a thinking/reasoning knob, or a tool definition is to read the real request body,
// not reason about it from source. This proxy sits between the harness and the model server and
// records both sides of every exchange.
//
// It binds a port you choose (default a high, unused local port) and forwards everything
// unmodified unless `--inject` is given. It never assumes it owns any particular port — pass the
// one your real model server is NOT using.
//
// INJECTION MODE. `--inject '<json>'` merges the given keys into every outbound chat-completions
// body. Use this when the harness itself cannot be configured to send a parameter you want to
// test (e.g. a reasoning-effort switch) but the server honours it when present. This makes the
// proxy an INSTRUMENT MODIFICATION: any run through it with `--inject` set is observational only
// and should never be treated as a baseline or scored candidate. Every mutated request is logged
// with the list of injected keys so this is auditable after the fact, not just asserted.
//
// FULL-SNAPSHOT CAPTURE. `--capture-full <dir>` writes one JSON file per chat-completions
// exchange: the COMPLETE request (messages, tools, params) and the COMPLETE response, with
// obvious secret-shaped strings redacted. These snapshots are the input to replay/step-replay.ts
// and replay/fork-run.ts: "run once, measure many times" instead of re-running the whole task.
// Pass-through stays byte-faithful when --inject is absent; only the captured copy on disk can
// differ from what the server actually received.
//
// usage:
//   bun src/capture/wire-tap.ts [--port N] [--upstream URL] [--log FILE] [--inject '<json>']
//                                [--capture-full DIR] [--append] [--shared-perms] [--listen-host 127.0.0.1]
//
// The proxy binds 127.0.0.1 unless --listen-host names another interface (a harness in a container cannot reach
// the host's loopback); a non-loopback bind prints a warning. There is no idle timeout, so a non-streamed answer
// that takes many minutes is not cut off. The task-id header and hop-by-hop headers are removed before the request
// goes upstream: the task id is for this proxy, not for the model provider (see proxy-net.ts).
//
// A capture directory that already holds snapshots is refused: a restart would number from 1 again and
// overwrite the earlier evidence. `--append` resumes numbering after the highest seq already there (raw or
// compacted), for a run that genuinely continues.
//
// LIFECYCLE. `GET /__wiretap/ready` answers 200 locally once the proxy is listening (never proxied, never logged, no
// seq used), so a script can wait for it before starting the harness. SIGTERM or SIGINT stops accepting requests,
// lets every in-flight exchange finish and its capture land on disk, then exits 0; if exchanges are still open after
// WIRE_TAP_DRAIN_MS (default 30000) it exits 1 and says how many, because the capture is then incomplete.
//
// The upstream may carry a path prefix (`--upstream https://host/api/v1`): a request for /v1/chat/completions then
// goes to https://host/api/v1/chat/completions, not .../v1/v1/... (see upstreamUrl in replay/endpoint.ts).
//
// Defaults are all relative/local so this runs out of the box against a model server on
// 127.0.0.1:8010 and writes its log under ./capture/wire-tap.jsonl. Override every path via flags
// or environment variables (WIRE_TAP_PORT, WIRE_TAP_UPSTREAM, WIRE_TAP_LOG) — never hardcode a
// path into this file.
import { mkdirSync, appendFileSync, writeFileSync, chmodSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { redactValue } from "./redact";
import { assembleSse } from "./sse";
import { upstreamUrl } from "../replay/endpoint";
import { strictArgs } from "../cli-args";
import { PROXY_IDLE_TIMEOUT, forwardHeaders, listenHost, urlHost } from "./proxy-net";

const argv = process.argv.slice(2);
strictArgs(argv, { valued: ["port", "upstream", "log", "inject", "capture-full", "task-header", "listen-host"], bool: ["append", "shared-perms"] },
  "usage: bun src/capture/wire-tap.ts [--port N] [--upstream URL] [--log FILE] [--inject <json>] [--capture-full DIR] [--append] [--shared-perms] [--task-header x-task-id] [--listen-host 127.0.0.1]\n(defaults: port 8810, upstream http://127.0.0.1:8010, log ./capture/wire-tap.jsonl; env WIRE_TAP_PORT, WIRE_TAP_UPSTREAM, WIRE_TAP_LOG)");
const flag = (name: string, def?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};

const PORT = Number(flag("port", process.env.WIRE_TAP_PORT ?? "8810"));
const UPSTREAM = flag("upstream", process.env.WIRE_TAP_UPSTREAM ?? "http://127.0.0.1:8010")!;
const LOGFILE = flag("log", process.env.WIRE_TAP_LOG ?? "./capture/wire-tap.jsonl")!;
// Optional: a harness that sends its task id in a request header gets exact per-task grouping downstream
// (capture-compact groups by it), with no need to match traces or prompts.
const TASK_HEADER = flag("task-header", "x-task-id")!.toLowerCase();
let HOST: string;
try { HOST = listenHost(flag("listen-host"), "wire-tap"); } catch (e) { console.error((e as Error).message); process.exit(2); }
const INJECT: Record<string, unknown> | null = (() => {
  const raw = flag("inject");
  return raw ? JSON.parse(raw) : null;
})();
const CAPTURE_DIR = flag("capture-full") ?? null;
// Captures hold whole prompts and answers: owner-only by default. --shared-perms makes them group-writable
// (dir 775, files 664) for a team box where several users share one capture tree.
const SHARED = process.argv.includes("--shared-perms");
const DIR_MODE = SHARED ? 0o775 : 0o700, FILE_MODE = SHARED ? 0o664 : 0o600;

mkdirSync(require("node:path").dirname(LOGFILE), { recursive: true });
let n = 0;
if (CAPTURE_DIR) {
  // ANY entry counts: a stale task-index.json or a misnamed snapshot is still somebody's evidence
  const existing = existsSync(CAPTURE_DIR) ? readdirSync(CAPTURE_DIR) : [];
  if (existing.length && !argv.includes("--append")) {
    console.error(`wire-tap: ${CAPTURE_DIR} is not empty (${existing.length} entr${existing.length === 1 ? "y" : "ies"}: ${existing.slice(0, 5).join(", ")}${existing.length > 5 ? ", ..." : ""}); refusing to mix a new capture into it. Use a fresh directory, or --append to continue numbering after it.`);
    process.exit(2);
  }
  // resume after the highest seq already captured, raw or compacted
  for (const f of existing) {
    if (/^\d+\.json$/.test(f)) n = Math.max(n, Number(f.slice(0, -5)));
    else if (f.endsWith(".jsonl.gz"))
      for (const l of Buffer.from(Bun.gunzipSync(readFileSync(`${CAPTURE_DIR}/${f}`))).toString("utf8").split("\n")) if (l) n = Math.max(n, Number(JSON.parse(l).seq) || 0);
  }
  mkdirSync(CAPTURE_DIR, { recursive: true });
  try { chmodSync(CAPTURE_DIR, DIR_MODE); } catch {}
}

// Never bank a credential shape, even against a local/dev endpoint. Redaction runs on parsed values
// (see redact.ts), so it can never corrupt the JSON it protects.
const redactJson = (v: unknown) => JSON.stringify(redactValue(v));

// Upstream headers go back to the client, except the ones that describe the wire encoding fetch() has already
// undone (the body we forward is decoded) and hop-by-hop headers.
const DROP = new Set(["content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive"]);
const passHeaders = (h: Headers) => { const o = new Headers(); h.forEach((v, k) => { if (!DROP.has(k.toLowerCase())) o.set(k, v); }); return o; };

// exchanges that have started but whose capture is not yet written (a streamed one ends in its flush)
let inflight = 0, stopping = false;
const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: PROXY_IDLE_TIMEOUT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/__wiretap/ready") return new Response(stopping ? "stopping\n" : "ready\n", { status: stopping ? 503 : 200 });
    if (stopping) return Response.json({ error: { message: "wire-tap is shutting down", type: "proxy_stopping" } }, { status: 503 });
    inflight++;
    let handedToStream = false;
    try {
    const id = ++n;
    // request arrival: fork-proxy schedules forced answers from this, so the first answer's latency is replayed too
    const reqAt = new Date().toISOString();
    const target = upstreamUrl(UPSTREAM, url.pathname + url.search);
    const taskId = req.headers.get(TASK_HEADER);
    let reqBody = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();

    // Injection, applied only to chat completions and only when the body parses. A failure to
    // parse must pass the body through UNCHANGED rather than drop the call — a silently broken
    // request would look like a model failure and poison whatever is being measured.
    let injectedKeys: string[] | null = null;
    if (INJECT && reqBody && url.pathname.includes("chat/completions")) {
      try {
        const parsed = JSON.parse(reqBody);
        Object.assign(parsed, INJECT);
        reqBody = JSON.stringify(parsed);
        injectedKeys = Object.keys(INJECT);
      } catch { injectedKeys = null; }
    }

    let res: Response, err: string | null = null;
    try {
      // Content-Length from the original request is stale after injection; let fetch set it. The task-id header
      // and hop-by-hop headers stay here (forwardHeaders).
      const headers = forwardHeaders(req.headers, TASK_HEADER);
      res = await fetch(target, { method: req.method, headers, body: reqBody || undefined });
    } catch (e) {
      err = String(e);
      res = new Response(JSON.stringify({ error: err }), { status: 502, headers: { "content-type": "application/json" } });
    }

    // A streamed answer (server-sent events) is forwarded event by event as it arrives, and a copy is kept to be
    // reassembled into one response object. The snapshot is written in the stream's flush, BEFORE the client sees
    // end-of-stream: a harness that closes its run the moment its last answer ends cannot miss that exchange.
    // A capture that cannot be written (disk full, a bug) must FAIL the client's stream, not end it cleanly, or the
    // harness would close and seal a run missing this exchange. Bun's server ends a chunked response cleanly even
    // when its body stream errors, so the failure is signalled in-band instead: the "data: [DONE]" event (and
    // anything after it) is held back until the snapshot is on disk, and on failure is replaced by an
    // `event: error` whose data carries an `error` object. OpenAI-style clients raise on that event, and the
    // stream has no [DONE], so it also reads as cut off (sse.ts marks it invalid).
    const streamed = (res.headers.get("content-type") ?? "").includes("text/event-stream") && res.body !== null;
    if (streamed) {
      const status = res.status, kept: Uint8Array[] = [];
      let pending = Buffer.alloc(0), held: Buffer | null = null;
      const drain = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          kept.push(chunk);
          if (held) { held = Buffer.concat([held, chunk]); return; }
          pending = Buffer.concat([pending, chunk]);
          // forward whole events only; once an event is [DONE], it and the rest wait for the capture
          const text = pending.toString("latin1"), sepRe = /\r\n\r\n|\n\n|\r\r/g;
          let cut = 0, m: RegExpExecArray | null;
          while ((m = sepRe.exec(text))) {
            const event = text.slice(cut, m.index);
            if (/^data:\s*\[DONE\]\s*$/m.test(event)) { held = pending.subarray(cut); break; }
            cut = m.index + m[0].length;
          }
          if (cut) ctl.enqueue(pending.subarray(0, cut));
          pending = held ? Buffer.alloc(0) : pending.subarray(cut);
        },
        flush(ctl) {
          try { record(Buffer.concat(kept).toString("utf8"), status, err, true); }
          catch (e) {
            inflight--;
            console.error(`wire-tap: capture of #${id} failed: ${e}`);
            // nothing still pending or held is forwarded: an unterminated last event can itself be [DONE], and a
            // client that sees [DONE] first would accept the answer and never read the error
            pending = Buffer.alloc(0); held = null;
            ctl.enqueue(Buffer.from(`event: error\ndata: ${JSON.stringify({ error: { message: `wire-tap: capture of exchange #${id} failed; this run is missing an exchange`, type: "capture_failed" } })}\n\n`));
            return;
          }
          inflight--;
          if (pending.length) ctl.enqueue(pending);
          if (held) ctl.enqueue(held);
        },
      });
      handedToStream = true;
      return new Response(res.body!.pipeThrough(drain), { status: res.status, headers: passHeaders(res.headers) });
    }
    const resBody = await res.text();
    record(resBody, res.status, err, false);
    return new Response(resBody, { status: res.status, headers: passHeaders(res.headers) });

    function record(resBody: string, status: number, err: string | null, streamed: boolean): void {
      // Record the SHAPE of the exchange: which params survived, and what came back.
      let reqJson: any = null, resJson: any = null;
      try { reqJson = reqBody ? JSON.parse(reqBody) : null; } catch {}
      if (streamed) resJson = assembleSse(resBody, { n: reqJson?.n });
      else try { resJson = resBody ? JSON.parse(resBody) : null; } catch {}
      const msg = resJson?.choices?.[0]?.message ?? resJson?.message ?? {};
      const reasoning = msg.reasoning ?? msg.reasoning_content ?? msg.thinking ?? null;

      const entry = {
        n: id,
        at: new Date().toISOString(),
        req_at: reqAt,
        method: req.method,
        path: url.pathname,
        status,
        error: err,
        streamed,
      task_id: taskId,
        // Which keys this proxy ADDED. Null means the request went through untouched, so a run's
        // log proves whether an instrument modification actually applied on every call.
        injected: injectedKeys,
        request_param_keys: reqJson ? Object.keys(reqJson).sort() : null,
        reasoning_effort: reqJson?.reasoning_effort ?? null,
        thinking_level: reqJson?.thinking_level ?? null,
        thinking_budget: reqJson?.thinking_budget ?? null,
        thinking_config: reqJson?.thinking_config ?? null,
        extra_body: reqJson?.extra_body ?? null,
        chat_template_kwargs: reqJson?.chat_template_kwargs ?? null,
        top_k: reqJson?.top_k ?? null,
        top_p: reqJson?.top_p ?? null,
        max_tokens: reqJson?.max_tokens ?? reqJson?.max_completion_tokens ?? null,
        temperature: reqJson?.temperature ?? null,
        n_messages: Array.isArray(reqJson?.messages) ? reqJson.messages.length : null,
        n_tools: Array.isArray(reqJson?.tools) ? reqJson.tools.length : null,
        // response side
        reasoning_chars: reasoning ? String(reasoning).length : 0,
        content_chars: msg.content ? String(msg.content).length : 0,
        completion_tokens: resJson?.usage?.completion_tokens ?? resJson?.eval_count ?? null,
        prompt_tokens: resJson?.usage?.prompt_tokens ?? resJson?.prompt_eval_count ?? null,
        finish_reason: resJson?.choices?.[0]?.finish_reason ?? resJson?.done_reason ?? null,
        // First few requests: keep the full body MINUS messages/tools (which are huge and are not
        // what is normally in question) so the param set can be audited by hand.
        full_params: id <= 3 && reqJson
          ? redactJson(Object.fromEntries(
              Object.entries(reqJson).filter(([k]) => k !== "messages" && k !== "tools")
            )).slice(0, 8000)
          : undefined,
        full_message: id === 1 ? redactJson(msg).slice(0, 4000) : undefined,
      };
      // the whole entry is redacted, not just full_params: thinking_config, extra_body and chat_template_kwargs are
      // copied as objects and can carry nested credentials
      appendFileSync(LOGFILE, redactJson(entry) + "\n", { mode: FILE_MODE });

      if (CAPTURE_DIR && url.pathname.includes("chat/completions")) {
        const snap = { seq: id, req_at: reqAt, at: entry.at, status, injected: injectedKeys, streamed, task_id: taskId, request: reqJson, response: resJson };
        const f = `${CAPTURE_DIR}/${String(id).padStart(6, "0")}.json`;
        writeFileSync(f, redactJson(snap), { mode: FILE_MODE });
        try { chmodSync(f, FILE_MODE); } catch {}
      }
    }
    } finally { if (!handedToStream) inflight--; }
  },
});

// Stop on a signal without losing an exchange: refuse new requests, wait for every open exchange's capture, exit 0.
const DRAIN_MS = Number(process.env.WIRE_TAP_DRAIN_MS ?? 30000);
async function shutdown(sig: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  // stop accepting connections; the promise resolves once every open response (streamed bodies included) is sent
  const sent = Promise.resolve(server.stop()).then(() => true);
  const t0 = Date.now();
  await Promise.race([sent, Bun.sleep(DRAIN_MS).then(() => false)]);
  while (inflight > 0 && Date.now() - t0 < DRAIN_MS) await Bun.sleep(10);
  if (inflight > 0) { console.error(`wire-tap: ${sig}: ${inflight} exchange(s) still open after ${DRAIN_MS} ms; their captures are missing`); process.exit(1); }
  console.log(`wire-tap: ${sig}: stopped after ${n} exchange(s), every capture written`);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try { chmodSync(LOGFILE, FILE_MODE); } catch {}
console.log(`wire-tap on http://${urlHost(HOST)}:${server.port} -> ${UPSTREAM} · log ${LOGFILE}`);
if (CAPTURE_DIR) console.log(`capturing full snapshots to ${CAPTURE_DIR}`);
