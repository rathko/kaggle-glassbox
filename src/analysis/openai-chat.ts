// openai-chat: the one model call the frontier analysis makes, against any OpenAI-compatible
// chat-completions endpoint (a local vLLM or llama.cpp server, or a hosted API).
//
// Configuration comes from flags or environment variables, never from hardcoded hosts:
//   --base-url  / FRONTIER_BASE_URL   e.g. http://127.0.0.1:8000/v1 (the path that ends in /v1)
//   --model     / FRONTIER_MODEL      the model name the server expects
//   --api-key   / FRONTIER_API_KEY    optional; omitted entirely when unset (local servers)
//   --max-tokens (default 2048), --temperature (default 0.2), --timeout-ms (default 600000)
//
// Prefer the env var for the key: a flag value is visible in the process list.
//
// A failed or empty call THROWS. The caller must never mistake "the call failed" for "the analyst
// had nothing to say", so there is no code path that returns an empty string.

export type ChatConfig = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
};

export function resolveChatConfig(argv: string[], env: Record<string, string | undefined> = process.env): ChatConfig {
  const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const baseUrl = (flag("base-url") || env.FRONTIER_BASE_URL || "").replace(/\/+$/, "");
  const model = flag("model") || env.FRONTIER_MODEL || "";
  if (!baseUrl) throw new Error("no endpoint: pass --base-url or set FRONTIER_BASE_URL (an OpenAI-compatible base URL ending in /v1)");
  if (!model) throw new Error("no model: pass --model or set FRONTIER_MODEL");
  return {
    baseUrl,
    model,
    apiKey: flag("api-key") || env.FRONTIER_API_KEY || undefined,
    maxTokens: Number(flag("max-tokens") ?? 2048),
    temperature: Number(flag("temperature") ?? 0.2),
    timeoutMs: Number(flag("timeout-ms") ?? 600000),
  };
}

/** Reasoning models served without a separate reasoning parser inline their thinking. */
export function stripThinking(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export async function chatComplete(cfg: ChatConfig, system: string, user: string): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_tokens: cfg.maxTokens,
      temperature: cfg.temperature,
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${cfg.baseUrl}/chat/completions: ${text.slice(0, 400)}`);
  let content = "";
  try { content = String(JSON.parse(text).choices?.[0]?.message?.content ?? ""); }
  catch { throw new Error(`unparseable response: ${text.slice(0, 400)}`); }
  const out = stripThinking(content);
  if (!out) throw new Error("empty completion (no content in choices[0].message)");
  return out;
}
