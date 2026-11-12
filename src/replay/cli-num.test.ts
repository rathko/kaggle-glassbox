import { test, expect } from "bun:test";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..");
// each tool must refuse a bad count with exit 2 before it reads inputs or creates any output
const cases: [string, string[]][] = [
  ["replay/replay-states.ts", ["--pool", "0"]], ["replay/replay-states.ts", ["--n", "1.5"]], ["replay/replay-states.ts", ["--entry", "-1"]],
  ["replay/slip-logprobs.ts", ["--pool", "0"]], ["replay/slip-logprobs.ts", ["--n", "-2"]],
  ["analysis/frontier-analyse.ts", [require("node:os").tmpdir(), "--base-url", "http://127.0.0.1:9/v1", "--model", "m", "--concurrency", "0"]],
  ["analysis/frontier-analyse.ts", [require("node:os").tmpdir(), "--base-url", "http://127.0.0.1:9/v1", "--model", "m", "--poll", "x"]],
];

for (const [tool, args] of cases) test(`${tool} ${args.slice(-2).join(" ")} is a usage error`, () => {
  const p = Bun.spawnSync(["bun", join(SRC, tool), ...args]);
  expect(p.exitCode).toBe(2);
  expect(p.stderr.toString()).toMatch(/must be a whole number >= \d/);
});
