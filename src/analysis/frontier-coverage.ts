#!/usr/bin/env bun
// frontier-coverage: is every task row of a run covered by a complete frontier analysis?
// Prints a JSON report and exits 0 only when coverage is complete, so a run closeout (or a
// score-gate instrument check, see integrity/score-gate.ts) can require it.
//
// usage: bun src/analysis/frontier-coverage.ts <run-dir>
import { resolve } from "node:path";
import { analysisCoverage } from "./frontier";
import { strictArgs } from "../cli-args";

const [dir] = strictArgs(process.argv.slice(2), { positionals: [1, 1] }, "usage: bun src/analysis/frontier-coverage.ts <run-dir>");
const report = analysisCoverage(resolve(dir));
console.log(JSON.stringify(report, null, 2));
process.exit(report.complete ? 0 : 1);
