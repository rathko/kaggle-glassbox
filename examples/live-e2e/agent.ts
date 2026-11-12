// A tiny tool-using QA agent for the live end-to-end check (examples/live-e2e/run.sh). It stands in for YOUR
// harness: it talks to $MODEL_BASE_URL (wire-tap during the run, fork-proxy during a fork), sends the task id in
// an x-task-id header, streams the 1st and 3rd task and not the others (both capture paths get exercised), and
// writes <resultsRoot>/<runName>/task_results.jsonl in the toolkit's run layout.
// env: MODEL_BASE_URL (default http://127.0.0.1:8810), MODEL (the server's model id; required)
// usage: bun examples/live-e2e/agent.ts <resultsRoot> <runName> [taskFile]
import { mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export const TASKS = [
  { id: "q1", q: "What is 17*23?", a: "391" },
  { id: "q2", q: "What is 144/12 + 7?", a: "19" },
  { id: "q3", q: "What is 2**10 - 24?", a: "1000" },
  { id: "q4", q: "What is (81-9)*3?", a: "216" },
];
const TOOLS = [
  { type: "function", function: { name: "calc", description: "Evaluate an arithmetic expression (+ - * / ** parentheses).", parameters: { type: "object", properties: { expr: { type: "string" } }, required: ["expr"] } } },
  { type: "function", function: { name: "submit_answer", description: "Submit the final numeric answer.", parameters: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } } },
];
const SYSTEM = "You are a careful calculator agent. Always call calc first, then call submit_answer with the result. Never answer in plain text.";
const BASE = process.env.MODEL_BASE_URL ?? "http://127.0.0.1:8810";
const MODEL = process.env.MODEL ?? "";

async function chat(task: string, body: any, stream: boolean): Promise<any> {
  const r = await fetch(`${BASE}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "x-task-id": task }, body: JSON.stringify({ ...body, stream }) });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  if (!stream) return ((await r.json()) as any).choices[0].message;
  // minimal SSE assembly for the agent's own use (the capture tools assemble independently)
  const msg: any = { role: "assistant", content: "", tool_calls: [] as any[] };
  for (const line of (await r.text()).split("\n")) {
    if (!line.startsWith("data:")) continue;
    const d = line.slice(5).trim();
    if (d === "[DONE]") break;
    const delta = JSON.parse(d).choices?.[0]?.delta ?? {};
    if (delta.content) msg.content += delta.content;
    for (const tc of delta.tool_calls ?? []) {
      const t = (msg.tool_calls[tc.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (tc.id) t.id = tc.id;
      if (tc.function?.name) t.function.name += tc.function.name;
      if (tc.function?.arguments) t.function.arguments += tc.function.arguments;
    }
  }
  if (!msg.tool_calls.length) delete msg.tool_calls;
  return msg;
}

async function solve(t: { id: string; q: string; a: string }, stream: boolean) {
  const messages: any[] = [{ role: "system", content: SYSTEM }, { role: "user", content: t.q }];
  let calls = 0;
  for (let turn = 0; turn < 4; turn++) {
    const m = await chat(t.id, { model: MODEL, max_tokens: 200, temperature: 0, messages, tools: TOOLS }, stream);
    calls++;
    messages.push(m);
    const tc = m.tool_calls?.[0];
    if (!tc) return { answer: String(m.content ?? "").trim(), calls };
    const args = JSON.parse(tc.function.arguments || "{}");
    if (tc.function.name === "submit_answer") return { answer: String(args.answer).trim(), calls };
    // calc: a strict whitelist before eval
    const expr = String(args.expr ?? "");
    const val = /^[\d\s+\-*/().]+$/.test(expr) ? String(Function(`return (${expr})`)()) : "error";
    messages.push({ role: "tool", tool_call_id: tc.id, content: val });
  }
  return { answer: "", calls };
}

if (import.meta.main) {
  const [root, runName, taskFile] = process.argv.slice(2);
  if (!root || !runName) { console.error("usage: bun examples/live-e2e/agent.ts <resultsRoot> <runName> [taskFile]"); process.exit(2); }
  if (!MODEL) { console.error("set MODEL to the server's model id (run.sh does this from /v1/models)"); process.exit(2); }
  const only = taskFile ? readFileSync(taskFile, "utf8").trim().split(/\s+/) : null;
  const dir = join(root!, runName!);
  mkdirSync(dir, { recursive: true });
  for (const [i, t] of TASKS.entries()) {
    if (only && !only.includes(t.id)) continue;
    const r = await solve(t, i % 2 === 0);
    appendFileSync(join(dir, "task_results.jsonl"), JSON.stringify({ instance_id: t.id, resolved: r.answer === t.a, answer: r.answer, model_calls: r.calls }) + "\n");
    console.log(`${t.id}: ${r.answer} (${r.answer === t.a ? "ok" : "wrong"}, ${r.calls} calls)`);
  }
}
