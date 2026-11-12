#!/usr/bin/env bun
// instrument-repair: the ONLY way to repair a failed post-run instrument, per score-gate's rules.
// Refuses unless the instrument is repairable, the raw artifacts are unchanged since run end, and
// no score has been read yet. Re-runs the instrument's own tool against the unchanged artifacts,
// then your own post-run guard, then records the outcome (success or not) either way. A repair counts only if
// the tool exited 0, the guard (when given) exited 0, AND the guard's instruments.json now says the instrument
// is ok; that one verdict is what gets recorded, printed, and returned as the exit code.
//
// You provide the mapping from instrument name to the command that regenerates it via
// --tool-cmd (repeatable) or a small JSON file via --tool-map, because that command is specific
// to your own harness (e.g. "whatever regenerates your analysis pass"). This file only owns the
// repair *rule*, not the regeneration logic.
//
// usage:
//   bun src/integrity/instrument-repair.ts <run-dir> <instrument> \
//     --tool-cmd analysis="bun,my-analysis.ts,{runDir}" \
//     --tool-cmd capture="bun,src/capture/capture-attribute.ts,{runDir},{runDir}/capture" \
//     [--guard-cmd "bun,my-instrument-guard.ts,{runDir}"]
//
// {runDir} in a --tool-cmd / --guard-cmd token is substituted with the run directory.
import { readFileSync } from "node:fs";
import { assertRepairAllowed, recordRepair } from "./score-gate";
import { strictArgs } from "../cli-args";

const argv = process.argv.slice(2);
const [runDir, instrument] = strictArgs(argv, { valued: ["tool-cmd", "guard-cmd"], repeatable: ["tool-cmd"], positionals: [2, 2] },
  'usage: bun src/integrity/instrument-repair.ts <run-dir> <instrument> --tool-cmd name="cmd,with,{runDir}" [--guard-cmd "cmd,with,{runDir}"]') as [string, string];
try { assertRepairAllowed(runDir, instrument); } catch (e: any) { console.error(e.message); process.exit(3); }

const toolMap: Record<string, string> = {};
for (let i = 0; i < argv.length; i++) if (argv[i] === "--tool-cmd") { const [name, cmd] = argv[i + 1].split(/=(.+)/); toolMap[name] = cmd; }
const guardCmdFlagIdx = argv.indexOf("--guard-cmd");
const guardCmd = guardCmdFlagIdx >= 0 ? argv[guardCmdFlagIdx + 1] : null;

const fill = (tmpl: string) => tmpl.split(",").map((tok) => tok.replace(/\{runDir\}/g, runDir));
const sh = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  return p.exited;
};

const cmdSpec = toolMap[instrument];
if (!cmdSpec) { console.error(`REFUSED: no --tool-cmd given for instrument '${instrument}'`); process.exit(2); }
const toolRc = await sh(fill(cmdSpec));
const guardRc = guardCmd ? await sh(fill(guardCmd)) : null;

let now: any = null;
try { now = JSON.parse(readFileSync(`${runDir}/instruments.json`, "utf8")).checks?.[instrument] ?? null; } catch {}
let ref = "unknown";
try { ref = (await new Response(Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" }).stdout).text()).trim() || "unknown"; } catch {}
const why = [...(toolRc !== 0 ? [`tool rc=${toolRc}`] : []), ...(guardRc !== null && guardRc !== 0 ? [`guard rc=${guardRc}`] : []),
  ...(now ? (now.ok ? [] : ["instrument still failing"]) : ["no current check in instruments.json"])];
const ok = why.length === 0;
recordRepair(runDir, instrument, ref, ok, [String(now?.detail ?? ""), ...why].filter(Boolean).join("; "));
console.log(`REPAIR ${instrument}: ${ok ? "OK" : "NOT REPAIRED"} (${[now?.detail, ...why].filter(Boolean).join("; ")}) tool rc=${toolRc}${guardRc !== null ? ` guard rc=${guardRc}` : ""} at ${ref.slice(0, 8)}`);
process.exit(ok ? 0 : 1);
