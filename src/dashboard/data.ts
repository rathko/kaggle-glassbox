// dashboard/data: everything the dashboard shows, read fresh from disk on each call. No caching, no writes: the
// dashboard is a viewer, so it never closes, repairs or seals a run.
//
// THE SCORE RULE. The toolkit's promise is that a score is read once, through the gate, and frozen. A dashboard that
// printed the pass rate of every run it can see would be a second, ungated reader. So a run's score (its pass rate
// AND its per-task outcomes) is shown only when the run was already read through the gate: a run-end record that
// still matches the artifacts (readability), a seal (score-read.json), and rows whose hash is the one sealed. Every
// other run shows its state ("open", "closed, not read", "changed after read") and its captured steps, never a score.
//
// Run layout (what wire-tap, capture-compact, run-end and score-reader produce; see examples/demo.ts):
//   <run>/task_results.jsonl          one row per task: instance_id (or task_id) and resolved (true/false/1/0)
//   <run>/stack.json                   what ran
//   <run>/instruments.runend.json      the run-end record           <run>/score-read.json   the seal
//   <run>/capture/manifest.json + task-<hash>.jsonl.gz              the compacted capture, one file per task
//   <run>/replay*.jsonl, screen*.jsonl  step-replay output (optional)
//   <run>/forks/fork-runs.jsonl         fork-run ledger (optional; fork rollouts in <run>/forks/fork-*/)
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { readability } from "../integrity/score-gate.ts";
import { binaryOutcome } from "../integrity/outcome.ts";
import { isSafeId, within } from "../safe-id.ts";
import { mcNemarExact, noiseFloor } from "../noise-floor/noise-floor.ts";

/** Clip long text server-side, so one huge observation cannot stall the page. */
export const CLIP = 2000;
const clip = (s: unknown, n = CLIP): string => { const t = typeof s === "string" ? s : s == null ? "" : JSON.stringify(s); return t.length > n ? `${t.slice(0, n)}… [${t.length - n} more chars]` : t; };

export class NotFound extends Error {}

/** A run or task id from a URL: one safe path component, else NotFound (never a filesystem read). */
export function checkId(id: string, what = "id"): string {
  if (!isSafeId(id)) throw new NotFound(`bad ${what}`);
  return id;
}

/** JSONL rows; a torn final line (an append in flight) is skipped, and so is any other line that does not parse. */
export function readJsonl(p: string): any[] {
  if (!existsSync(p)) return [];
  const out: any[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn or corrupt line: skipped, never guessed */ }
  }
  return out;
}

const readJson = (p: string): any => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const taskIdOf = (r: any): string => String(r?.instance_id ?? r?.task_id ?? "");

export function listRuns(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((d) => isSafeId(d) && existsSync(join(root, d, "task_results.jsonl"))).sort();
}

export function runDir(root: string, run: string): string {
  checkId(run, "run");
  const d = within(root, run);
  if (!existsSync(join(d, "task_results.jsonl"))) throw new NotFound(`unknown run ${run}`);
  return d;
}

export type RunState = "open" | "closed" | "sealed" | "broken";
export interface RunStatus {
  state: RunState;
  /** human reason for anything short of a readable score */
  detail: string;
  closedAt: string | null;
  readAt: string | null;
  checks: Record<string, boolean>;
}

/** Where a run stands in the capture -> close -> read lifecycle. `sealed` is the only state whose score is shown. */
export function runStatus(dir: string): RunStatus {
  const re = readJson(join(dir, "instruments.runend.json")), sr = readJson(join(dir, "score-read.json"));
  const checks: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(re?.checks ?? {})) checks[k] = !!(v as any)?.ok;
  const base = { closedAt: re?.at ?? null, readAt: sr?.at ?? null, checks };
  if (!re) return { ...base, state: "open", detail: "no run-end record yet: close it with src/integrity/run-end.ts" };
  const r = readability(dir);
  if (!r.ok) return { ...base, state: "broken", detail: r.reasons.join("; ") };
  if (!sr) return { ...base, state: "closed", detail: "closed, score not read: read it once with src/integrity/score-reader.ts" };
  const rowsSha = createHash("sha256").update(readFileSync(join(dir, "task_results.jsonl"))).digest("hex");
  if (sr.read?.rowsSha256 && sr.read.rowsSha256 !== rowsSha) return { ...base, state: "broken", detail: "task_results.jsonl changed after the score was read" };
  return { ...base, state: "sealed", detail: "read through the gate and sealed" };
}

