import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readability } from "../src/integrity/score-gate";

const ROOT = join(import.meta.dir, "..");
const go = (...a: string[]) => Bun.spawnSync(["bun", ...a], { cwd: ROOT });

// the real order: close the run on the submitted bytes alone; the platform's score arrives later, from outside
function closedRun() {
  const d = mkdtempSync(join(tmpdir(), "continuous-"));
  mkdirSync(join(d, "artifacts"));
  writeFileSync(join(d, "artifacts", "submission.csv"), "id,y\n1,0.5\n");
  writeFileSync(join(d, "stack.json"), JSON.stringify({ model: "m" }));
  expect(go("src/integrity/run-end.ts", d, "--artifact-only", "--no-capture", "--check", "artifacts=ok", "--check", "stack=ok").exitCode).toBe(0);
  return d;
}

test("a run closed before its score exists is gated, sealed, then the external score printed", () => {
  const d = closedRun();
  const before = readdirSync(join(d, "artifacts")).sort();
  const p = go("examples/read-platform-score.ts", d, "--score", "0.8312");
  expect(p.exitCode).toBe(0);
  expect(p.stdout.toString()).toContain("score = 0.8312");
  expect(existsSync(join(d, "score-read.json"))).toBe(true);
  // nothing was added to the sealed artifacts, so the run is still readable after the score arrived
  expect(readdirSync(join(d, "artifacts")).sort()).toEqual(before);
  expect(readability(d).ok).toBe(true);
});

test("a score file outside the run is read (JSON field or a bare number); one inside the run is refused", () => {
  const out = mkdtempSync(join(tmpdir(), "platform-score-"));
  writeFileSync(join(out, "lb.json"), JSON.stringify({ public: 0.71 }));
  writeFileSync(join(out, "lb.txt"), "0.64\n");
  const d1 = closedRun();
  const j = go("examples/read-platform-score.ts", d1, "--score-file", join(out, "lb.json"), "--field", "public");
  expect(j.exitCode).toBe(0);
  expect(j.stdout.toString()).toContain("score = 0.71");
  const d2 = closedRun();
  expect(go("examples/read-platform-score.ts", d2, "--score-file", join(out, "lb.txt")).stdout.toString()).toContain("score = 0.64");
  const d3 = closedRun();
  writeFileSync(join(d3, "score.json"), JSON.stringify({ score: 0.9 }));
  const inside = go("examples/read-platform-score.ts", d3, "--score-file", join(d3, "score.json"));
  expect(inside.exitCode).toBe(1);
  expect(inside.stdout.toString()).toContain("inside the run directory");
  expect(existsSync(join(d3, "score-read.json"))).toBe(false);
});

test("an edited artifact after run end is refused, and a non-numeric or missing score seals nothing", () => {
  const d = closedRun();
  writeFileSync(join(d, "artifacts", "submission.csv"), "id,y\n1,0.9\n");
  const p = go("examples/read-platform-score.ts", d, "--score", "0.5");
  expect(p.exitCode).toBe(1);
  expect(p.stdout.toString()).toContain("raw artifacts changed");
  const e = closedRun();
  for (const args of [["--score", "high"], ["--score", "Infinity"], ["--score", ""], []]) expect(go("examples/read-platform-score.ts", e, ...args).exitCode).not.toBe(0);
  expect(go("examples/read-platform-score.ts", e, "--score", "1", "--score-file", "/dev/null").exitCode).toBe(1);
  expect(existsSync(join(d, "score-read.json"))).toBe(false);
  expect(existsSync(join(e, "score-read.json"))).toBe(false);
});

test("the seal binds the score: the same score reads again, a different score for the sealed run is refused", () => {
  const d = closedRun();
  expect(go("examples/read-platform-score.ts", d, "--score", "0.8312").exitCode).toBe(0);
  const seal = JSON.parse(require("node:fs").readFileSync(join(d, "score-read.json"), "utf8"));
  expect(seal.read).toEqual({ score: 0.8312, source: "--score" });
  const again = go("examples/read-platform-score.ts", d, "--score", "0.8312");
  expect(again.exitCode).toBe(0);
  expect(again.stdout.toString()).toContain("already sealed");
  const other = go("examples/read-platform-score.ts", d, "--score", "0.9");
  expect(other.exitCode).toBe(1);
  expect(other.stdout.toString()).toContain("REFUSED");
  expect(other.stdout.toString()).not.toContain("score = 0.9");
});

test("a --score-file seal records the field and the file's sha256", () => {
  const out = mkdtempSync(join(tmpdir(), "platform-score-"));
  writeFileSync(join(out, "lb.json"), JSON.stringify({ public: 0.71 }));
  const d = closedRun();
  expect(go("examples/read-platform-score.ts", d, "--score-file", join(out, "lb.json"), "--field", "public").exitCode).toBe(0);
  const seal = JSON.parse(require("node:fs").readFileSync(join(d, "score-read.json"), "utf8"));
  expect(seal.read.field).toBe("public");
  expect(seal.read.sha256).toMatch(/^[0-9a-f]{64}$/);
});

