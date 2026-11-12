#!/usr/bin/env bun
// fork-run: resumes ONE captured task from step K, N times in parallel, under YOUR OWN agent
// harness, and grades each rollout with the harness's own scoring. This is the orchestrator half
// of forking (see fork-proxy.ts for the mechanism); this file is deliberately harness-agnostic —
// you tell it how to invoke your harness, it handles spinning up N forced-replay proxies, waiting
// for each to come up, running your harness against it, and reading back whether each rollout
// resolved the task.
//
// NEVER run this while a timed/scored evaluation owns the real model server — forked rollouts
// share its decode budget just like any other traffic.
//
// Required:
//   --source-dir <dir>     a results dir with a capture/ subdir (wire-tap + capture-compact +
//                           capture-attribute already run on it)
//   --task <id>            task id to fork, as it appears in manifest.json "instances"
//   --fork <K>             fork after the K-th captured exchange (0 = fork at the very start)
//     (or --seq <S> to fork AT the captured exchange whose own seq number is S)
//   --harness-cmd <tmpl>   comma-separated argv template for your harness invocation, e.g.
//                          "bun,my-harness.ts,{submission},{runName},{taskFile}"
//   --results-root <dir>  where your harness writes "<runName>/task_results.jsonl"
// Optional:
//   --upstream <url>       live model server fork-proxy forwards to past step K (default
//                          http://127.0.0.1:8010)
//   --env '<json>'         extra env vars for the harness process; string values may use the
//                          same {placeholders} as --harness-cmd
//   --task-file <path>     written as a one-line file naming the task, if your harness expects
//                          a task-list file on disk; value is also available as {taskFile}
//   --submission <name>    arbitrary label available as {submission} (e.g. a prompt/config name)
//   --n N                  rollouts to run (default 4)
//   --pool N               concurrency (default = --n)
//   --tag <name>           run tag; default is auto-generated from task + fork point (a task id that is not a safe
//                          file name, e.g. "a/b" or "../x", becomes a slug plus a short hash). An explicit tag must be
//                          letters, digits, "_", "-" or "." (no leading dot, no "..") or it is a usage error
//   --listen-host <host>   interface fork-proxy binds (default 127.0.0.1); a harness in a container needs the bridge
//                          address or 0.0.0.0 (a warning is printed for anything that is not loopback)
//   --advertise-host <host> host put into {proxyUrl} (default 127.0.0.1, or the --listen-host when that is a specific
//                          address); e.g. host.docker.internal for a containerised harness
//   --task-header <name>   request header carrying the task id, removed before the live request goes upstream
//                          (default x-task-id)
//   --fast                 drop fork-proxy's clock fidelity (debugging only)
//   --kinds tools|single   how fork-proxy matches requests to captured steps (see fork-proxy.ts)
//   --normalise <regex>    sandbox-path pattern fork-proxy blanks before comparing tool output
//   --ignore-roles <list>  roles left out when fork-proxy compares message history for a harness with no tool
//                          messages (default system, so a prompt fork stays comparable; none = compare all)
//   --result-file <tmpl>   where one rollout's result lands (default {resultsRoot}/{runName}/task_results.jsonl);
//                          JSON or JSONL; the row whose --task-field equals --task is used (a file holding
//                          exactly one row WITHOUT a task field is taken as that task's row)
//   --task-field <name>    row field holding the task id (default instance_id)
//   --outcome-field <name> row field holding the outcome (default resolved); true, 1, "true", "pass",
//                          "passed", "resolved" or "success" count as solved
//   --outcome-threshold <T> for a numeric outcome (a reward or score such as 0.73): >= T counts as solved, below T
//                          as a miss; without it a non-binary value is unreadable and the rollout invalid
//   --outcome-direction higher|lower  which side of T is a success (default higher); lower for a loss or an error
//                          (<= T counts as solved). Recorded in the output with the threshold.
//
// Available placeholders in --harness-cmd / --env: {proxyUrl} {proxyPort} {runName}
// {resultsRoot} {submission} {taskFile}, plus {meta.<key>} for any top-level key found in
// <source-dir>/stack.json (if present) — the slot for whatever per-run metadata your harness
// produces (e.g. a wall-clock budget or dataset location), without this tool having to know your
// harness's env-var names.
//
// A rollout is VALID only if the harness exited 0, its outcome was readable, every one of the K captured steps
// was forced, and none of them diverged. Anything else is an instrument failure, not a model outcome: it is
// excluded from the rate and listed in `invalid_reasons`, so a crash, a lost result file or a rebuilt state that
// differs from the source run can never pass for a solve or a miss.
//
// Prints one JSON line {tag, task, fork, n, valid, resolved, rate, invalid, invalid_reasons, divergent, runs} and
// appends it to <results-root>/fork-runs.jsonl.
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, chmodSync } from "node:fs";
import { countFlag } from "./cli-num";
import { strictArgs } from "../cli-args";
import { join } from "node:path";
import { loadSteps, readOutcome, invalidReasons } from "./fork-run-steps.ts";
import { isSafeId, safeId, within } from "../safe-id";
import { listenHost, urlHost } from "../capture/proxy-net";

