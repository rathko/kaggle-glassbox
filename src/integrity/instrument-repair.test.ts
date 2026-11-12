import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordRunEnd, readability } from "./score-gate";

const CLI = join(import.meta.dir, "instrument-repair.ts");

// A run whose capture check failed at run end; the "tool" sets capture ok in instruments.json, the "guard"
// exits with the given code.
function setup(guardRc: number, toolSetsOk = true) {
  const d = mkdtempSync(join(tmpdir(), "repair-"));
  writeFileSync(join(d, "task_results.jsonl"), `{"instance_id":"a","resolved":true}\n`);
  const checks = { rows: { ok: true, detail: "" }, stack: { ok: true, detail: "" }, capture: { ok: false, detail: "unattributed" } };
  writeFileSync(join(d, "instruments.json"), JSON.stringify({ checks }));
  recordRunEnd(d, checks);
  const tool = join(d, "tool.ts"), guard = join(d, "guard.ts");
  writeFileSync(tool, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(d, "instruments.json"))}, JSON.stringify({ checks: { rows: { ok: true }, stack: { ok: true }, capture: { ok: ${toolSetsOk}, detail: "re-attributed" } } }));`);
  writeFileSync(guard, `process.exit(${guardRc});`);
  const p = Bun.spawnSync(["bun", CLI, d, "capture", "--tool-cmd", `capture=bun,${tool}`, "--guard-cmd", `bun,${guard}`]);
  const repairs = JSON.parse(readFileSync(join(d, "instruments.repairs.json"), "utf8"));
  return { d, p, repairs };
}

test("a failing guard means no repair: recorded as failed, exit 1, run still unreadable", () => {
  const { d, p, repairs } = setup(1);
  try {
    expect(p.exitCode).toBe(1);
    expect(p.stdout.toString()).toContain("NOT REPAIRED");
    expect(p.stdout.toString()).toContain("guard rc=1");
    expect(repairs.at(-1).ok).toBe(false);
    expect(readability(d).ok).toBe(false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("tool 0, guard 0 and the check now ok: recorded as a valid repair, exit 0, run readable", () => {
  const { d, p, repairs } = setup(0);
  try {
    expect(p.exitCode).toBe(0);
    expect(repairs.at(-1).ok).toBe(true);
    expect(readability(d).ok).toBe(true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a guard that passes while the check is still failing is not a repair", () => {
  const { d, p, repairs } = setup(0, false);
  try {
    expect(p.exitCode).toBe(1);
    expect(repairs.at(-1).ok).toBe(false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
