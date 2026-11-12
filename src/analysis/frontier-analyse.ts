#!/usr/bin/env bun
// frontier-analyse: writes <run>/analysis/<id>.md, a model-written post-mortem per task
// (VERDICT / TIMELINE / WASTE / CONTEXT / FIX-IDEAS), from the run's captured trajectories.
// See frontier.ts for the input formats and the reasoning behind each choice.
//
// Two modes:
//   batch (default)  analyse every task row that lacks a complete analysis, then exit.
//   --watch          poll task_results.jsonl while a run is still going, so each task's analysis
//                    appears the moment its row does. Exits once <run>/analysis/.run-complete
//                    exists (your harness touches it when the run ends) AND every row is analysed,
//                    or after --max-idle seconds with no new rows.
//
// The analyst is any OpenAI-compatible chat endpoint (see openai-chat.ts); a local vLLM server
// running the same small model you evaluate is enough, and costs nothing per call.
//
// REFERENCE PATCHES: none by default. `--reference-patch <file>` is an explicit opt-in for users
// with their OWN reference fixes (a .jsonl of { instance_id, patch } rows, or one bare patch with
// --only). Do not point it at benchmark gold patches you are not licensed to show a model.
//
// usage:
//   bun src/analysis/frontier-analyse.ts <run-dir> [--capture <dir>] [--only <id>]
//       [--concurrency 2] [--force] [--limit N] [--context-file <md>]
//       [--reference-patch <file>] [--watch [--poll 8] [--max-idle 1800]]
//       [--base-url URL] [--model NAME] [--api-key KEY] [--max-tokens 2048] [--temperature 0.2]
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { countFlag } from "../replay/cli-num";
import { strictArgs } from "../cli-args";
import { join } from "node:path";
import { chatComplete, resolveChatConfig, type ChatConfig } from "./openai-chat";
import {
  loadRows, rowId, loadTaskExchanges, loadAgentPatch, loadReferencePatches, buildTaskPrompt,
  renderAnalysis, readAnalysisMeta, parseSections, requiredSections, RUN_COMPLETE_SENTINEL, idFile,
} from "./frontier";

const argv = process.argv.slice(2);
const USAGE = "usage: bun src/analysis/frontier-analyse.ts <run-dir> [--capture dir] [--only id] [--concurrency N] [--force] [--reference-patch file] [--watch] [--base-url URL] [--model NAME]";
const [RUN] = strictArgs(argv, {
  valued: ["capture", "only", "concurrency", "limit", "poll", "max-idle", "context-file", "reference-patch", "base-url", "model", "api-key", "max-tokens", "temperature", "timeout-ms"],
  bool: ["force", "watch"],
  positionals: [1, 1],
}, USAGE);
if (!existsSync(RUN)) { console.error(`no such run dir: ${RUN}`); process.exit(2); }
const flag = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const has = (n: string) => argv.includes(`--${n}`);

let cfg: ChatConfig;
try { cfg = resolveChatConfig(argv); } catch (e: any) { console.error(`frontier-analyse: ${e.message}`); process.exit(2); }

const CAPTURE = flag("capture", join(RUN, "capture"))!;
const ONLY = flag("only");
const CONC = countFlag("concurrency", argv.includes("--concurrency") ? flag("concurrency") : undefined, 2);
const LIMIT = countFlag("limit", argv.includes("--limit") ? flag("limit") : undefined, 0, 0); // 0 = no limit
const POLL_S = countFlag("poll", argv.includes("--poll") ? flag("poll") : undefined, 8);
const MAX_IDLE_S = countFlag("max-idle", argv.includes("--max-idle") ? flag("max-idle") : undefined, 1800);
const FORCE = has("force");
const CONTEXT = flag("context-file") ? readFileSync(flag("context-file")!, "utf8") : undefined;
const REF_FILE = flag("reference-patch");
let REFS = new Map<string, string>();
try { if (REF_FILE) REFS = loadReferencePatches(REF_FILE, ONLY); } catch (e: any) { console.error(`frontier-analyse: ${e.message}`); process.exit(2); }
if (REF_FILE) console.log(`OPT-IN: reading user-supplied reference patches from ${REF_FILE} (${REFS.size} task(s)); analyses will say so`);

