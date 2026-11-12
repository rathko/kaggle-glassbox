// frontier: the pure logic behind the frontier analysis — a per-task, model-written post-mortem
// of an agent trajectory (VERDICT / TIMELINE / WASTE / CONTEXT / FIX-IDEAS), and a cross-task
// synthesis that turns the failed tasks' post-mortems into one failure taxonomy with ranked,
// mechanism-level levers.
//
// WHY. A resolve count tells you THAT a change did or did not help; it never tells you WHICH
// mechanism failed. Reading forty trajectories by hand after every run does not happen, so the
// mechanisms go unread and the next change is chosen blind. A cheap analyst model reading a
// condensed trajectory per task, and then a synthesis over those post-mortems, makes the waste
// visible after every run for the price of a few dozen local completions.
//
// INPUTS are the formats the rest of this package already defines:
//   <run>/task_results.jsonl            one row per task: { instance_id, resolved, ...metrics }
//   <run>/capture/                      wire-tap.ts --capture-full, compacted by
//                                       capture-compact.ts and attributed by
//                                       capture-attribute.ts (manifest entries carry `instances`)
//   <run>/patches/<id>.patch|.diff      optional: the agent's own patch (or a `model_patch` /
//                                       `patch` field on the row)
// The task's problem statement is taken from the captured trajectory itself (the first user
// message), so no dataset file is needed.
//
// REFERENCE PATCHES ARE OFF BY DEFAULT. A benchmark's gold/reference patches are often licensed
// or competition data, and an analyst that reads them produces text that can leak a fix back into
// a prompt. The analyst therefore sees only what the agent saw and produced, unless the caller
// explicitly supplies their own reference patches (`--reference-patch`); every analysis file
// records whether one was used, and the synthesis header repeats it.
import { existsSync, readFileSync } from "node:fs";
import { assertValidCaptures } from "../replay/capture-valid";
import { manifestArchives, taskSnaps } from "../capture/archives";
import { basename, join } from "node:path";
import { binaryOutcome } from "../integrity/outcome";

export const FRONTIER_MARK = "<!-- frontier-analysis v1 -->";
export const SYNTH_MARK = "<!-- frontier-synth v1 -->";
export const RUN_COMPLETE_SENTINEL = ".run-complete";

// ---------------------------------------------------------------------------------------------
/** A task id as a single safe file name. Ids made only of letters, digits, '.', '_' and '-' are kept as they
 *  are (so existing runs keep their file names); anything else, or "." / "..", is percent-encoded so an id
 *  can never create a subdirectory or step outside the run directory. */
export function idFile(id: string): string {
  const s = String(id);
  if (/^[A-Za-z0-9._-]+$/.test(s) && s !== "." && s !== "..") return s;
  return encodeURIComponent(s).replace(/\./g, "%2E");
}

// rows, captures, patches

export const rowId = (r: any): string | undefined => r?.instance_id ?? r?.task_id ?? r?.id;

/** The result rows of a run. Throws, naming the line, on a row that is not a JSON object, has no task id, has an id
 *  that is not a string or number, repeats an id, or has a `resolved` that is not true/false/1/0 (integrity/outcome.ts,
 *  the reading the sealed score reader uses, so a numeric 1 is solved here too): dropping a bad row would let coverage report a run complete
 *  after analysing only the rows that happened to parse. With opts.partialTail (a run still being written, --watch),
 *  a last line with no newline yet is skipped instead of parsed. */