export interface RunSummary {
  run: string;
  status: RunStatus;
  tasks: number;
  /** null unless the run is sealed */
  passed: number | null;
  rate: number | null;
  stack: Record<string, unknown> | null;
  capturedTasks: number;
  exchanges: number;
  replays: number;
  forks: number;
  updatedAt: number;
}

interface Manifest { [hash: string]: { task_id?: string | null; instances?: string[]; exchanges?: number; seq_first?: number; seq_last?: number } }
const manifestOf = (dir: string): Manifest => readJson(join(dir, "capture", "manifest.json")) ?? {};

/** task -> outcome for a sealed run; null for any other run (see THE SCORE RULE). */
export function outcomes(dir: string, status = runStatus(dir)): Map<string, boolean | null> | null {
  if (status.state !== "sealed") return null;
  const m = new Map<string, boolean | null>();
  for (const r of readJsonl(join(dir, "task_results.jsonl"))) {
    const id = taskIdOf(r);
    if (id) m.set(id, binaryOutcome(r.resolved) ?? null);
  }
  return m;
}

export function replayFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => /^(replay|screen)[A-Za-z0-9._-]*\.jsonl$/.test(f)).sort();
}

export function runSummary(root: string, run: string): RunSummary {
  const dir = runDir(root, run), status = runStatus(dir);
  const rows = readJsonl(join(dir, "task_results.jsonl"));
  const o = outcomes(dir, status);
  const passed = o ? [...o.values()].filter((v) => v === true).length : null;
  const man = Object.values(manifestOf(dir));
  return {
    run, status, tasks: new Set(rows.map(taskIdOf).filter(Boolean)).size,
    passed, rate: o && o.size ? passed! / o.size : null,
    stack: readJson(join(dir, "stack.json")),
    capturedTasks: man.length, exchanges: man.reduce((s, m) => s + (m.exchanges ?? 0), 0),
    replays: replayFiles(dir).reduce((s, f) => s + readJsonl(join(dir, f)).length, 0),
    forks: readJsonl(join(dir, "forks", "fork-runs.jsonl")).length,
    updatedAt: statSync(join(dir, "task_results.jsonl")).mtimeMs,
  };
}

export interface Matrix {
  runs: RunSummary[];
  tasks: { task: string; cells: Record<string, { outcome: boolean | null | "hidden"; captured: boolean }> }[];
}

/** Every run against every task. A cell's outcome is "hidden" for a run whose score has not been read. */
export function matrix(root: string): Matrix {
  const runs = listRuns(root).map((r) => runSummary(root, r));
  const cells = new Map<string, Matrix["tasks"][number]["cells"]>();
  for (const s of runs) {
    const dir = join(root, s.run), o = outcomes(dir, s.status);
    const captured = new Set(Object.values(manifestOf(dir)).flatMap((m) => [m.task_id, ...(m.instances ?? [])]).filter(Boolean) as string[]);
    for (const r of readJsonl(join(dir, "task_results.jsonl"))) {
      const id = taskIdOf(r);
      if (!id) continue;
      if (!cells.has(id)) cells.set(id, {});
      cells.get(id)![s.run] = { outcome: o ? (o.get(id) ?? null) : "hidden", captured: captured.has(id) };
    }
  }
  return { runs, tasks: [...cells].sort(([a], [b]) => a.localeCompare(b)).map(([task, c]) => ({ task, cells: c })) };
}

