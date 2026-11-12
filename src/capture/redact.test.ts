import { test, expect } from "bun:test";
import { redactValue, redactString, isSecretKey, REDACTED } from "./redact";

test("credential keys are redacted at any depth, any case, any separator", () => {
  const r: any = redactValue({ apiKey: "a", nested: { Access_Token: "b", list: [{ PASSWORD: "c" }, { "x-api-key": "d" }] }, model: "m" });
  expect(r.apiKey).toBe(REDACTED);
  expect(r.nested.Access_Token).toBe(REDACTED);
  expect(r.nested.list[0].PASSWORD).toBe(REDACTED);
  expect(r.nested.list[1]["x-api-key"]).toBe(REDACTED);
  expect(r.model).toBe("m");
});

test("token shapes inside strings are redacted without touching the surrounding text", () => {
  expect(redactString("Authorization: Bearer abc.def-123 then")).toBe(`Authorization: Bearer ${REDACTED} then`);
  expect(redactString("Basic dXNlcjpwYXNz")).toBe(`Basic ${REDACTED}`);
  expect(redactString("key sk-abcdefghijklmnop end")).toBe(`key ${REDACTED} end`);
  expect(redactString("https://u:hunter2@host/x")).toBe(`https://u:${REDACTED}@host/x`);
  expect(redactString("https://h/x?model=a&api_key=zzz&b=1")).toBe(`https://h/x?model=a&api_key=${REDACTED}&b=1`);
  expect(redactString("ghp_abcdefghijklmnopqrstu")).toBe(REDACTED);
});

test("a redacted snapshot always serialises to valid JSON (compact JSON has no space after a token)", () => {
  const snap = { request: { headers: { authorization: "Bearer x" }, note: "Bearer tok\",\"x\":1}" }, response: { content: "Bearer abc" } };
  const s = JSON.stringify(redactValue(snap));
  expect(() => JSON.parse(s)).not.toThrow();
  expect(s).not.toContain("tok");
});

test("ordinary keys that only contain a secret word are kept", () => {
  expect(isSecretKey("max_tokens")).toBe(false);
  expect(isSecretKey("prompt_tokens")).toBe(false);
  expect(isSecretKey("token")).toBe(false); // logprobs entries are { token, logprob }
  expect(isSecretKey("completion_tokens_details")).toBe(false);
  expect(redactValue({ usage: { prompt_tokens: 5, completion_tokens: 2 } })).toEqual({ usage: { prompt_tokens: 5, completion_tokens: 2 } });
});

test("any key ending in token is a credential except the bare logprob token and special-token names", () => {
  for (const k of ["hf_token", "huggingface_token", "openai_token", "HF_TOKEN", "slackBotToken"]) expect(isSecretKey(k)).toBe(true);
  for (const k of ["token", "eos_token", "bos_token", "pad_token", "max_tokens", "prompt_tokens", "completion_tokens", "total_tokens", "skip_special_tokens", "top_logprobs"])
    expect(isSecretKey(k)).toBe(false);
  const r: any = redactValue({ hf_token: "x", usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }, chat_template_kwargs: { eos_token: "</s>" } });
  expect(r.hf_token).toBe(REDACTED);
  expect(r.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  expect(r.chat_template_kwargs.eos_token).toBe("</s>");
  expect(redactString("use hf_abcdefghijklmnopqrstuvwx now")).toBe(`use ${REDACTED} now`);
  expect(redactString("AIza" + "a".repeat(35))).toBe(REDACTED);
});

test("provider-prefixed credential keys are redacted, logprob tokens are kept", () => {
  for (const k of ["openai_api_key", "AZURE_OPENAI_API_KEY", "openaiApiKey", "aws_secret_access_key", "AWS_ACCESS_KEY", "github_token", "x-goog-api-key", "client_secret", "Set-Cookie", "db_password"])
    expect(isSecretKey(k)).toBe(true);
  const r: any = redactValue({ openai_api_key: "s1", nested: { awsSecretAccessKey: "s2" }, logprobs: { content: [{ token: "hello", logprob: -0.1 }] } });
  expect(r.openai_api_key).toBe(REDACTED);
  expect(r.nested.awsSecretAccessKey).toBe(REDACTED);
  expect(r.logprobs.content[0].token).toBe("hello");
});
