// endpoint: the one way the replay tools reach a model server. Any OpenAI-compatible chat-completions
// endpoint works, local or hosted:
//   --base http://127.0.0.1:8010            -> http://127.0.0.1:8010/v1/chat/completions
//   --base https://api.example.com/v1       -> https://api.example.com/v1/chat/completions
//   --base https://host/custom/chat/completions (used as given)
// The key comes from REPLAY_API_KEY (sent as a Bearer token) and is never read from a flag, because a flag
// is visible in the process list. A non-2xx answer or a body without choices THROWS: a throttled or
// unauthorised call must never be counted as a model behaviour.

export function chatUrl(base: string): string {
  const b = base.replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/v\d+$/.test(b)) return `${b}/chat/completions`;
  return `${b}/v1/chat/completions`;
}

/** Joins a proxy's upstream base and an incoming request path. The base may carry a path prefix: when it ends in an
 *  API version segment (/v1) and the request path starts with the same segment, the segment is used once, so
 *  https://host/api/v1 + /v1/chat/completions -> https://host/api/v1/chat/completions (not /v1/v1/). */
export function upstreamUrl(upstream: string, pathAndQuery: string): string {
  const base = upstream.replace(/\/+$/, "");
  const ver = base.match(/(\/v\d+)$/)?.[1];
  const p = pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`;
  if (ver && (p === ver || p.startsWith(`${ver}/`) || p.startsWith(`${ver}?`))) return base + p.slice(ver.length);
  return base + p;
}

export function authHeaders(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (env.REPLAY_API_KEY) h.authorization = `Bearer ${env.REPLAY_API_KEY}`;
  return h;
}

import { assembleSse } from "../capture/sse";
import { choiceProblems } from "./capture-valid";

/** POST one chat-completions request; returns the parsed body or throws with the status and a short excerpt.
 *  A replay asks for no stream: `stream` / `stream_options` from a captured streamed request are dropped. A
 *  server that streams anyway (text/event-stream) is assembled into the same shape wire-tap captured, and an
 *  invalid stream (malformed, error event, cut off) throws. */
export async function postChat(base: string, req: unknown, timeoutMs = 600_000): Promise<any> {
  const url = chatUrl(base);
  const payload: any = req && typeof req === "object" ? { ...(req as object) } : req;
  if (payload && typeof payload === "object") { delete payload.stream; delete payload.stream_options; }
  const res = await fetch(url, { method: "POST", headers: authHeaders(), body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 300)}`);
  let body: any;
  if (/text\/event-stream/i.test(res.headers.get("content-type") ?? "")) {
    body = assembleSse(text, { n: payload?.n });
    if (!body) throw new Error(`empty event stream from ${url}`);
    if (body.stream_invalid) throw new Error(`invalid event stream from ${url} (${body.invalid_reasons.join(", ")}): ${text.slice(0, 300)}`);
  } else {
    try { body = JSON.parse(text); } catch { throw new Error(`unparseable response from ${url}: ${text.slice(0, 300)}`); }
  }
  // the same rule as a captured exchange: a body that carries an error is not a model answer, even beside choices
  if (body?.error != null) throw new Error(`response from ${url} carries an error: ${text.slice(0, 300)}`);
  const bad = choiceProblems(body?.choices);
  if (bad.length) throw new Error(`response from ${url} is not a usable answer (${bad.join(", ")}): ${text.slice(0, 300)}`);
  return body;
}
