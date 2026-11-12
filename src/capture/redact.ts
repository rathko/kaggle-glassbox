// Credential redaction for captured traffic. Works on parsed values, never on serialised JSON, so a
// redaction can never break the JSON it is applied to. Two rules:
//   1. any object key that names a credential (case-insensitive, separators ignored) has its value replaced;
//   2. any string value has token-shaped substrings replaced (Bearer/Basic auth, sk-/ghp_/xox- style keys,
//      user:password@ in URLs, and key/token/secret query parameters).
// It is a safety net for logs you might share, not a guarantee: never point a capture at traffic that
// carries secrets you cannot afford to bank.
export const REDACTED = "<redacted>";

// A key is compared with case and separators removed, by its ENDING, so provider-prefixed forms are caught too
// (openai_api_key, azureOpenAIApiKey, aws_secret_access_key, hf_token, huggingface_token). Any key ending in
// "token" is a credential except the bare "token" (logprobs entries are { token, logprob }, and redacting them
// would destroy a capture) and the tokenizer's special-token names below, which a chat template legitimately
// carries. Counters such as max_tokens / prompt_tokens end in "tokens" and are kept.
const SECRET_SUFFIXES = ["apikey", "accesskey", "secretkey", "privatekey", "secret", "password", "passwd", "passphrase",
  "token", "clientsecret", "authorization", "cookie", "sessionid", "credential", "credentials"];
const NOT_SECRET = new Set(["token", "bostoken", "eostoken", "padtoken", "unktoken", "septoken", "clstoken", "masktoken", "stoptoken"]);

export function isSecretKey(key: string): boolean {
  const k = key.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (NOT_SECRET.has(k)) return false;
  return k === "pwd" || SECRET_SUFFIXES.some((s) => k.endsWith(s));
}

const TOKEN_PATTERNS: [RegExp, string][] = [
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+\/=-]+/gi, `$1 ${REDACTED}`],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{8,}/g, REDACTED],
  [/\bxox[abpr]-[A-Za-z0-9-]{8,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bhf_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  [/(\/\/[^\/\s:@]+):[^@\s\/]+@/g, `$1:${REDACTED}@`],
  [/([?&](?:api[-_]?key|key|token|access[-_]?token|secret|password)=)[^&\s#]+/gi, `$1${REDACTED}`],
];

export function redactString(s: string): string {
  let out = s;
  for (const [re, rep] of TOKEN_PATTERNS) out = out.replace(re, rep);
  return out;
}

export function redactValue(v: unknown): unknown {
  if (typeof v === "string") return redactString(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = isSecretKey(k) && val != null ? REDACTED : redactValue(val);
    return out;
  }
  return v;
}