export function loadRows(runDir: string, opts: { partialTail?: boolean } = {}): any[] {
  const p = join(runDir, "task_results.jsonl");
  if (!existsSync(p)) return [];
  let text = readFileSync(p, "utf8");
  if (opts.partialTail && !text.endsWith("\n")) text = text.slice(0, text.lastIndexOf("\n") + 1);
  const rows: any[] = [], seen = new Map<string, number>(), problems: string[] = [];
  text.split("\n").forEach((l, i) => {
    if (!l.trim()) return;
    let r: any;
    try { r = JSON.parse(l); } catch { problems.push(`line ${i + 1}: not JSON`); return; }
    if (!r || typeof r !== "object" || Array.isArray(r)) { problems.push(`line ${i + 1}: not a JSON object`); return; }
    const id = rowId(r);
    if (id === undefined || id === null) { problems.push(`line ${i + 1}: no task id (instance_id, task_id or id)`); return; }
    if (typeof id !== "string" && !(typeof id === "number" && Number.isFinite(id))) { problems.push(`line ${i + 1}: task id ${JSON.stringify(id)} is not a string or number`); return; }
    const k = String(id);
    if (seen.has(k)) { problems.push(`line ${i + 1}: task id ${JSON.stringify(k)} repeats line ${seen.get(k)}`); return; }
    if (binaryOutcome(r.resolved) === undefined) { problems.push(`line ${i + 1}: "resolved" must be true/false or 1/0, got ${JSON.stringify(r.resolved)}`); return; }
    seen.set(k, i + 1);
    rows.push(r);
  });
  if (problems.length) throw new Error(`${p}: ${problems.length} bad row(s), refusing the whole file (${problems.slice(0, 10).join("; ")}${problems.length > 10 ? "; ..." : ""})`);
  return rows;
}

/** The captured exchanges of one task, in seq order: exactly the exchanges attributed to it (archives.ts taskSnaps,
 *  the same rule as replay/fork-run-steps.ts). Throws when nothing is attributed (an analysis of an empty trajectory
 *  would read as "the agent did nothing"), if any exchange is invalid (capture-valid.ts), or a listed archive is
 *  missing or holds a different number of exchanges than the manifest says: a post-mortem of a trajectory with holes
 *  in it would be misleading. */
export function loadTaskExchanges(captureDir: string, id: string): any[] {
  if (!existsSync(join(captureDir, "manifest.json"))) throw new Error(`task ${id}: no ${join(captureDir, "manifest.json")} (compact and attribute the capture first)`);
  // every listed archive must exist and hold exactly the exchanges the manifest says, and no unlisted archive may sit
  // beside them: a missing, short or extra archive would yield a post-mortem that misreports the trajectory
  let archives: ReturnType<typeof manifestArchives>;
  try { archives = manifestArchives(captureDir); } catch (e) { throw new Error(`task ${id}: ${(e as Error).message}`); }
  let ex: any[];
  try { ex = taskSnaps(archives, id); } catch (e) { throw new Error(`task ${id}: ${(e as Error).message}`); }
  if (!ex.length) throw new Error(`task ${id}: no captured exchange is attributed to this task; nothing to analyse`);
  assertValidCaptures(ex, `task ${id}`);
  return ex.sort((a, b) => a.seq - b.seq);
}

export function loadAgentPatch(runDir: string, id: string, row: any): string {
  for (const ext of ["patch", "diff"]) {
    const p = join(runDir, "patches", `${idFile(id)}.${ext}`);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return String(row?.model_patch ?? row?.patch ?? "");
}

/** OPT-IN reference patches supplied by the user. A `.jsonl` file maps rows of
 *  `{ instance_id, patch }`; any other file is one bare patch and needs exactly one task (--only). */
export function loadReferencePatches(file: string, only?: string): Map<string, string> {
  const text = readFileSync(file, "utf8");
  const out = new Map<string, string>();
  if (file.endsWith(".jsonl")) {
    for (const l of text.split("\n")) {
      if (!l.trim()) continue;
      const r = JSON.parse(l);
      const id = rowId(r);
      if (id && typeof r.patch === "string") out.set(id, r.patch);
    }
    return out;
  }
  if (!only) throw new Error("a bare reference patch file applies to one task: pass --only <id>, or use a .jsonl of { instance_id, patch } rows");
  out.set(only, text);
  return out;
}

// ---------------------------------------------------------------------------------------------
// condensing a trajectory

export function clip(s: unknown, n: number): string {
  const t = String(s ?? "");
  return t.length <= n ? t : `${t.slice(0, n)} …[+${t.length - n} chars]`;
}

const contentText = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => p?.text ?? "").join("") : c == null ? "" : JSON.stringify(c);

