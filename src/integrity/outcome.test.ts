import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { binaryOutcome } from "./outcome";

test("binaryOutcome: true/1 solved, false/0 not, anything else is no outcome", () => {
  expect([true, 1, false, 0].map(binaryOutcome)).toEqual([true, true, false, false]);
  for (const v of ["true", "1", 2, -0.5, null, undefined, NaN, {}]) expect(binaryOutcome(v)).toBeUndefined();
});

test("frontier counts a numeric resolved: 1 as solved, the same as the sealed reader", () => {
  const { loadDraw } = require("../analysis/frontier");
  const d = mkdtempSync(join(tmpdir(), "outcome-"));
  try {
    writeFileSync(join(d, "task_results.jsonl"), '{"instance_id":"a","resolved":1}\n{"instance_id":"b","resolved":0}\n');
    writeFileSync(join(d, "frontier-synthesis.md"), "");
    expect(loadDraw(d).res).toEqual({ a: true, b: false });
  } finally { rmSync(d, { recursive: true, force: true }); }
});
