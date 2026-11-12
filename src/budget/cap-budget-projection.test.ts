import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "cap-budget-projection.ts");

test("projects mean truncated duration x n-tasks, not cap x n-tasks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cap-budget-"));
  try {
    const rows = [
      { instance_id: "a", resolved: true, duration_seconds: 100 },
      { instance_id: "b", resolved: true, duration_seconds: 500 }, // will be clipped at cap=240
      { instance_id: "c", resolved: false, duration_seconds: 240 },
      { instance_id: "d", resolved: false, duration_seconds: 240 },
    ];
    const f = join(dir, "task_results.jsonl");
    writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const p = Bun.spawn(
      ["bun", SCRIPT, f, "--n-tasks", "4", "--limit-hours", "12", "--setup-reserve-hours", "1", "--measured-good-hours", "1", "--caps", "240"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect(code).toBe(0);
    // mean of [100, 240, 240, 240] (500 clipped to 240) = 205s; proj = 205*4/3600 = 0.2277...h
    expect(stdout).toContain("205s");
    expect(stdout).toContain("0.23h");
    // solved durations are [100, 500]; only 100 <= 240, so 1/2 captured
    expect(stdout).toMatch(/1\/2 of source's solves/);
    expect(stderr).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses without required flags", async () => {
  const p = Bun.spawn(["bun", SCRIPT, "/dev/null"], { stdout: "pipe", stderr: "pipe" });
  const code = await p.exited;
  expect(code).toBe(2);
});

test("--n-tasks must be a positive safe whole number (usage error, exit 2)", () => {
  const d = mkdtempSync(join(tmpdir(), "cap-ntasks-"));
  try {
    writeFileSync(join(d, "r.jsonl"), JSON.stringify({ resolved: true, duration_seconds: 100 }) + "\n");
    for (const bad of ["-3", "1.5", "Infinity", "0", "1e20"])
      expect(Bun.spawnSync(["bun", SCRIPT, join(d, "r.jsonl"), "--n-tasks", bad, "--limit-hours", "12"]).exitCode).toBe(2);
    expect(Bun.spawnSync(["bun", SCRIPT, join(d, "r.jsonl"), "--n-tasks", "10", "--limit-hours", "12"]).exitCode).toBe(0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
