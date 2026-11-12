#!/usr/bin/env bun
// frontier-class-size: sizes each failure class across several draws (runs) by reading every
// run's frontier-synthesis.md taxonomy table and task_results.jsonl.
//
// A taxonomy from one run says what failed; it does not say which class is worth attacking.
// Across draws, a failure on a task that resolved in some OTHER draw is plausibly recoverable,
// and the task's resolve rate is the expected share. Ranking classes by that expected
// recoverable count points at the lever with the most headroom, not the loudest anecdote.
// Mechanism names are free text written per run, so they are mapped onto a small generic class
// set by keyword (classifyMechanism in frontier.ts); adjust it if your taxonomies use other words.
//
// usage: bun src/analysis/frontier-class-size.ts <run-dir> [<run-dir> ...]
import { loadDraw, tallyClasses, type Draw } from "./frontier";
import { strictArgs } from "../cli-args";

const runs = strictArgs(process.argv.slice(2), { positionals: [1, Infinity] }, "usage: bun src/analysis/frontier-class-size.ts <run-dir> [<run-dir> ...]");
const draws: Draw[] = [];
for (const r of runs) {
  const d = loadDraw(r);
  if (d) draws.push(d); else console.error(`skip ${r}: needs task_results.jsonl and frontier-synthesis.md`);
}
if (!draws.length) process.exit(1);
const t = tallyClasses(draws);
const resolved = draws.reduce((a, d) => a + Object.values(d.res).filter(Boolean).length, 0);
console.log(`draws ${t.draws}, task-draws ${t.taskDraws}, resolved ${resolved}`);
for (const [k, c] of Object.entries(t.classes).sort((a, b) => b[1].expRecoverable - a[1].expRecoverable || b[1].fails - a[1].fails)) {
  console.log(`${k.padEnd(13)} failed task-draws ${c.fails.toFixed(0).padStart(4)} | on solvable tasks ${c.onSolvable.toFixed(0).padStart(4)} | expected recoverable ${c.expRecoverable.toFixed(1).padStart(6)} = ${(100 * c.expRecoverable / t.taskDraws).toFixed(1)}% of task-draws`);
}