const a = process.argv.slice(2);
strictArgs(a, {
  valued: ["source-dir", "task", "fork", "seq", "harness-cmd", "results-root", "upstream", "env", "task-file", "submission", "n", "pool", "tag",
    "kinds", "normalise", "ignore-roles", "listen-host", "advertise-host", "task-header", "result-file", "task-field", "outcome-field", "outcome-threshold", "outcome-direction"],
  bool: ["fast"],
}, "usage: bun src/replay/fork-run.ts --source-dir <dir> --task <id> (--fork K | --seq S) --harness-cmd <tmpl> --results-root <dir> [options]\n  (see the header of src/replay/fork-run.ts for the options)");
const flag = (n: string, d?: string) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : d; };
const SRC = flag("source-dir")!, TASK = flag("task")!, HARNESS_CMD = flag("harness-cmd")!, RESULTS_ROOT = flag("results-root")!;
if (!SRC || !TASK || !HARNESS_CMD || !RESULTS_ROOT) {
  console.error("usage: --source-dir <dir> --task <id> (--fork K | --seq S) --harness-cmd <tmpl> --results-root <dir> [options]");
  process.exit(2);
}
const UPSTREAM = flag("upstream", "http://127.0.0.1:8010")!;
const N = countFlag("n", flag("n"), 4), POOL = countFlag("pool", flag("pool"), N);
const FAST = a.includes("--fast");
let LISTEN_HOST: string;
try { LISTEN_HOST = listenHost(flag("listen-host"), "fork-run"); } catch (e) { console.error((e as Error).message); process.exit(2); }
// a wildcard bind is reachable on loopback, so the readiness probe and the default advertised URL use 127.0.0.1
const WILDCARD = LISTEN_HOST === "0.0.0.0" || LISTEN_HOST === "::" || LISTEN_HOST === "[::]";
const PROBE_HOST = WILDCARD ? "127.0.0.1" : LISTEN_HOST;
const ADVERTISE_HOST = flag("advertise-host") ?? PROBE_HOST;
if (!ADVERTISE_HOST.trim() || /[\s/]/.test(ADVERTISE_HOST)) { console.error(`--advertise-host must be a host name or address, got "${ADVERTISE_HOST}"`); process.exit(2); }
// the proxy answers this itself, without the upstream: readiness never depends on the model server's auth or routes
const READY_PATH = "/__fork/ready";
const SUBMISSION = flag("submission", "") ?? "";
const EXTRA_ENV: Record<string, string> = flag("env") ? JSON.parse(flag("env")!) : {};
const RESULT_FILE = flag("result-file", "{resultsRoot}/{runName}/task_results.jsonl")!;
const TASK_FIELD = flag("task-field", "instance_id")!, OUTCOME_FIELD = flag("outcome-field", "resolved")!;
const OUTCOME_THRESHOLD = flag("outcome-threshold") === undefined ? null : Number(flag("outcome-threshold"));
if (OUTCOME_THRESHOLD !== null && (flag("outcome-threshold")!.trim() === "" || !Number.isFinite(OUTCOME_THRESHOLD))) {
  console.error(`--outcome-threshold must be a finite number, got '${flag("outcome-threshold")}'`);
  process.exit(2);
}
const OUTCOME_DIRECTION = (flag("outcome-direction") ?? "higher") as "higher" | "lower";
if (OUTCOME_DIRECTION !== "higher" && OUTCOME_DIRECTION !== "lower") { console.error(`--outcome-direction must be higher or lower, got '${OUTCOME_DIRECTION}'`); process.exit(2); }
if (flag("outcome-direction") !== undefined && OUTCOME_THRESHOLD === null) { console.error("--outcome-direction needs --outcome-threshold"); process.exit(2); }
// exactly one fork point, checked before any capture is read: with both, one of them would silently win
if ((flag("fork") === undefined) === (flag("seq") === undefined)) { console.error("give exactly one of --fork K or --seq S"); process.exit(2); }
const FORK_POINT = flag("fork") ?? flag("seq")!;
if (!/^\d+$/.test(FORK_POINT) || !Number.isSafeInteger(Number(FORK_POINT))) {
  console.error(`--${flag("fork") !== undefined ? "fork" : "seq"} must be a whole number >= 0, got '${FORK_POINT}'`);
  process.exit(2);
}
if (flag("tag") !== undefined && !isSafeId(flag("tag")!)) {
  console.error(`--tag must be one safe file name (letters, digits, _ - .; no leading dot, no ".."), got '${flag("tag")}'`);
  process.exit(2);
}

