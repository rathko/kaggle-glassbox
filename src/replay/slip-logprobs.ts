#!/usr/bin/env bun
// slip-logprobs: measures how close an alternative token was to being chosen, at the exact
// position where a captured model output diverged from the shape you wanted.
//
// WHY: when a model "almost" gets something right — picks the wrong delimiter, closes a string
// one token too early, repeats a malformed call — it's easy to argue from the sampled text alone
// about how close a fix is. This tool answers it directly: re-send the same captured onset state
// once with `logprobs` + `top_logprobs` enabled, find the token at the position your `--pattern`
// regex locates, and read off the probability the model actually assigned to your candidate
// `--alt-token` at that exact step. If the alternative had real mass in the top-k, a cheap
// intervention (grammar constraint, logit bias, a one-line prompt change) is plausible. If it had
// none, you're not one token away from a fix and should look elsewhere.
//
// Input is the same generic "states" index used by replay-states.ts (one JSON object per line:
// corpus, run, group, seq, flagged, fingerprint, outcome, ambiguous); this tool keeps only the
// first (non-repeat) flagged state per run — the onsets.
//
// usage: bun src/replay/slip-logprobs.ts --states-file rows.jsonl --capture-root <dir>
//          --pattern '<regex>' --alt-token '<token text>' [--n 2] [--pool 6]
//          [--base http://127.0.0.1:8010] [--out results.jsonl]
//
// --pattern is matched against the full concatenated sampled token text; the LAST token whose
// span starts at or before the match's start is treated as "the slip step". --alt-token is
// compared against the server's own top_logprobs token strings for that step, so it must be
// given exactly as your tokenizer renders it (e.g. a delimiter token some chat templates use for
// string boundaries).
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { postChat } from "./endpoint";
import { quantile7 } from "../noise-floor/aa-splits";
import { join, dirname } from "node:path";
import { assertValidCaptures, logprobProblems } from "./capture-valid";
import { countFlag } from "./cli-num";
import { strictArgs } from "../cli-args";
import { readManifestArchive } from "../capture/archives";
import { candidateRows, makeRunLoader, runKeyCollisions, stateRowProblems } from "./state-rows";

const a = process.argv.slice(2);
strictArgs(a, { valued: ["states-file", "capture-root", "pattern", "alt-token", "n", "pool", "base", "out"] },
  "usage: bun src/replay/slip-logprobs.ts --states-file <jsonl> --capture-root <dir> --pattern <regex> --alt-token <token> [--n 2] [--pool 6] [--base URL] [--out results.jsonl]");
const flag = (n: string, d?: string) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : d; };
const N = countFlag("n", flag("n"), 2), POOL = countFlag("pool", flag("pool"), 6);
const BASE = flag("base", "http://127.0.0.1:8010")!;
const OUT = flag("out", "./results/slip-logprobs.jsonl")!;
const STATES_FILE = flag("states-file"), CAP_ROOT = flag("capture-root");
const PATTERN = flag("pattern"), ALT_TOKEN = flag("alt-token");
if (!STATES_FILE || !CAP_ROOT || !PATTERN || !ALT_TOKEN) {
  console.error("usage: --states-file <jsonl> --capture-root <dir> --pattern <regex> --alt-token <token> [options]");
  process.exit(2);
}
mkdirSync(dirname(OUT), { recursive: true });
const RE = new RegExp(PATTERN);

