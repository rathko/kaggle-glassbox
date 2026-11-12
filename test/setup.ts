// Preloaded by bunfig.toml for every `bun test`. A few statistical tests take seconds (exhaustive split
// enumeration, permutation tests, Monte Carlo); on a loaded or slow machine bun's 5 s default timed some of
// them out (15 of 32 parallel full-suite runs, 2026-11-12). A slow machine is not a failure.
import { setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000);
