import { test, expect } from "bun:test";
import { join } from "node:path";

test("the demo runs the whole loop with no data, GPU or key, and each step shows its effect", async () => {
  const p = Bun.spawn(["bun", join(import.meta.dir, "demo.ts")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(err).toBe("");
  expect(code).toBe(0);
  expect(out).toContain("captured 9 exchanges for 3 tasks");
  expect((out.match(/read_file -> run_tests {2}\*CHANGED\*/g) ?? []).length).toBe(3);
  for (const t of ["task-1", "task-2", "task-3"]) expect(out).toContain(`${t}: 3 exchanges`);
  expect(out).toContain("2/3 resolved");
  expect(out).toContain("sealed: yes");
  expect(out).toContain("false-pass 14.5%");
}, 60_000);

test("the demo stops its wire-tap child in finally and waits for it before deleting the work dir (round 15)", () => {
  // a source check: a failure path would need a fault hook in the example itself
  const src = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "demo.ts"), "utf8") as string;
  const fin = src.slice(src.lastIndexOf("} finally {"));
  expect(src.indexOf("let tap")).toBeLessThan(src.indexOf("try {"));
  expect(fin).toMatch(/tap\.kill\(\);\s*await tap\.exited;/);
  expect(fin.indexOf("tap.kill()")).toBeLessThan(fin.indexOf("rmSync(work"));
});

// a wire-tap that could not drain exits 1; the demo must stop there, not close a run whose capture is short
test("the demo checks wire-tap's exit status before it writes rows or compacts", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "demo.ts"), "utf8");
  const check = src.indexOf("if (tapCode !== 0) throw");
  expect(check).toBeGreaterThan(0);
  expect(check).toBeLessThan(src.indexOf("task_results.jsonl"));
  expect(check).toBeLessThan(src.indexOf("capture-compact.ts"));
});
