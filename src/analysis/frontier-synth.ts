#!/usr/bin/env bun
// frontier-synth: cross-task synthesis of the per-task frontier analyses
// (<run>/analysis/<id>.md, written by frontier-analyse.ts) into one failure taxonomy with counts
// and ranked, mechanism-level levers. Writes <first run>/frontier-synthesis.md.
//
// Per-task post-mortems are easy to produce and easy to never read. A run closeout that reads
// only the resolve count misses the mechanisms; this turns them into one page.
//
// Deterministic part (from each analysis's patch_bytes marker): the no-patch vs wrong-patch split.
// Model part (any OpenAI-compatible endpoint, see openai-chat.ts): the taxonomy and the levers.
// If any analysis read a user-supplied reference patch, the header says so: that text is for
// humans and must not be pasted into a shipped prompt.
//
// usage: bun src/analysis/frontier-synth.ts <run-dir> [<run-dir> ...] [--ids <file>] [--out <md>]
//          [--context-file <md>] [--base-url URL] [--model NAME] [--api-key KEY]
//   default task set = tasks NOT resolved in the first run; --ids overrides (one id per line, or csv).
//   later runs contribute a one-line VERDICT per task, to show whether a mechanism repeats.
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { chatComplete, resolveChatConfig, type ChatConfig } from "./openai-chat";
import { synthInputs, buildSynthPrompt, SYNTH_MARK } from "./frontier";
import { strictArgs } from "../cli-args";

const argv = process.argv.slice(2);
const runs = strictArgs(argv, { valued: ["ids", "out", "context-file", "base-url", "model", "api-key", "max-tokens", "temperature", "timeout-ms"], positionals: [1, Infinity] },
  "usage: bun src/analysis/frontier-synth.ts <run-dir> [<run-dir>...] [--ids file] [--out md] [--base-url URL] [--model NAME]");
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

let cfg: ChatConfig;
try { cfg = resolveChatConfig(argv); } catch (e: any) { console.error(`frontier-synth: ${e.message}`); process.exit(2); }

const ids = flag("ids") ? readFileSync(flag("ids")!, "utf8").split(/[\s,]+/).filter(Boolean) : undefined;
const s = synthInputs(runs, ids);
console.log(`tasks ${s.ids.length}; analysed ${s.ids.length - s.missing}; no-patch ${s.noPatch}; wrong-patch ${s.wrongPatch}; missing analysis ${s.missing}`);
if (!s.blocks.length) { console.error("frontier-synth: no analysed failed tasks to synthesise (run frontier-analyse.ts first)"); process.exit(1); }

const context = flag("context-file") ? readFileSync(flag("context-file")!, "utf8") : undefined;
const { system, user } = buildSynthPrompt(runs, s, context);
let report: string;
try { report = await chatComplete(cfg, system, user); }
catch (e: any) { console.error(`frontier-synth: model call failed: ${e.message}`); process.exit(1); }

const outPath = flag("out") ?? join(runs[0], "frontier-synthesis.md");
const provenance = s.referenceUsed
  ? "Some analyses read user-supplied reference patches: human use only, never paste into a shipped prompt."
  : "No reference patches were read: the analyst saw only the trajectories and the agent's own patches.";
const header = `${SYNTH_MARK}\n# Frontier synthesis — ${runs.map((r) => r.replace(/\/+$/, "").split("/").pop()).join(" + ")}\n\n` +
  `Generated ${new Date().toISOString()} by src/analysis/frontier-synth.ts (model ${cfg.model}). ` +
  `Tasks: ${s.ids.length} (${s.noPatch} no-patch, ${s.wrongPatch} wrong-patch, ${s.missing} without analysis). ${provenance}\n\n`;
writeFileSync(outPath, header + report.trim() + "\n");
try { chmodSync(outPath, 0o664); } catch {}
console.log(`wrote ${outPath}`);