const ADIR = join(RUN, "analysis");
mkdirSync(ADIR, { recursive: true });
try { chmodSync(ADIR, 0o775); } catch {}

function needsAnalysis(id: string): boolean {
  if (FORCE) return true;
  const p = join(ADIR, `${idFile(id)}.md`);
  if (!existsSync(p)) return true;
  const md = readFileSync(p, "utf8");
  const meta = readAnalysisMeta(md);
  if (!meta.frontier) return true;
  const s = parseSections(md);
  return requiredSections(meta.referenceUsed).some((k) => !s[k]);
}

function pendingRows(): any[] {
  return loadRows(RUN, { partialTail: has("watch") }).filter((r) => (!ONLY || rowId(r) === ONLY) && needsAnalysis(rowId(r)!));
}

let failed = 0;
async function analyseOne(row: any): Promise<boolean> {
  const id = rowId(row)!;
  const patch = loadAgentPatch(RUN, id, row);
  const ref = REFS.get(id);
  try {
    // an invalid captured trajectory throws here and is reported as a failed task, never analysed with holes in it
    const { system, user } = buildTaskPrompt({ id, row, exchanges: loadTaskExchanges(CAPTURE, id), agentPatch: patch, referencePatch: ref, context: CONTEXT });
    const body = await chatComplete(cfg, system, user);
    const out = join(ADIR, `${idFile(id)}.md`);
    writeFileSync(out, renderAnalysis({ id, row, patchBytes: Buffer.byteLength(patch), reference: ref !== undefined ? REF_FILE! : null, body }));
    try { chmodSync(out, 0o664); } catch {}
    console.log(`  OK   ${id}  ${body.length} chars`);
    return true;
  } catch (e: any) {
    failed++;
    console.log(`  FAIL ${id}  ${String(e?.message ?? e).slice(0, 300)}`);
    return false;
  }
}

async function drain(pending: any[]): Promise<number> {
  if (LIMIT > 0) pending = pending.slice(0, LIMIT);
  let done = 0, idx = 0;
  const worker = async () => { while (idx < pending.length) if (await analyseOne(pending[idx++])) done++; };
  await Promise.all(Array.from({ length: Math.min(CONC, pending.length) }, worker));
  return done;
}

if (!has("watch")) {
  const pending = pendingRows();
  console.log(`${RUN}: ${pending.length} task(s) need analysis (model ${cfg.model}, concurrency ${CONC})`);
  const n = await drain(pending);
  console.log(`wrote ${n} analyses to ${ADIR}; failures ${failed}`);
  if (failed) { console.log("A FAILURE IS NOT AN EMPTY ANALYSIS: the missing files are missing, not negative findings."); process.exit(1); }
  process.exit(0);
}

console.log(`${RUN}: watching (poll ${POLL_S}s, model ${cfg.model}, concurrency ${CONC})`);
let idle = 0, total = 0;
for (;;) {
  const pending = pendingRows();
  if (pending.length) { total += await drain(pending); idle = 0; } else idle += POLL_S;
  // Check the sentinel FIRST, then re-read the rows: a drain can take minutes, and rows written
  // during it (the last tasks of a concurrent run tend to finish together) are not in `pending`.
  const complete = existsSync(join(ADIR, RUN_COMPLETE_SENTINEL));
  const rows = loadRows(RUN, { partialTail: !complete }) // once the run is complete, an unterminated last row must parse too
   .filter((r) => !ONLY || rowId(r) === ONLY);
  // A task whose call failed this session is not retried in the same session; it stays missing.
  if (complete && rows.length > 0 && pendingRows().length <= failed) {
    console.log(`${RUN}: run complete and all ${rows.length - failed} tasks analysed (${total} this session, ${failed} failed). exiting.`);
    process.exit(failed ? 1 : 0);
  }
  if (idle >= MAX_IDLE_S) { console.log(`${RUN}: idle ${idle}s with no new rows; exiting (analysed ${total}).`); process.exit(failed ? 1 : 0); }
  await Bun.sleep(POLL_S * 1000);
}