let meta: Record<string, unknown> = {};
try { meta = JSON.parse(readFileSync(join(SRC, "stack.json"), "utf8")); } catch {}

const all = loadSteps(SRC, TASK);
// --seq S forks AT the captured exchange S: everything before it is forced, S itself is asked live.
const K = flag("seq") !== undefined ? all.findIndex((r) => r.seq === Number(FORK_POINT)) : Number(FORK_POINT);
if (!(Number.isSafeInteger(K) && K >= 0)) throw new Error(`seq/fork point does not identify a captured exchange of ${TASK} in ${SRC}`);
const steps = all.slice(0, K);
if (steps.length < K) throw new Error(`source has only ${all.length} steps; fork point ${K} is past the end`);
const TAG = flag("tag", `${safeId(TASK)}-k${K}-${Date.now().toString(36)}`)!;
// the tag is already one safe component; the containment check is the backstop for any future way of building it
const OUT = within(join(RESULTS_ROOT, "fork"), TAG);
// a reused tag would mix this invocation's rollouts with stale result files and proxy logs from an earlier one
if (existsSync(OUT)) { console.error(`fork output ${OUT} already exists; pick a new --tag`); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const planPath = join(OUT, "plan.json");
writeFileSync(planPath, JSON.stringify({ steps: steps.map((s) => ({ at: s.at, req_at: s.req_at, request: s.request, response: s.response })) }));

const taskFile = flag("task-file") ?? join(OUT, "task.txt");
writeFileSync(taskFile, TASK + "\n");

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (_, k) => vars[k] ?? "");
}

const taken = new Set<number>();
function freePort(): number {
  for (;;) {
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const p = srv.port ?? 0; srv.stop(true);
    if (!p) continue;
    if (!taken.has(p)) { taken.add(p); return p; }
  }
}

