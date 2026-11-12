// proxy-net: the network settings wire-tap.ts and fork-proxy.ts share.
//
// Listen host. Both proxies bind loopback by default: a capture proxy on a public interface would hand anyone on
// the network a free model endpoint and a copy of every prompt. A harness in a container cannot reach the host's
// loopback, so `--listen-host` opens another interface (the container bridge address, or 0.0.0.0) on purpose, and
// a non-loopback bind prints a warning.
//
// No idle timeout. A non-streamed answer from a long-reasoning model can take many minutes with no bytes on the
// wire; Bun's default (and its 255 s maximum) would cut the client off mid-call. 0 disables it.
//
// Forwarded headers. The task-id header is instrumentation for the proxy: it is read, then removed, so a private
// task id never reaches the model provider (and a provider that rejects unknown headers still works). Hop-by-hop
// and transport headers describe this connection, not the upstream one, and are dropped as a proxy must
// (RFC 9110 section 7.6.1), including any header the client named in its Connection header.

export const PROXY_IDLE_TIMEOUT = 0;
export const DEFAULT_LISTEN_HOST = "127.0.0.1";

const HOP_BY_HOP = new Set(["host", "content-length", "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade"]);

export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/** The request headers to send upstream: everything except the task-id header, hop-by-hop/transport headers,
 *  proxy-* headers, and any header the Connection header lists. */
export function forwardHeaders(incoming: Headers, taskHeader: string): Headers {
  const named = new Set((incoming.get("connection") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const task = taskHeader.toLowerCase(), out = new Headers();
  incoming.forEach((v, k) => {
    const key = k.toLowerCase();
    if (key === task || HOP_BY_HOP.has(key) || key.startsWith("proxy-") || named.has(key)) return;
    out.set(k, v);
  });
  return out;
}

/** Validates a --listen-host value and warns (to stderr) when it is not loopback. Returns the host. */
export function listenHost(value: string | undefined, tool: string): string {
  const host = value ?? DEFAULT_LISTEN_HOST;
  if (!host.trim() || /[\s/]/.test(host)) throw new Error(`--listen-host must be a host name or address, got "${host}"`);
  if (!isLoopback(host))
    console.error(`${tool}: listening on ${host}, not loopback: anything that can reach this address can use the model endpoint through this proxy. Bind the narrowest interface your harness needs.`);
  return host;
}

/** The host part of a URL: IPv6 literals need brackets. */
export const urlHost = (host: string) => host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
