import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { fillManifest } from "../capture/test-fixture";

const snap = (seq: number, response: any = { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "edit", arguments: `{"s":${seq}}` } }] } }] }) =>
  ({ seq, status: 200, request: { messages: [{ role: "user", content: "go" }], tools: [] }, response });

function fixture(groupB: any[]): string {
  const d = mkdtempSync(join(tmpdir(), "slip-logprobs-"));
  mkdirSync(join(d, "c1", "capture"), { recursive: true });
  const gz = (snaps: any[]) => gzipSync(snaps.map((s) => JSON.stringify(s)).join("\n"));
  writeFileSync(join(d, "c1", "capture", "task-gA.jsonl.gz"), gz([snap(10)]));
  writeFileSync(join(d, "c1", "capture", "task-gB.jsonl.gz"), gz(groupB));
  writeFileSync(join(d, "c1", "capture", "manifest.json"), JSON.stringify({ gA: {}, gB: {} })); fillManifest(join(d, "c1", "capture"));
  writeFileSync(join(d, "states.jsonl"), [
    { corpus: "c1", run: "r1", group: "gA", seq: 10, flagged: true, fingerprint: "a", outcome: "fail" },
    { corpus: "c1", run: "r1", group: "gB", seq: 11, flagged: false, fingerprint: "b", outcome: "fail", ambiguous: true },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  return d;
}

async function run(d: string, base: string) {
  const p = Bun.spawn(["bun", join(import.meta.dir, "slip-logprobs.ts"), "--states-file", join(d, "states.jsonl"), "--capture-root", d,
    "--pattern", "s", "--alt-token", "x", "--n", "1", "--pool", "1", "--base", base, "--out", join(d, "out", "r.jsonl")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

test("slip-logprobs: a broken exchange in another capture group of the same run rejects the run before any call", async () => {
  // the onset's own group gA is valid; the run's other group gB holds an exchange with no assistant answer
  const d = fixture([snap(11, { choices: [] })]);
  let calls = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { calls++; return Response.json({ choices: [{ message: { role: "assistant", content: "s" }, logprobs: { content: [{ token: "s", logprob: 0, top_logprobs: [] }] } }] }); } });
  try {
    const r = await run(d, `http://127.0.0.1:${server.port}`);
    expect(r.code).toBe(1);
    expect(r.err).toContain("c1/gB");
    expect(r.err).toContain("cannot be replayed");
    expect(calls).toBe(0);
    expect(existsSync(join(d, "out", "r.jsonl"))).toBe(false);
  } finally { server.stop(true); }
});

test("slip-logprobs: groups valid on their own but overlapping in seq are refused as one trajectory", async () => {
  const d = fixture([snap(10)]); // gB repeats the onset's seq 10
  let calls = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { calls++; return Response.json({}); } });
  try {
    const r = await run(d, `http://127.0.0.1:${server.port}`);
    expect(r.code).toBe(1);
    expect(r.err).toContain("run c1/r1");
    expect(calls).toBe(0);
  } finally { server.stop(true); }
});

test("slip-logprobs: a run whose every group is valid is measured", async () => {
  const d = fixture([snap(11)]);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "s" }, logprobs: { content: [{ token: "s", logprob: 0, top_logprobs: [{ token: "x", logprob: Math.log(0.25) }] }] } }] }) });
  try {
    const r = await run(d, `http://127.0.0.1:${server.port}`);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const recs = readFileSync(join(d, "out", "r.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(recs).toHaveLength(1);
    expect(recs[0].pAlt).toBeCloseTo(0.25, 10);
  } finally { server.stop(true); }
});

test("slip-logprobs: a states index whose run is a number (not a string) is refused before any call", async () => {
  const d = fixture([snap(11)]);
  writeFileSync(join(d, "states.jsonl"), [
    { corpus: "c1", run: "1", group: "gA", seq: 10, flagged: true, fingerprint: "a", outcome: "fail" },
    { corpus: "c1", run: 1, group: "gB", seq: 11, flagged: false, fingerprint: "b", outcome: "fail" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = await run(d, "http://127.0.0.1:9");
  expect(r.code).toBe(1);
  expect(r.err).toMatch(/line 2: "run" must be a non-empty string, got 1/);
});

test("slip-logprobs: a response without usable logprobs is an error (exit 1), never a no-match", async () => {
  for (const extra of [{}, { logprobs: { content: [] } }, { logprobs: { content: [{ token: "s", logprob: "x", top_logprobs: [] }] } }, { logprobs: { content: [{ token: "s", logprob: 0 }] } }]) {
    const d = fixture([snap(11)]);
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "s" }, ...extra }] }) });
    try {
      const r = await run(d, `http://127.0.0.1:${server.port}`);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/unusable logprobs/);
      expect(r.out).toMatch(/no match 0, errors 1/);
    } finally { server.stop(true); }
  }
});

test("logprobProblems: a well-formed content array is usable", async () => {
  const { logprobProblems } = await import("./capture-valid");
  const ok = { choices: [{ logprobs: { content: [{ token: "a", logprob: -0.1, top_logprobs: [{ token: "b", logprob: -2 }] }] } }] };
  expect(logprobProblems(ok)).toEqual([]);
  expect(logprobProblems({ choices: [{}] })[0]).toMatch(/logprobs: true/);
  expect(logprobProblems({ choices: [{ logprobs: { content: [{ token: "a", logprob: 0.5, top_logprobs: [] }] } }] })[0]).toMatch(/finite number <= 0/);
  expect(logprobProblems({ choices: [{ logprobs: { content: [{ token: "a", logprob: -1, top_logprobs: [{ token: 1, logprob: -1 }] }] } }] })[0]).toMatch(/top_logprobs\[0\]/);
});
