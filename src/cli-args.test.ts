import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argProblems } from "./cli-args";

const SPEC = { valued: ["out", "n", "cmd"], bool: ["fast"], repeatable: ["cmd"], positionals: [1, 2] as [number, number] };

test("a valid command line has no problems", () => {
  expect(argProblems(["run", "--out", "o", "--fast", "--n", "-3", "--cmd", "a", "--cmd", "b"], SPEC)).toEqual([]);
});

test("unknown, duplicate and valueless flags are each named", () => {
  expect(argProblems(["run", "--sytem-file", "x"], SPEC)).toContain("unknown option --sytem-file");
  expect(argProblems(["run", "--out", "a", "--out", "b"], SPEC)).toContain("--out given twice");
  expect(argProblems(["run", "--fast", "--fast"], SPEC)).toContain("--fast given twice");
  expect(argProblems(["run", "--out"], SPEC)).toContain("--out needs a value");
  expect(argProblems(["run", "--out", "--fast"], SPEC)).toContain("--out needs a value");
});

test("positional counts are enforced; a flag value is not a positional", () => {
  expect(argProblems(["--out", "o"], SPEC)).toEqual(["expected 1-2 positional argument(s), got 0"]);
  expect(argProblems(["a", "b", "c"], SPEC)).toEqual(["expected 1-2 positional argument(s), got 3"]);
  expect(argProblems(["stray"], { valued: ["out"] })).toEqual(["expected 0 positional argument(s), got 1"]);
  expect(argProblems(["a", "b", "c"], { positionals: [1, Infinity] })).toEqual([]);
});

test("a misspelt step-replay flag exits 2 before any output exists", () => {
  const d = mkdtempSync(join(tmpdir(), "cli-args-"));
  writeFileSync(join(d, "sys.md"), "x");
  const out = join(d, "sub", "out.jsonl");
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "replay", "step-replay.ts"), "--sytem-file", join(d, "sys.md"), "--dir", d, "--out", out]);
  expect(p.exitCode).toBe(2);
  expect(p.stderr.toString()).toContain("unknown option --sytem-file");
  expect(p.stdout.toString()).toBe("");
  expect(existsSync(join(d, "sub"))).toBe(false);
});
