#!/usr/bin/env bun
// capture-required: the "every run captures, no opt-out" guard.
//
// The discipline this encodes: a measurement you didn't capture is a measurement you can never
// re-examine. If a run looked wrong after the fact — a tool call that shouldn't have happened, a
// prompt that didn't render the way you thought — the only way to find out why is to look at the
// actual per-step model input/output. That is only possible if it was captured *at run time*
// (via wire-tap.ts --capture-full); there is no reconstructing it afterwards.
//
// The convention: every one of your harness's runner scripts that is NOT the one designated
// capturing runner imports this module for its side effect. Importing it refuses immediately —
// before the runner can start a task — so a runner can never silently regress into running
// without capture. The one capturing runner (the sole entry point real evaluation traffic should
// go through) must NOT import this module, and must itself spawn the proxy with
// `--capture-full` and have no environment-variable or flag opt-out.
//
// Usage in a non-capturing runner script (put this as the first import):
//   import "../capture/capture-required";
//
// This file has no exports to call — importing it IS the guard. Keeping it a bare side effect
// (rather than a function the runner has to remember to call) means a runner cannot forget to
// invoke it; it can only forget to import it at all, which is what the convention check in
// capture-required.test.ts is for.
console.error(
  "REFUSED: this runner does not capture per-step model input/output. " +
  "Every run must go through the one designated capturing runner, which spawns " +
  "src/capture/wire-tap.ts with --capture-full and has no opt-out."
);
process.exit(2);
