import { expect, test } from "bun:test";
import { join } from "node:path";

// The live check spends real decode time, so the suite only checks that it loads and parses; run it by hand
// against a server (bash examples/live-e2e/run.sh).
test("the live e2e agent loads without running and defines checkable tasks", async () => {
  const { TASKS } = await import("./agent");
  expect(TASKS.length).toBe(4);
  expect(new Set(TASKS.map((t) => t.id)).size).toBe(4);
  for (const t of TASKS) expect(t.a).toMatch(/^\d+$/);
});

test("the live e2e script is valid bash", () => {
  const r = Bun.spawnSync(["bash", "-n", join(import.meta.dir, "run.sh")]);
  expect(r.stderr.toString()).toBe("");
  expect(r.exitCode).toBe(0);
});

test("the agent refuses to run without its arguments", () => {
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "agent.ts")], { env: { ...process.env, MODEL: "" } });
  expect(r.exitCode).toBe(2);
});