export function problemStatement(exchanges: any[]): string {
  const u = (exchanges[0]?.request?.messages ?? []).find((m: any) => m.role === "user");
  return u ? contentText(u.content) : "(no captured task prompt)";
}

export type Condensed = { table: string; steps: number; toolCalls: number; peakPromptTokens: number | null };

/** A bounded step table: per model exchange, its context size, each tool call with clipped
 *  arguments, and that call's result (joined by tool_call_id from any later request). The raw
 *  trajectory is never fed to the analyst — context bloat is often what is being studied, and
 *  the analyst's own window should not blow up studying it. */
export function condenseExchanges(exchanges: any[], opts: { resultClip?: number; argsClip?: number; textClip?: number; maxChars?: number } = {}): Condensed {
  const resultClip = opts.resultClip ?? 1200, argsClip = opts.argsClip ?? 400, textClip = opts.textClip ?? 300, maxChars = opts.maxChars ?? 90000;
  const results = new Map<string, string>();
  for (const e of exchanges) for (const m of e.request?.messages ?? []) {
    if (m.role === "tool" && m.tool_call_id && !results.has(m.tool_call_id)) results.set(m.tool_call_id, contentText(m.content));
  }
  const lines: string[] = [];
  let toolCalls = 0, peak: number | null = null;
  exchanges.forEach((e, i) => {
    const msg = e.response?.choices?.[0]?.message ?? {};
    const ctx = e.response?.usage?.prompt_tokens;
    if (typeof ctx === "number") peak = Math.max(peak ?? 0, ctx);
    const head = `step ${i + 1} seq=${e.seq ?? "?"} ctx=${ctx ?? "?"}`;
    const text = contentText(msg.content).trim();
    const calls: any[] = msg.tool_calls ?? [];
    if (!calls.length) { lines.push(`${head} text: ${clip(text || "(empty)", textClip)}`); return; }
    for (const c of calls) {
      toolCalls++;
      const args = typeof c.function?.arguments === "string" ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {});
      const res = c.id && results.has(c.id) ? results.get(c.id)! : "(no result captured)";
      lines.push(`${head} tool=${c.function?.name ?? "?"} args=${clip(args, argsClip)}\n  result[0:${resultClip}]=${clip(res, resultClip)}`);
    }
    if (text) lines.push(`  text: ${clip(text, textClip)}`);
  });
  return { table: clip(lines.join("\n"), maxChars), steps: exchanges.length, toolCalls, peakPromptTokens: peak };
}

// ---------------------------------------------------------------------------------------------
// the per-task prompt and its output

const BASE_SECTIONS = ["VERDICT", "TIMELINE", "WASTE", "CONTEXT"] as const;
export function requiredSections(withReference: boolean): string[] {
  return [...BASE_SECTIONS, ...(withReference ? ["VS-REFERENCE"] : []), "FIX-IDEAS"];
}

export function metricsLine(row: any): string {
  return Object.entries(row ?? {})
    .filter(([k, v]) => !["instance_id", "task_id", "id", "patch", "model_patch"].includes(k) && v !== null && typeof v !== "object")
    .map(([k, v]) => `${k}=${typeof v === "number" && !Number.isInteger(v) ? v.toFixed(1) : v}`).join(" ");
}

export type TaskPromptInput = { id: string; row: any; exchanges: any[]; agentPatch: string; referencePatch?: string; context?: string };

