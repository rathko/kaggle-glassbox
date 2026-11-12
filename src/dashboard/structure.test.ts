// Structure-only traces carry the SHAPE of a real run and nothing else. These tests hold that line on every committed
// sample: no free text, no paths, no internal version labels, only the published tool and step vocabulary, and a
// reader that re-types fields so a crafted file cannot carry text onto the page.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { structureOf, structureTasks } from "./data.ts";

const SAMPLES = join(import.meta.dir, "../../examples/sample-runs");
const runs = readdirSync(SAMPLES).filter((d) => existsSync(join(SAMPLES, d, "structure")));

// every string a structure-only run may contain, by key; anything else is free text and fails
const ALLOWED: Record<string, RegExp> = {
  task: /^T\d{3}$/, instance_id: /^T\d{3}$/,
  outcome: /^(resolved|wrong-submit|no-patch|step-cap|wall-clock|error)$/,
  stop: /^(finished|call_limit|turn_limit|time_limit|context_limit|error|finished_or_unknown)$/,
  source: /^(system|user|agent|other)$/, kind: /^(system|task|thinking|final|nudge|tool_call|other)$/,
  tool: /^(read_file|edit_file|run_command|submit_patch|skill:(survey|check|edit|other)|other)$/,
  // malfunction kinds, nested under "malfunctions"
  "malfunctions.kind": /^(edit-revert-oscillation|recurring-error|oversized-result|unverified-submission)$/,
  model: /^gemma-4-31b-it-qat-w4a16-ct$/, draw: /^D\d{3}$/, group: /^[FV]\d{2}$/, slate: /^\d+$/,
  sample: /^[a-z0-9 ,]{1,40}$/, text: /^withheld$/,
};

function walk(v: unknown, key: string, fail: (msg: string) => void): void {
  if (typeof v === "string") {
    const rule = ALLOWED[key] ?? ALLOWED[key.split(".").pop()!];
    if (!rule) return fail(`unexpected string field "${key}" = ${JSON.stringify(v.slice(0, 60))}`);
    if (!rule.test(v)) fail(`"${key}" = ${JSON.stringify(v.slice(0, 60))} is outside the allowed vocabulary`);
    if (v.length > 40 || v.includes("/") || /v1\d\d/i.test(v)) fail(`"${key}" looks like free text: ${JSON.stringify(v.slice(0, 60))}`);
  } else if (Array.isArray(v)) v.forEach((x) => walk(x, key, fail));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, key === "malfunctions" ? `malfunctions.${k}` : k, fail);
}

test("there is at least one structure-only sample run", () => {
  expect(runs.length).toBeGreaterThan(0);
});

for (const run of runs) {
  test(`${run}: every file holds structure only (no free text, paths or version labels)`, () => {
    const problems: string[] = [];
    const files = [
      ...readdirSync(join(SAMPLES, run, "structure")).map((f) => join("structure", f)),
      "stack.json",
    ];
    for (const f of files) walk(JSON.parse(readFileSync(join(SAMPLES, run, f), "utf8")), "", (m) => problems.push(`${f}: ${m}`));
    for (const l of readFileSync(join(SAMPLES, run, "task_results.jsonl"), "utf8").trim().split("\n")) walk(JSON.parse(l), "", (m) => problems.push(`task_results.jsonl: ${m}`));
    expect(problems).toEqual([]);
  });

  test(`${run}: every task row has a structure file, and the reader returns its steps`, () => {
    const ids = readFileSync(join(SAMPLES, run, "task_results.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).instance_id);
    expect(structureTasks(join(SAMPLES, run))).toEqual([...ids].sort());
    for (const t of ids) expect(structureOf(join(SAMPLES, run), t)!.steps.length).toBeGreaterThan(2);
  });
}

test("structureOf re-types fields: crafted text never reaches the page", () => {
  const dir = mkdtempSync(join(tmpdir(), "structure-"));
  mkdirSync(join(dir, "structure"));
  writeFileSync(join(dir, "structure", "T001.json"), JSON.stringify({
    outcome: "x".repeat(500), wallS: "12", secret: "a prompt", firstEdit: { step: 3, atS: 1.5, why: "text" },
    malfunctions: [{ kind: "recurring-error", steps: [1, "2", 3], why: "an observation" }],
    steps: [{ step: 1, source: "agent", tool: "read_file", message: "the system prompt", args: { path: "/x" }, atS: 1, repeated: "yes" }],
  }));
  const s = structureOf(dir, "T001")!;
  const text = JSON.stringify(s);
  expect(text).not.toContain("a prompt");
  expect(text).not.toContain("the system prompt");
  expect(text).not.toContain("an observation");
  expect(text).not.toContain("/x");
  expect(s.outcome!.length).toBe(40);
  expect(s.wallS).toBeNull();
  expect(s.malfunctions[0]!.steps).toEqual([1, 3]);
  expect(s.steps[0]!.repeated).toBe(false);
  expect(structureOf(dir, "../T001")).toBeNull();
});