test("a sealed --score-file read refuses a different file carrying the same score, and a switch to --score", () => {
  const out = mkdtempSync(join(tmpdir(), "platform-score-"));
  writeFileSync(join(out, "lb.json"), JSON.stringify({ public: 0.71 }));
  writeFileSync(join(out, "other.json"), JSON.stringify({ public: 0.71, note: "a different file" }));
  const d = closedRun();
  expect(go("examples/read-platform-score.ts", d, "--score-file", join(out, "lb.json"), "--field", "public").exitCode).toBe(0);
  expect(go("examples/read-platform-score.ts", d, "--score-file", join(out, "lb.json"), "--field", "public").exitCode).toBe(0);
  const swapped = go("examples/read-platform-score.ts", d, "--score-file", join(out, "other.json"), "--field", "public");
  expect(swapped.exitCode).toBe(1);
  expect(swapped.stdout.toString()).toContain("REFUSED");
  const direct = go("examples/read-platform-score.ts", d, "--score", "0.71");
  expect(direct.exitCode).toBe(1);
  expect(direct.stdout.toString()).toContain("REFUSED");
});

test("a run with task rows (not closed --artifact-only) is refused before anything is read or sealed", () => {
  const d = mkdtempSync(join(tmpdir(), "platform-rows-"));
  writeFileSync(join(d, "task_results.jsonl"), `{"instance_id":"t1","resolved":true}\n`);
  writeFileSync(join(d, "stack.json"), JSON.stringify({ model: "m" }));
  expect(go("src/integrity/run-end.ts", d, "--check", "rows=ok", "--check", "stack=ok", "--no-capture").exitCode).toBe(0);
  const p = go("examples/read-platform-score.ts", d, "--score", "0.5");
  expect(p.exitCode).toBe(1);
  expect(p.stdout.toString()).toContain("not closed as an artifact-only run");
  expect(existsSync(join(d, "score-read.json"))).toBe(false);
  // the proper reader can still read it
  expect(go("src/integrity/score-reader.ts", d).exitCode).toBe(0);
});

test("the earlier name read-continuous-score.ts is the same reader; a run locked by another reader is refused", () => {
  const d = closedRun();
  writeFileSync(join(d, "score-read.lock"), "{}\n");
  const locked = go("examples/read-continuous-score.ts", d, "--score", "0.5");
  expect(locked.exitCode).toBe(1);
  expect(locked.stdout.toString()).toContain("being read by another reader");
  expect(existsSync(join(d, "score-read.json"))).toBe(false);
  rmSync(join(d, "score-read.lock"));
  const ok = go("examples/read-continuous-score.ts", d, "--score", "0.5");
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout.toString()).toContain("score = 0.5");
  expect(existsSync(join(d, "score-read.lock"))).toBe(false);
  expect(go("examples/read-platform-score.ts", d, "--score", "0.5").exitCode).toBe(0);
});

test("named observations: public and private are sealed separately, each once; a changed score under a name is refused", () => {
  const d = closedRun();
  const fs = require("node:fs");
  // a public seal written before observations existed (no observation key) still counts as the public observation
  expect(go("examples/read-platform-score.ts", d, "--score", "0.8312").exitCode).toBe(0);
  expect(go("examples/read-platform-score.ts", d, "--score", "0.8312", "--observation", "public").stdout.toString()).toContain("already sealed");
  const priv = go("examples/read-platform-score.ts", d, "--score", "0.79", "--observation", "private");
  expect(priv.exitCode).toBe(0);
  expect(priv.stdout.toString()).toContain("score (private) = 0.79");
  expect(JSON.parse(fs.readFileSync(join(d, "score-read.obs-private.json"), "utf8")).read).toEqual({ score: 0.79, source: "--score", observation: "private" });
  expect(go("examples/read-platform-score.ts", d, "--score", "0.79", "--observation", "private").stdout.toString()).toContain("already sealed");
  const changed = go("examples/read-platform-score.ts", d, "--score", "0.81", "--observation", "private");
  expect(changed.exitCode).toBe(1);
  expect(changed.stdout.toString()).toContain("REFUSED");
  // the public observation is untouched by the private one
  expect(JSON.parse(fs.readFileSync(join(d, "score-read.json"), "utf8")).read).toEqual({ score: 0.8312, source: "--score" });
  for (const bad of ["Private", "a/b", "", "x".repeat(33)]) expect(go("examples/read-platform-score.ts", d, "--score", "0.79", "--observation", bad).exitCode).toBe(2);
});

test("a named observation alone already counts as a read score: repairs are refused", async () => {
  const d = closedRun();
  expect(go("examples/read-platform-score.ts", d, "--score", "0.7", "--observation", "private").exitCode).toBe(0);
  expect(existsSync(join(d, "score-read.json"))).toBe(false);
  const { scoreWasRead } = await import("../src/integrity/score-gate");
  expect(scoreWasRead(d)).toBe(true);
});