export function buildTaskPrompt(t: TaskPromptInput): { system: string; user: string } {
  const withRef = typeof t.referencePatch === "string";
  const sections = requiredSections(withRef);
  const describe: Record<string, string> = {
    VERDICT: "one or two sentences: did it resolve, and the single root cause of the outcome.",
    TIMELINE: "the key beats (localisation, reproduction, edits, verification) and where the budget went, by step number.",
    WASTE: "the specific wasted moves (identical-call loops, re-reading, oversized reads, failed edits, thinking that never became an action).",
    CONTEXT: "how the context grew (use the ctx= numbers) and whether it pressed on the window.",
    "VS-REFERENCE": "against the user-supplied reference patch: right file, right function, right change, how far off.",
    "FIX-IDEAS": "capability-level levers only (tools, budget, prompt structure, decoding, verification) — never a hint about this specific bug.",
  };
  const system = [
    "You are a frontier waste analyst for an autonomous coding agent, in the Toyota Production System sense:",
    "make the waste visible from the data. You never edit prompts or submissions.",
    "",
    "HARD RULES FOR YOUR OUTPUT",
    `- Emit EXACTLY these ${sections.length} sections, in order, each starting on its own line as "NAME: ...", 15 to 40 lines total:`,
    ...sections.map((s) => `  ${s}: ${describe[s]}`),
    "- Quantify. \"read 6 files before the first hypothesis\" beats \"read too much\".",
    "- If the data does not support a claim, say so. An absent signal is a fact about the trajectory, not licence to speculate.",
    withRef ? "- The reference patch is for judging only. Your text must never become a task-specific hint." : "- You have no reference fix. Judge from the problem statement, the trajectory and the agent's patch alone.",
    ...(t.context ? ["", "KNOWN FINDINGS — build on these, do not rediscover them", t.context.trim()] : []),
  ].join("\n");

  const c = condenseExchanges(t.exchanges);
  const user = [
    `TASK ${t.id}`,
    `OUTCOME: ${metricsLine(t.row) || "(no metrics row)"}`,
    "",
    "PROBLEM STATEMENT (first user message of the captured trajectory)",
    clip(problemStatement(t.exchanges), 4000),
    "",
    ...(withRef ? [
      "REFERENCE PATCH (opt-in, user-supplied; for judging only — never quote it as a fix hint)",
      clip(t.referencePatch, 6000),
      "",
    ] : []),
    `THE AGENT'S OWN PATCH (${t.agentPatch.length} bytes)`,
    t.agentPatch ? clip(t.agentPatch, 3000) : "(empty: the agent produced no patch)",
    "",
    `TRAJECTORY (${c.steps} model exchanges, ${c.toolCalls} tool calls, peak prompt tokens ${c.peakPromptTokens ?? "?"}; results truncated)`,
    c.table || "(no captured exchanges attributed to this task)",
    "",
    `Analyse task ${t.id} now. Emit only the sections: ${sections.join(", ")}.`,
  ].join("\n");
  return { system, user };
}

