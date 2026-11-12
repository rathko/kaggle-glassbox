import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fillManifest } from "../capture/test-fixture";

// A mocked OpenAI-compatible endpoint: no network beyond loopback, no real task data.
const requests: any[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body: any = await req.json();
    requests.push(body);
    const sys = body.messages[0].content as string;
    const content = sys.includes("failure analyst")
      ? "## Taxonomy\n\n| Mechanism | Count | Task IDs | Definition |\n|---|---|---|---|\n| Budget exhaustion | 1 | task_1 | ran out |\n\n## Ranked levers\n1. cap reads\n\n## What is NOT fixable at the agent level\nnone"
      : sys.includes("VS-REFERENCE")
        ? "VERDICT: no\nTIMELINE: t\nWASTE: w\nCONTEXT: c\nVS-REFERENCE: r\nFIX-IDEAS: f"
        : "VERDICT: no\nTIMELINE: t\nWASTE: w\nCONTEXT: c\nFIX-IDEAS: f";
    return Response.json({ choices: [{ message: { role: "assistant", content } }] });
  },
});
afterAll(() => server.stop(true));
const ENV = { ...process.env, FRONTIER_BASE_URL: `http://127.0.0.1:${server.port}/v1`, FRONTIER_MODEL: "mock-model", FRONTIER_API_KEY: "" };
const DIR = import.meta.dir;

function exchange(seq: number, task: string) {
  return {
    seq, status: 200, request: { messages: [{ role: "user", content: `Resolve ${task}: the parser drops trailing commas` }] },
    response: { usage: { prompt_tokens: 100 * seq }, choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: `c${seq}`, type: "function", function: { name: "grep", arguments: "{}" } }] } }] },
  };
}

function makeRun(): string {
  const d = mkdtempSync(join(tmpdir(), "frontier-cli-"));
  const cap = join(d, "capture");
  mkdirSync(cap); mkdirSync(join(d, "patches"));
  const manifest: Record<string, unknown> = {};
  for (const [i, task] of ["task_1", "task_2"].entries()) {
    const key = `k${i}`;
    writeFileSync(join(cap, `task-${key}.jsonl.gz`), Bun.gzipSync(Buffer.from([exchange(1, task), exchange(2, task)].map((e) => JSON.stringify(e)).join("\n") + "\n")));
    manifest[key] = { exchanges: 2, instances: [task] };
  }
  writeFileSync(join(cap, "manifest.json"), JSON.stringify(manifest)); fillManifest(cap);
  writeFileSync(join(d, "task_results.jsonl"), [{ instance_id: "task_1", resolved: false }, { instance_id: "task_2", resolved: true }].map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(d, "patches", "task_1.patch"), "diff --git a/x b/x\n");
  return d;
}

async function run(script: string, args: string[]) {
  const p = Bun.spawn(["bun", join(DIR, script), ...args], { stdout: "pipe", stderr: "pipe", env: ENV });
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, stdout, stderr };
}

test("analyse -> coverage -> synth, end to end, never sending a reference patch by default", async () => {
  const d = makeRun();
  try {
    requests.length = 0;
    const a = await run("frontier-analyse.ts", [d, "--concurrency", "2"]);
    expect(a.code).toBe(0);
    expect(a.stdout).toContain("wrote 2 analyses");
    expect(requests.length).toBe(2);
    expect(requests.every((r) => r.model === "mock-model")).toBe(true);
    const sent = JSON.stringify(requests);
    expect(sent).not.toContain("REFERENCE PATCH");
    expect(sent).toContain("the parser drops trailing commas");
    const md = readFileSync(join(d, "analysis", "task_1.md"), "utf8");
    expect(md).toContain("<!-- reference_patch=none -->");
    expect(md).toContain("<!-- patch_bytes=19 -->");

    // Already-analysed tasks are skipped unless --force.
    requests.length = 0;
    expect((await run("frontier-analyse.ts", [d])).stdout).toContain("0 task(s) need analysis");
    expect(requests.length).toBe(0);

    const c = await run("frontier-coverage.ts", [d]);
    expect(c.code).toBe(0);
    expect(JSON.parse(c.stdout).complete).toBe(true);

    const s = await run("frontier-synth.ts", [d]);
    expect(s.code).toBe(0);
    expect(s.stdout).toContain("tasks 1; analysed 1; no-patch 0; wrong-patch 1");
    const synth = readFileSync(join(d, "frontier-synthesis.md"), "utf8");
    expect(synth).toContain("<!-- frontier-synth v1 -->");
    expect(synth).toContain("## Taxonomy");
    expect(synth).toContain("No reference patches were read");

    const k = await run("frontier-class-size.ts", [d]);
    expect(k.code).toBe(0);
    expect(k.stdout).toContain("budget");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("--reference-patch is opt-in, labelled in the prompt and recorded in the output", async () => {
  const d = makeRun();
  try {
    writeFileSync(join(d, "refs.jsonl"), JSON.stringify({ instance_id: "task_1", patch: "REF-DIFF-MARKER" }) + "\n");
    requests.length = 0;
    const a = await run("frontier-analyse.ts", [d, "--only", "task_1", "--reference-patch", join(d, "refs.jsonl")]);
    expect(a.code).toBe(0);
    expect(requests.length).toBe(1);
    expect(requests[0].messages[1].content).toContain("REFERENCE PATCH (opt-in, user-supplied");
    expect(requests[0].messages[1].content).toContain("REF-DIFF-MARKER");
    expect(readFileSync(join(d, "analysis", "task_1.md"), "utf8")).toContain("<!-- reference_patch=refs.jsonl -->");
    const s = await run("frontier-synth.ts", [d]);
    expect(readFileSync(join(d, "frontier-synthesis.md"), "utf8")).toContain("read user-supplied reference patches");
    expect(s.code).toBe(0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("--watch drains new rows and exits once the run-complete sentinel exists", async () => {
  const d = makeRun();
  try {
    mkdirSync(join(d, "analysis"), { recursive: true });
    writeFileSync(join(d, "analysis", ".run-complete"), "");
    const a = await run("frontier-analyse.ts", [d, "--watch", "--poll", "1"]);
    expect(a.code).toBe(0);
    expect(a.stdout).toContain("run complete and all 2 tasks analysed");
    expect(existsSync(join(d, "analysis", "task_2.md"))).toBe(true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a missing endpoint config refuses loudly instead of writing empty analyses", async () => {
  const d = makeRun();
  try {
    const p = Bun.spawn(["bun", join(DIR, "frontier-analyse.ts"), d], { stdout: "pipe", stderr: "pipe", env: { ...process.env, FRONTIER_BASE_URL: "", FRONTIER_MODEL: "" } });
    const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    expect(code).toBe(2);
    expect(stderr).toContain("FRONTIER_BASE_URL");
    expect(existsSync(join(d, "analysis", "task_1.md"))).toBe(false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a failed model call is reported as a failure and exits non-zero", async () => {
  const d = makeRun();
  try {
    const p = Bun.spawn(["bun", join(DIR, "frontier-analyse.ts"), d, "--base-url", "http://127.0.0.1:1/v1"], { stdout: "pipe", stderr: "pipe", env: ENV });
    const [code, stdout] = await Promise.all([p.exited, new Response(p.stdout).text()]);
    expect(code).toBe(1);
    expect(stdout).toContain("FAIL task_1");
    expect(stdout).toContain("missing, not negative findings");
  } finally { rmSync(d, { recursive: true, force: true }); }
});
