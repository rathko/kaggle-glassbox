// The sample runs' agent harness: a stand-in for YOURS, used by generate.ts and by fork-run during generation.
// It works 16 fake bug-fix tasks through a tool loop against $MODEL_BASE_URL (wire-tap while capturing, fork-proxy
// while forking), sends the task id in x-task-id, and writes <resultsRoot>/<runName>/task_results.jsonl.
// Whether a submitted fix "passes" is a seeded draw at the task's own solve rate: the same task passes in some runs
// and fails in others with nothing changed, which is exactly the noise the dashboard is there to show.
// usage: bun examples/sample-runs/mock-agent.ts <resultsRoot> <runName> [taskFile]
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mulberry32 } from "../../src/stats/seeded-random.ts";

export const TASKS = Array.from({ length: 16 }, (_, i) => `task-${String(i + 1).padStart(2, "0")}`);

/** A stable 32-bit hash of the parts (FNV-1a). */
export function hash(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const c of parts.join("|")) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

/** Per-task solve rate: a few always solved, a few never, most in between, like a real slate. */
export function solveRate(task: string): number {
  const r = mulberry32(hash("rate", task))();
  return r < 0.2 ? 0.95 : r < 0.4 ? 0.03 : 0.25 + 0.5 * mulberry32(hash("mid", task))();
}

export const TOOLS = ["read_file", "search", "edit_file", "run_tests", "submit_patch"].map((name) => ({ type: "function", function: { name, parameters: { type: "object" } } }));
const SYSTEM = "You are a coding agent. Find the bug, fix it, run the tests, then call submit_patch.";
const OBS: Record<string, string> = { read_file: "def total(xs):\n    return sum(xs[1:])", search: "src/app.py:12: def total(xs):", edit_file: "edited src/app.py", run_tests: "1 failed, 11 passed", submit_patch: "submitted" };

async function solve(base: string, run: string, task: string): Promise<{ submitted: boolean; calls: number }> {
  const messages: any[] = [{ role: "system", content: SYSTEM }, { role: "user", content: `Fix the bug described in ${task}.` }];
  let calls = 0;
  for (let turn = 0; turn < 12; turn++) {
    const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "x-task-id": task }, body: JSON.stringify({ model: "mock-coder", seed: hash(run, task) % 100000, messages, tools: TOOLS }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const msg = ((await r.json()) as any).choices[0].message;
    calls++;
    messages.push(msg);
    const tc = msg.tool_calls?.[0];
    if (!tc) return { submitted: false, calls };
    if (tc.function.name === "submit_patch") return { submitted: true, calls };
    messages.push({ role: "tool", tool_call_id: tc.id, content: OBS[tc.function.name] ?? "ok" });
  }
  return { submitted: false, calls };
}

if (import.meta.main) {
  const [root, run, taskFile] = process.argv.slice(2);
  if (!root || !run) { console.error("usage: bun examples/sample-runs/mock-agent.ts <resultsRoot> <runName> [taskFile]"); process.exit(2); }
  const base = process.env.MODEL_BASE_URL ?? "http://127.0.0.1:8810";
  const only = taskFile ? readFileSync(taskFile, "utf8").trim().split(/\s+/) : null;
  mkdirSync(join(root, run), { recursive: true });
  for (const task of TASKS) {
    if (only && !only.includes(task)) continue;
    const r = await solve(base, run, task);
    const resolved = r.submitted && mulberry32(hash("pass", run, task))() < solveRate(task);
    appendFileSync(join(root, run, "task_results.jsonl"), JSON.stringify({ instance_id: task, resolved, model_calls: r.calls }) + "\n");
  }
}