const SECTION_ALIASES: [RegExp, string][] = [
  [/^VERDICT$/i, "VERDICT"], [/^TIMELINE$/i, "TIMELINE"], [/^WASTE$/i, "WASTE"], [/^CONTEXT$/i, "CONTEXT"],
  [/^VS[ -](GOLD|REFERENCE)$/i, "VS-REFERENCE"], [/^FIX[ -]IDEAS$/i, "FIX-IDEAS"],
];
const HEADER = /^\s*(?:#{1,6}\s*)?\**\s*(VERDICT|TIMELINE|WASTE|CONTEXT|VS[ -](?:GOLD|REFERENCE)|FIX[ -]IDEAS)\s*\**\s*(?::\s*\**|$)\s*(.*)$/i;

/** Split analyst output into its sections. Tolerates "NAME: text", "## NAME", and "**NAME:**". */
export function parseSections(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  let cur: string | null = null;
  for (const line of md.split("\n")) {
    const m = line.match(HEADER);
    if (m) {
      cur = SECTION_ALIASES.find(([re]) => re.test(m[1]))![1];
      out[cur] = m[2] ?? "";
    } else if (cur) out[cur] += `\n${line}`;
  }
  for (const k of Object.keys(out)) out[k] = out[k].trim();
  return out;
}

export function renderAnalysis(a: { id: string; row: any; patchBytes: number; reference: string | null; body: string }): string {
  return [
    FRONTIER_MARK,
    `<!-- patch_bytes=${a.patchBytes} -->`,
    `<!-- reference_patch=${a.reference ? basename(a.reference) : "none"} -->`,
    `# Frontier analysis — ${a.id}`,
    "",
    `OUTCOME: ${metricsLine(a.row) || "(no metrics row)"}`,
    "",
    a.body.trim(),
    "",
  ].join("\n");
}

export function readAnalysisMeta(md: string): { frontier: boolean; patchBytes: number | null; referenceUsed: boolean } {
  const pb = md.match(/<!-- patch_bytes=(\d+) -->/);
  const ref = md.match(/<!-- reference_patch=(.*?) -->/);
  return { frontier: md.includes(FRONTIER_MARK), patchBytes: pb ? Number(pb[1]) : null, referenceUsed: !!ref && ref[1] !== "none" };
}

// ---------------------------------------------------------------------------------------------
// coverage

/** Is every task row covered by a complete frontier analysis? A missing or partial analysis is
 *  listed, never treated as "nothing to report". */
export function analysisCoverage(runDir: string) {
  const ids = loadRows(runDir).map((r) => rowId(r)!);
  const missing = [...new Set(ids)].filter((id) => {
    const p = join(runDir, "analysis", `${idFile(id)}.md`);
    if (!existsSync(p)) return true;
    const md = readFileSync(p, "utf8");
    const meta = readAnalysisMeta(md);
    if (!meta.frontier) return true;
    const s = parseSections(md);
    return requiredSections(meta.referenceUsed).some((k) => !s[k]);
  });
  const duplicateRows = ids.length - new Set(ids).size;
  return { completedTasks: ids.length, duplicateRows, missing, complete: ids.length > 0 && duplicateRows === 0 && missing.length === 0 };
}

// ---------------------------------------------------------------------------------------------
// synthesis

export function synthInputs(runs: string[], ids?: string[]) {
  const first = loadRows(runs[0]);
  const list = [...(ids ?? first.filter((r) => binaryOutcome(r.resolved) !== true).map((r) => rowId(r)!))].sort();
  let noPatch = 0, wrongPatch = 0, missing = 0, referenceUsed = false;
  const blocks: string[] = [];
  for (const id of list) {
    const parts: string[] = [];
    let counted = false;
    for (const [k, run] of runs.entries()) {
      const p = join(run, "analysis", `${idFile(id)}.md`);
      if (!existsSync(p)) continue;
      const md = readFileSync(p, "utf8");
      const meta = readAnalysisMeta(md);
      if (meta.referenceUsed) referenceUsed = true;
      if (!counted) {
        if (meta.patchBytes === 0) noPatch++; else if ((meta.patchBytes ?? 0) > 0) wrongPatch++;
        counted = true;
      }
      const s = parseSections(md);
      if (k === 0) {
        parts.push(`VERDICT: ${clip(s.VERDICT, 500)}`);
        if (s["VS-REFERENCE"]) parts.push(`VS-REFERENCE: ${clip(s["VS-REFERENCE"], 500)}`);
        parts.push(`WASTE: ${clip(s.WASTE, 350)}`);
        parts.push(`FIX-IDEAS: ${clip(s["FIX-IDEAS"], 350)}`);
      } else parts.push(`[${basename(run)}] VERDICT: ${clip(s.VERDICT, 300)}`);
    }
    if (!counted) { missing++; continue; }
    blocks.push(`### ${id}\n${parts.join("\n")}`);
  }
  return { ids: list, noPatch, wrongPatch, missing, referenceUsed, blocks };
}

export function buildSynthPrompt(runs: string[], s: ReturnType<typeof synthInputs>, context?: string): { system: string; user: string } {
  const system = [
    "You are a failure analyst for an autonomous coding agent. You receive per-task post-mortems of FAILED tasks. Produce a markdown report:",
    "1. \"## Taxonomy\" — a table | Mechanism | Count | Task IDs | Definition | of 4-8 failure MECHANISMS (not task-specific). Every task in exactly one primary class.",
    "2. \"## Ranked levers\" — 3-6 MECHANISM-LEVEL interventions (prompt, tools, budget, decoding, multi-attempt selection, training), ranked by tasks plausibly recoverable; for each say which classes it targets and what cheap step-replay or panel metric would screen it.",
    "3. \"## What is NOT fixable at the agent level\" — tasks that look like environment, ambiguous spec, or capability ceiling.",
    "Never propose per-task priors or anything that encodes a specific fix. Be concrete and terse.",
    ...(context ? ["", "AGENT AND BUDGET CONTEXT", context.trim()] : []),
  ].join("\n");
  const user = `Runs: ${runs.map((r) => basename(r)).join(", ")}. Deterministic split: ${s.noPatch} no-patch, ${s.wrongPatch} wrong-patch.\n\n${s.blocks.join("\n\n")}`;
  return { system, user };
}

// ---------------------------------------------------------------------------------------------
// class sizing across draws

/** Keyword classifier from free-text mechanism names onto a small, generic class set, so
 *  taxonomies written independently per run can be counted together. Order matters: first hit wins. */
export function classifyMechanism(name: string): string {
  const m = name.toLowerCase();
  if (/budget|exhaust|stall|diagnosis-to-action|never translat/.test(m)) return "budget";
  if (/misdiag|locali|root.?cause|misdirect|wrong file|shallow/.test(m)) return "misdiagnosis";
  if (/incomplete|partial|missing call|under-?implement|contract/.test(m)) return "incomplete";
  if (/edit|tool-use loop|mechanical|malformed|lost edit/.test(m)) return "edit";
  if (/verif|process|submission|test oracle|unverified|non-minimal|scope creep/.test(m)) return "verification";
  if (/near|surface/.test(m)) return "nearmiss";
  if (/design|scope|shape|convention|architect/.test(m)) return "design";
  if (/ambig|underspec/.test(m)) return "ambiguous";
  return "other";
}

/** Task id -> classes, read from a synthesis's "## Taxonomy" table. Ids are recognised by
 *  membership in `knownIds` (the run's own rows), never by a naming pattern. */
export function parseTaxonomy(md: string, knownIds: Set<string>): Record<string, string[]> {
  const start = md.search(/^##\s*Taxonomy/im);
  let body = start >= 0 ? md.slice(start) : md;
  const next = body.slice(2).search(/^##\s/m);
  if (start >= 0 && next >= 0) body = body.slice(0, next + 2);
  const out: Record<string, string[]> = {};
  for (const line of body.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim()).slice(1, -1);
    if (cells.length < 2) continue;
    const ids = cells.slice(1).flatMap((c) => c.split(/[\s,;`]+/)).filter((t) => knownIds.has(t));
    const cls = classifyMechanism(cells[0]);
    for (const id of new Set(ids)) (out[id] ??= []).push(cls);
  }
  return out;
}

export type Draw = { res: Record<string, boolean>; failCls: Record<string, string[]> };

/** How big is each failure class, and how much of it is plausibly recoverable? A failed
 *  task-draw counts toward its classes (split evenly when several). It is "on a solvable task"
 *  when the same task resolved in some other draw, and its expected recoverable share is that
 *  task's resolve rate across all draws. */
export function tallyClasses(draws: Draw[]) {
  const nDraws: Record<string, number> = {}, nSolved: Record<string, number> = {};
  let taskDraws = 0;
  for (const d of draws) for (const [id, ok] of Object.entries(d.res)) {
    taskDraws++; nDraws[id] = (nDraws[id] ?? 0) + 1; if (ok) nSolved[id] = (nSolved[id] ?? 0) + 1;
  }
  const classes: Record<string, { fails: number; onSolvable: number; expRecoverable: number }> = {};
  for (const d of draws) for (const [id, ks] of Object.entries(d.failCls)) {
    if (d.res[id] !== false) continue;
    const uniq = [...new Set(ks)], share = 1 / uniq.length;
    for (const k of uniq) {
      const t = (classes[k] ??= { fails: 0, onSolvable: 0, expRecoverable: 0 });
      t.fails += share;
      if (nSolved[id]) { t.onSolvable += share; t.expRecoverable += share * (nSolved[id] / nDraws[id]); }
    }
  }
  return { draws: draws.length, taskDraws, classes };
}

export function loadDraw(runDir: string): Draw | null {
  const sp = join(runDir, "frontier-synthesis.md");
  const rows = loadRows(runDir);
  if (!existsSync(sp) || !rows.length) return null;
  const res: Record<string, boolean> = {};
  for (const r of rows) res[rowId(r)!] = binaryOutcome(r.resolved) === true;
  return { res, failCls: parseTaxonomy(readFileSync(sp, "utf8"), new Set(Object.keys(res))) };
}