// every row, ambiguous ones included, takes part in consecutive-call detection; only non-ambiguous rows can be onsets
const allRows = readFileSync(STATES_FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const rowProblems = stateRowProblems(allRows);
if (rowProblems.length) { console.error(`states index: ${rowProblems.slice(0, 10).join("; ")}${rowProblems.length > 10 ? ` ... and ${rowProblems.length - 10} more` : ""}`); process.exit(1); }
const clash = runKeyCollisions(allRows);
if (clash.length) { console.error(`states index: ${clash.join("; ")}`); process.exit(1); }
const onsets: any[] = candidateRows(allRows).filter(({ row, repeat }) => !repeat && row.flagged).map(({ row }) => row);
const capCache = new Map<string, any[]>();
const cap = (c: string, g: string) => {
  const k = `${c}/${g}`;
  if (!capCache.has(k)) {
    const snaps = readManifestArchive(join(CAP_ROOT!, c, "capture"), String(g));
    assertValidCaptures(snaps, `${c}/${g}`);
    capCache.set(k, snaps);
  }
  return capCache.get(k)!;
};

// A run can span several capture groups: every group of each selected run is merged and validated as one
// trajectory BEFORE any job is created, so a broken exchange elsewhere in the run rejects the whole measurement
// instead of letting the onset's own (valid) group be replayed alone.
const runCap = makeRunLoader(allRows, cap, assertValidCaptures);
const onsetSnap = new Map<any, any>();
for (const o of onsets) {
  let traj: { snap: any; group: string }[];
  try { traj = runCap(o.corpus, o.run); } catch (e) { console.error(`states index: ${(e as Error).message}`); process.exit(1); }
  const on = traj.find((x) => x.snap.seq === o.seq);
  if (!on || on.group !== String(o.group)) { console.error(`states index: ${o.corpus}/${o.run} seq ${o.seq} is not in capture group ${o.group}`); process.exit(1); }
  onsetSnap.set(o, on.snap);
}
const jobs = onsets.flatMap((o) => Array.from({ length: N }, (_, k) => ({ o, k })));
const found: { p: number; pd: number; tok: string }[] = [];
let noMatch = 0, errors = 0;
await Promise.all(Array.from({ length: POOL }, async () => {
  for (let j; (j = jobs.shift()); ) {
    const req = JSON.parse(JSON.stringify(onsetSnap.get(j.o).request));
    req.logprobs = true; req.top_logprobs = 10;
    try {
      const res: any = await postChat(BASE, req);
      // missing or malformed log probabilities are a failed call, never a "no match": counted as an error, exit 1
      const lp = logprobProblems(res);
      if (lp.length) throw new Error(`unusable logprobs: ${lp.slice(0, 3).join("; ")}`);
      const toks: any[] = res.choices[0].logprobs.content;
      // Map the matched text span to the token whose span covers its start.
      let full = "", starts: number[] = [];
      for (const x of toks) { starts.push(full.length); full += x.token; }
      const m = RE.exec(full);
      let hit = -1;
      if (m) { const pos = m.index; for (let i = 0; i < starts.length; i++) if (starts[i] <= pos) hit = i; }
      if (hit < 0) { noMatch++; appendFileSync(OUT, JSON.stringify({ run: `${j.o.corpus}/${j.o.run}`, seq: j.o.seq, k: j.k, matched: false, ntok: toks.length }) + "\n"); continue; }
      const t = toks[hit];
      const pd = Math.exp(t.top_logprobs.find((x: any) => x.token === ALT_TOKEN)?.logprob ?? -Infinity);
      const rec = { run: `${j.o.corpus}/${j.o.run}`, seq: j.o.seq, k: j.k, matched: true, tok: t.token, p: Math.exp(t.logprob), pAlt: pd, top: t.top_logprobs.slice(0, 5).map((x: any) => [x.token, +Math.exp(x.logprob).toFixed(4)]) };
      found.push({ p: rec.p, pd, tok: t.token });
      appendFileSync(OUT, JSON.stringify(rec) + "\n");
    } catch (e) { errors++; console.error(`ERR ${j.o.run} ${String(e).slice(0, 160)}`); }
  }
}));
found.sort((x, y) => x.pd - y.pd);
const q = (f: number) => found.length ? quantile7(found.map((x) => x.pd), f).toFixed(4) : "-";
console.log(`onsets ${onsets.length} x N=${N}: matched ${found.length}, no match ${noMatch}, errors ${errors}`);
console.log(`p(alt token) at slip step: p10 ${q(0.1)} median ${q(0.5)} p90 ${q(0.9)}; alt token in top-10 at ${found.filter((x) => x.pd > 0).length}/${found.length}`);
console.log(`sampled token prob median ${found.length ? quantile7(found.map((x) => x.p).sort((a, b) => a - b), 0.5).toFixed(4) : "-"}`);

if (errors) { console.error(`${errors} call(s) failed and are excluded from every count above`); process.exit(1); }