const one = async (r: number) => {
  // Ports come from the OS (bind port 0, read it, release) rather than a fixed formula, so a
  // concurrent run can never collide with a port some other live service happens to be using.
  const pport = freePort();
  const runName = `fork-${TAG}-${r}`;
  const plog = join(OUT, `proxy-${r}.jsonl`);
  const proxy = Bun.spawn(
    ["bun", join(import.meta.dir, "fork-proxy.ts"), "--port", String(pport), "--upstream", UPSTREAM, "--plan", planPath, "--log", plog, ...(FAST ? ["--fast"] : []), ...(flag("kinds") ? ["--kinds", flag("kinds")!] : []), ...(flag("normalise") ? ["--normalise", flag("normalise")!] : []), ...(flag("ignore-roles") ? ["--ignore-roles", flag("ignore-roles")!] : []),
      "--listen-host", LISTEN_HOST, ...(flag("task-header") ? ["--task-header", flag("task-header")!] : [])],
    { stdout: "ignore", stderr: "inherit" }
  );
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { up = await fetch(`http://${urlHost(PROBE_HOST)}:${pport}${READY_PATH}`).then((x) => x.ok, () => false); if (!up) await Bun.sleep(250); }
  if (!up) { proxy.kill(); throw new Error(`fork-proxy did not come up on :${pport}`); }

  const vars: Record<string, string> = {
    proxyUrl: `http://${urlHost(ADVERTISE_HOST)}:${pport}`,
    proxyPort: String(pport),
    runName,
    resultsRoot: RESULTS_ROOT,
    submission: SUBMISSION,
    taskFile,
    ...Object.fromEntries(Object.entries(meta).map(([k, v]) => [`meta.${k}`, String(v)])),
  };
  const argvTemplate = HARNESS_CMD.split(",");
  const cmd = argvTemplate.map((tok) => fill(tok, vars));
  const env: Record<string, string> = { ...process.env } as any;
  for (const [k, v] of Object.entries(EXTRA_ENV)) env[k] = fill(v, vars);

  const p = Bun.spawn(cmd, { env, stdout: Bun.file(join(OUT, `run-${r}.log`)), stderr: Bun.file(join(OUT, `run-${r}.err`)) });
  const rc = await p.exited;
  proxy.kill();

  const tr = fill(RESULT_FILE, vars);
  const outcome = existsSync(tr) ? readOutcome(readFileSync(tr, "utf8"), TASK, TASK_FIELD, OUTCOME_FIELD, OUTCOME_THRESHOLD, OUTCOME_DIRECTION) : null;
  if (outcome === null) console.error(`rollout ${r}: no readable outcome in ${tr} (check --result-file / --task-field / --outcome-field)`);
  const pl = existsSync(plog) ? readFileSync(plog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const forced = pl.filter((e) => e.kind === "forced");
  const divergent = forced.filter((e) => !e.same).length;
  const reasons = invalidReasons({ rc, outcome, forced: forced.length, divergent }, K);
  if (reasons.length) console.error(`rollout ${r}: invalid (${reasons.join("; ")}); excluded from the rate`);
  return {
    r, run: runName, rc, resolved: outcome === true, outcomeMissing: outcome === null, forced: forced.length,
    divergent, live: pl.filter((e) => e.kind === "live").length, valid: reasons.length === 0, invalid_reasons: reasons,
  };
};

const runs: Awaited<ReturnType<typeof one>>[] = [];
const todo = Array.from({ length: N }, (_, i) => i);
await Promise.all(Array.from({ length: Math.min(POOL, N) }, async () => { for (let i; (i = todo.shift()) !== undefined; ) runs.push(await one(i)); }));
runs.sort((x, y) => x.r - y.r);
const validRuns = runs.filter((x) => x.valid);
const resolved = validRuns.filter((x) => x.resolved).length, valid = validRuns.length;
const reasonCounts: Record<string, number> = {};
for (const x of runs) for (const why of x.invalid_reasons) { const k = why.replace(/\d+/g, "N"); reasonCounts[k] = (reasonCounts[k] ?? 0) + 1; }
const res = {
  tag: TAG, at: new Date().toISOString(), source_dir: SRC, task: TASK, fork: K, n: N, valid, resolved,
  // how a numeric outcome was read, so a lower-is-better metric can never be mistaken for a higher-is-better one
  outcome: { field: OUTCOME_FIELD, threshold: OUTCOME_THRESHOLD, direction: OUTCOME_THRESHOLD === null ? null : OUTCOME_DIRECTION },
  // the rate is over valid rollouts only; a crash, a missing result or a diverged rebuild is not a model outcome
  rate: valid ? resolved / valid : null, invalid: N - valid, invalid_reasons: reasonCounts,
  divergent: runs.filter((x) => x.divergent > 0).length, runs,
};
appendFileSync(join(RESULTS_ROOT, "fork-runs.jsonl"), JSON.stringify(res) + "\n");
try { chmodSync(join(RESULTS_ROOT, "fork-runs.jsonl"), 0o664); } catch {}
console.log(JSON.stringify(res));
