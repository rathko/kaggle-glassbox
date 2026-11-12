#!/usr/bin/env bun
// read-continuous-score: the earlier name of examples/read-platform-score.ts, kept so existing commands keep working.
// It is the same reader (a platform-computed score for an artifact-only run, continuous or not); see that file.
//
// usage: bun examples/read-continuous-score.ts <run-dir> (--score <number> | --score-file <path> [--field score])
import { main } from "./read-platform-score";
export * from "./read-platform-score";

if (import.meta.main) main(process.argv.slice(2), "examples/read-continuous-score.ts");