export interface Step {
  seq: number;
  startMs: number;
  durationMs: number | null;
  streamed: boolean;
  status: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  finish: string | null;
  tools: { name: string; args: string }[];
  content: string;
  /** the last request message the model was answering (a tool result or the user turn), clipped */
  input: string;
}

/** The task's captured exchanges, in order, from the compacted capture. */
export function taskSteps(dir: string, task: string): Step[] {
  const entry = Object.entries(manifestOf(dir)).find(([, m]) => m.task_id === task || (m.instances ?? []).includes(task));
  if (!entry || !isSafeId(entry[0])) return [];
  const gz = join(dir, "capture", `task-${entry[0]}.jsonl.gz`);
  if (!existsSync(gz)) return [];
  const snaps = gunzipSync(readFileSync(gz)).toString("utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  snaps.sort((a, b) => Number(a.seq) - Number(b.seq));
  const t0 = Date.parse(snaps[0]?.req_at ?? snaps[0]?.at ?? "") || 0;
  return snaps.map((s) => {
    const req = Date.parse(s.req_at ?? ""), at = Date.parse(s.at ?? "");
    const msg = s.response?.choices?.[0]?.message ?? {};
    const msgs: any[] = Array.isArray(s.request?.messages) ? s.request.messages : [];
    const last = msgs[msgs.length - 1];
    return {
      seq: Number(s.seq),
      startMs: Number.isFinite(req) && t0 ? req - t0 : 0,
      durationMs: Number.isFinite(req) && Number.isFinite(at) ? at - req : null,
      streamed: !!s.streamed,
      status: typeof s.status === "number" ? s.status : null,
      promptTokens: s.response?.usage?.prompt_tokens ?? null,
      completionTokens: s.response?.usage?.completion_tokens ?? null,
      finish: s.response?.choices?.[0]?.finish_reason ?? null,
      tools: (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).map((t: any) => ({ name: String(t?.function?.name ?? "?"), args: clip(t?.function?.arguments, 400) })),
      content: clip(msg.content),
      input: last ? `${last.role}: ${clip(last.content, 400)}` : "",
    };
  });
}

export interface ReplayRow { file: string; seq: number; repeat: number; original: string; mutated: string; changed: boolean }

/** step-replay rows touching this task's captured seqs (or all rows when task is omitted). */
export function replays(dir: string, seqs?: Set<number>): ReplayRow[] {
  const show = (x: any) => (x?.first_tool ?? (x?.content_chars ? "text" : x?.finish ?? "?")) as string;
  return replayFiles(dir).flatMap((file) => readJsonl(join(dir, file))
    .filter((r) => !seqs || seqs.has(Number(r.seq)))
    .map((r) => ({ file, seq: Number(r.seq), repeat: Number(r.repeat ?? 1), original: String(show(r.original)), mutated: String(show(r.mutated)), changed: r.changed === true || show(r.original) !== show(r.mutated) })));
}

export interface ForkRow { tag: string; task: string; fork: number; n: number; valid: number; resolved: number; rate: number | null; divergent: number }

export function forks(dir: string, task?: string): ForkRow[] {
  return readJsonl(join(dir, "forks", "fork-runs.jsonl"))
    .filter((r) => !task || String(r.task) === task)
    .map((r) => ({ tag: String(r.tag ?? ""), task: String(r.task ?? ""), fork: Number(r.fork ?? 0), n: Number(r.n ?? 0), valid: Number(r.valid ?? 0), resolved: Number(r.resolved ?? 0), rate: typeof r.rate === "number" ? r.rate : null, divergent: Number(r.divergent ?? 0) }));
}

export function taskView(root: string, run: string, task: string) {
  const dir = runDir(root, run);
  checkId(task, "task");
  const rows = readJsonl(join(dir, "task_results.jsonl"));
  if (!rows.some((r) => taskIdOf(r) === task)) throw new NotFound(`unknown task ${task} in ${run}`);
  const status = runStatus(dir), o = outcomes(dir, status);
  const steps = taskSteps(dir, task);
  const others = listRuns(root).filter((r) => r !== run).flatMap((r) => {
    const d = join(root, r), oo = outcomes(d);
    return readJsonl(join(d, "task_results.jsonl")).some((x) => taskIdOf(x) === task) ? [{ run: r, outcome: oo ? (oo.get(task) ?? null) : "hidden" }] : [];
  });
  return { run, task, state: status.state, outcome: o ? (o.get(task) ?? null) : "hidden", steps, replays: replays(dir, new Set(steps.map((s) => s.seq))), forks: forks(dir, task), otherRuns: others };
}

export interface Comparison {
  a: string; b: string;
  shared: number; aPassed: number; bPassed: number;
  aOnly: string[]; bOnly: string[];
  /** exact McNemar p on the tasks where the two runs disagree (paired: same tasks) */
  pValue: number;
  /** two-SD band of a single-draw difference at the pooled rate, in tasks: a gap inside it is noise */
  noiseBandTasks: number;
  verdict: string;
}

/** Two sealed runs, paired on their shared tasks. Refuses (NotFound) a run whose score has not been read. */
export function compare(root: string, a: string, b: string): Comparison {
  const oa = outcomes(runDir(root, a)), ob = outcomes(runDir(root, b));
  if (!oa) throw new NotFound(`${a} has no sealed score: read it through the gate first`);
  if (!ob) throw new NotFound(`${b} has no sealed score: read it through the gate first`);
  const shared = [...oa.keys()].filter((t) => ob.has(t) && oa.get(t) !== null && ob.get(t) !== null).sort();
  if (!shared.length) throw new NotFound("the two runs share no graded task");
  const aOnly = shared.filter((t) => oa.get(t) && !ob.get(t)), bOnly = shared.filter((t) => !oa.get(t) && ob.get(t));
  const aPassed = shared.filter((t) => oa.get(t)).length, bPassed = shared.filter((t) => ob.get(t)).length;
  const p = mcNemarExact(aOnly.length, bOnly.length).pValue;
  const pooled = (aPassed + bPassed) / (2 * shared.length);
  const band = noiseFloor(shared.length, pooled).minDetectableDifference * shared.length;
  const gap = bPassed - aPassed;
  const verdict = gap === 0 ? `same total; ${aOnly.length + bOnly.length ? `the ${aOnly.length + bOnly.length} task(s) they disagree on split ${aOnly.length}-${bOnly.length}` : "they agree on every task"}`
    : p < 0.05 ? `${gap > 0 ? b : a} is ahead by ${Math.abs(gap)} task(s), and the paired test says that is unlikely to be chance (p = ${p.toFixed(3)})`
    : `a ${Math.abs(gap)}-task gap is within what chance produces here (paired p = ${p.toFixed(2)}; single-draw noise band ±${band.toFixed(1)} tasks): run more repeats before you believe it`;
  return { a, b, shared: shared.length, aPassed, bPassed, aOnly, bOnly, pValue: p, noiseBandTasks: band, verdict };
}

/** Runs grouped by name minus a trailing "-r<N>" repeat suffix: mean rate and spread over sealed repeats. */
export function groups(root: string): { group: string; runs: string[]; sealed: number; meanRate: number | null; minRate: number | null; maxRate: number | null }[] {
  const by = new Map<string, RunSummary[]>();
  for (const r of listRuns(root).map((x) => runSummary(root, x))) {
    const g = r.run.replace(/-r\d+$/, "");
    if (!by.has(g)) by.set(g, []);
    by.get(g)!.push(r);
  }
  return [...by].map(([group, rs]) => {
    const rates = rs.map((r) => r.rate).filter((x): x is number => x !== null);
    return { group, runs: rs.map((r) => r.run), sealed: rates.length, meanRate: rates.length ? rates.reduce((s, x) => s + x, 0) / rates.length : null, minRate: rates.length ? Math.min(...rates) : null, maxRate: rates.length ? Math.max(...rates) : null };
  });
}
