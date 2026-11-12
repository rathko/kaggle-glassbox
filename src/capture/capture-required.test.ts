import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUARD = join(import.meta.dir, "capture-required.ts");

test("importing capture-required exits non-zero and explains why", async () => {
  const p = Bun.spawn(["bun", "-e", `import "${GUARD}"`], { stderr: "pipe" });
  const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  expect(code).toBe(2);
  expect(stderr).toContain("REFUSED");
  expect(stderr).toContain("capture");
});

// Simulates the real convention with throwaway fixture runners, so the test does not depend on
// any production harness's actual filenames: a "non-capturing" runner that imports the guard
// must refuse before doing any work, and a "capturing" runner that does not import the guard
// must run normally.
test("a runner that imports the guard refuses before doing any work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-required-"));
  try {
    const runner = join(dir, "non-capturing-runner.ts");
    writeFileSync(
      runner,
      `import "${GUARD}";\nconsole.log("SHOULD_NEVER_PRINT");\n`
    );
    const p = Bun.spawn(["bun", runner], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    expect(code).toBe(2);
    expect(stdout).not.toContain("SHOULD_NEVER_PRINT");
    expect(stderr).toContain("REFUSED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the designated capturing runner (no guard import) is unaffected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-required-"));
  try {
    const runner = join(dir, "capturing-runner.ts");
    // Stands in for a real runner that spawns wire-tap.ts with --capture-full. It deliberately
    // does NOT import capture-required.
    writeFileSync(runner, `console.log("would spawn wire-tap.ts --capture-full here");\n`);
    const p = Bun.spawn(["bun", runner], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout] = await Promise.all([p.exited, new Response(p.stdout).text()]);
    expect(code).toBe(0);
    expect(stdout).toContain("--capture-full");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("convention check: every source file that is not the capturing runner must import the guard", async () => {
  // A minimal static check you can run over your own harness's runner directory: every file
  // matching a "runner" naming convention either imports the guard, or is explicitly named as
  // the one capturing runner.
  const dir = mkdtempSync(join(tmpdir(), "capture-required-"));
  try {
    const CAPTURING_RUNNER = "run-with-capture.ts";
    writeFileSync(join(dir, CAPTURING_RUNNER), `// spawns wire-tap.ts --capture-full, no opt-out\n`);
    writeFileSync(join(dir, "run-a.ts"), `import "../capture/capture-required";\n`);
    writeFileSync(join(dir, "run-b.ts"), `import "../capture/capture-required";\n`);

    const { readdirSync, readFileSync } = await import("node:fs");
    const violations = readdirSync(dir)
      .filter((f) => f.startsWith("run-") && f.endsWith(".ts") && f !== CAPTURING_RUNNER)
      .filter((f) => !readFileSync(join(dir, f), "utf8").includes("capture-required"));
    expect(violations).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
