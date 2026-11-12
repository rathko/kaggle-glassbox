import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "step-replay.ts");
const snap = (seq: number, content: string, extra: any = {}) => ({ seq, status: 200, request: { model: "m", messages: [{ role: "system", content: "s" }, { role: "user", content: "q" }] }, response: { choices: [{ message: { role: "assistant", content } }], ...extra } });

async function run(snaps: any[], answer: string, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "step-replay-"));
  snaps.forEach((s) => writeFileSync(join(dir, `${String(s.seq).padStart(6, "0")}.json`), JSON.stringify(s)));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ choices: [{ message: { role: "assistant", content: answer } }] }) });
  const out = join(dir, "out.jsonl");
  const p = Bun.spawn(["bun", SCRIPT, "--dir", dir, "--out", out, "--base", `http://127.0.0.1:${server.port}`, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  server.stop(true);
  let recs: any[] = [];
  try { recs = readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  rmSync(dir, { recursive: true, force: true });
  return { code, stdout, stderr, recs };
}

test("a text-only answer that changes is reported as changed (auto compares content when no tool call is made)", async () => {
  const r = await run([snap(1, "The answer is 4.")], "The answer is 5.");
  expect(r.code).toBe(0);
  expect(r.recs[0].changed).toBe(true);
  expect(r.stdout).toContain("*CHANGED*");
  const same = await run([snap(1, "The answer is 4.")], "  The answer   is 4. ");
  expect(same.recs[0].changed).toBe(false);
  const toolMode = await run([snap(1, "The answer is 4.")], "The answer is 5.", ["--compare", "tool"]);
  expect(toolMode.recs[0].changed).toBe(false);
});

test("a selected snapshot marked as an invalid stream is refused before any call", async () => {
  const r = await run([snap(1, "ok"), snap(2, "par", { stream_invalid: true })], "x");
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("seq 2: invalid stream");
  expect(r.recs.length).toBe(0);
});

test("a --seq that dodges a broken exchange still refuses: the whole trajectory is validated before selection", async () => {
  const r = await run([snap(1, "ok"), snap(2, "par", { stream_invalid: true })], "x", ["--seq", "1"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("seq 2: invalid stream");
  expect(r.recs.length).toBe(0);
});

test("an exchange with no request messages is refused, not silently dropped", async () => {
  const r = await run([snap(1, "ok"), { seq: 2, status: 200, request: { model: "m" }, response: { choices: [{ message: { role: "assistant", content: "x" } }] } }], "x");
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("no request messages");
});

test("count flags must be positive whole numbers, checked before any output is created", async () => {
  for (const bad of [["--repeat", "0"], ["--repeat", "1.5"], ["--limit", "-1"], ["--repeat", "x"]]) {
    const r = await run([snap(1, "ok")], "x", bad);
    expect(r.code).toBe(2);
    expect(r.recs.length).toBe(0);
  }
});

test("--system-file on a trajectory with no system message inserts one at the front instead of silently doing nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "step-replay-sys-"));
  writeFileSync(join(dir, "000001.json"), JSON.stringify({ seq: 1, status: 200, request: { model: "m", messages: [{ role: "user", content: "2+2?" }] }, response: { choices: [{ message: { role: "assistant", content: "4" } }] } }));
  writeFileSync(join(dir, "cand.md"), "Answer in words.");
  let seen: any[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { seen = ((await req.json()) as any).messages; return Response.json({ choices: [{ message: { role: "assistant", content: "four" } }] }); } });
  try {
    const out = join(dir, "out.jsonl");
    const p = Bun.spawn(["bun", SCRIPT, "--dir", dir, "--out", out, "--base", `http://127.0.0.1:${server.port}`, "--system-file", join(dir, "cand.md")], { stdout: "pipe", stderr: "pipe" });
    const [stdout, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code).toBe(0);
    expect(seen[0]).toEqual({ role: "system", content: "Answer in words." });
    expect(seen[1].role).toBe("user");
    expect(JSON.parse(readFileSync(out, "utf8").trim()).system_inserted).toBe(true);
    expect(stdout).toContain("system message inserted");
  } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("--messages-head must be a whole number >= 1", async () => {
  for (const bad of ["-1", "1.5", "x"]) expect((await run([snap(1, "a")], "a", ["--messages-head", bad])).code).toBe(2);
  expect((await run([snap(1, "a")], "a", ["--messages-head", "1"])).code).toBe(0);
});

test("--seq is parsed strictly: malformed, backwards, zero, repeated or overlapping parts are usage errors", async () => {
  for (const bad of ["", "a", "1,", "5-3", "0", "1.5", "-2", "7,7", "1-5,3", "2-4,4-6", "1--2", "99999999999999999999"]) {
    const r = await run([snap(1, "ok")], "x", ["--seq", bad]);
    expect({ bad, code: r.code }).toEqual({ bad, code: 2 });
    expect(r.recs.length).toBe(0);
  }
  const ok = await run([snap(1, "ok"), snap(2, "ok"), snap(5, "ok")], "ok", ["--seq", " 1 , 4-6 "]);
  expect(ok.code).toBe(0);
  expect(ok.recs.map((r) => r.seq)).toEqual([1, 5]);
});

test("an explicit selection that matches nothing exits nonzero before creating any output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "step-replay-"));
  writeFileSync(join(dir, "000001.json"), JSON.stringify(snap(1, "ok")));
  const outDir = join(dir, "never-made");
  for (const sel of [["--seq", "40-60"], ["--grep", "no-such-text"]]) {
    const p = Bun.spawnSync(["bun", SCRIPT, "--dir", dir, "--out", join(outDir, "out.jsonl"), "--base", "http://127.0.0.1:9", ...sel]);
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain("matches the selection");
    expect(require("node:fs").existsSync(outDir)).toBe(false);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("an archive manifest.json does not list is refused, not replayed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "step-replay-stray-"));
  try {
    writeFileSync(join(dir, "task-k1.jsonl.gz"), Bun.gzipSync(Buffer.from(JSON.stringify(snap(1, "a")) + "\n")));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ k1: { exchanges: 1 } }));
    writeFileSync(join(dir, "extra.jsonl.gz"), Bun.gzipSync(Buffer.from(JSON.stringify(snap(2, "b")) + "\n")));
    const p = Bun.spawnSync(["bun", SCRIPT, "--dir", dir, "--out", join(dir, "out.jsonl"), "--base", "http://127.0.0.1:9"]);
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain("not in manifest.json (extra.jsonl.gz)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// a server that answers with a fixed response object
async function runWith(snaps: any[], response: any, args: string[] = [], outFile?: string) {
  const dir = mkdtempSync(join(tmpdir(), "step-replay-"));
  snaps.forEach((s) => writeFileSync(join(dir, `${String(s.seq).padStart(6, "0")}.json`), JSON.stringify(s)));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json(response) });
  const out = outFile ?? join(dir, "out.jsonl");
  const p = Bun.spawn(["bun", SCRIPT, "--dir", dir, "--out", out, "--base", `http://127.0.0.1:${server.port}`, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  server.stop(true);
  let recs: any[] = [];
  try { recs = readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  if (!outFile) rmSync(dir, { recursive: true, force: true });
  return { code, stdout, stderr, recs };
}
const call = (args: string) => ({ id: "c", type: "function", function: { name: "submit_answer", arguments: args } });
const toolSnap = (seq: number, args: string) => ({ seq, status: 200, request: { model: "m", messages: [{ role: "user", content: "q" }] },
  response: { choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [call(args)] } }] } });
const toolAnswer = (args: string) => ({ choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [call(args)] } }] });

test("auto compares tool calls WITH their arguments: the same tool with a different answer is a change", async () => {
  const diff = await runWith([toolSnap(1, '{"answer":"4"}')], toolAnswer('{"answer":"5"}'));
  expect(diff.code).toBe(0);
  expect(diff.recs[0].changed).toBe(true);
  // the same arguments written with other spacing and key order are not a change
  const same = await runWith([toolSnap(1, '{"answer":"4","why":"x"}')], toolAnswer('{ "why": "x",  "answer": "4" }'));
  expect(same.recs[0].changed).toBe(false);
  // --compare tool still looks at names only
  const names = await runWith([toolSnap(1, '{"answer":"4"}')], toolAnswer('{"answer":"5"}'), ["--compare", "tool"]);
  expect(names.recs[0].changed).toBe(false);
});

test("every choice is compared by index: a change in a later choice, or a different number of choices, is a change", async () => {
  const two = (b: string) => ({ choices: [
    { index: 0, finish_reason: "stop", message: { role: "assistant", content: "a" } },
    { index: 1, finish_reason: "stop", message: { role: "assistant", content: b } },
  ] });
  const s = { seq: 1, status: 200, request: { model: "m", messages: [{ role: "user", content: "q" }] }, response: two("b") };
  expect((await runWith([s], two("B"))).recs[0].changed).toBe(true);
  expect((await runWith([s], two("b"))).recs[0].changed).toBe(false);
  expect((await runWith([s], { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "a" } }] })).recs[0].changed).toBe(true);
});

test("an existing --out is refused unless --append; every row records the mutation config and its sha256", async () => {
  const dir = mkdtempSync(join(tmpdir(), "step-replay-out-"));
  const out = join(dir, "screen.jsonl");
  const a = { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "x" } }] };
  const first = await runWith([snap(1, "y")], a, ["--set", '{"temperature":0}'], out);
  expect(first.code).toBe(0);
  const second = await runWith([snap(1, "y")], a, ["--set", '{"temperature":1}'], out);
  expect(second.code).toBe(2);
  expect(second.stderr).toContain("already exists");
  expect(readFileSync(out, "utf8").trim().split("\n").length).toBe(1);
  const appended = await runWith([snap(1, "y")], a, ["--set", '{"temperature":1}', "--append"], out);
  expect(appended.code).toBe(0);
  const rows = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(rows.length).toBe(2);
  expect(rows[0].config.set).toEqual({ temperature: 0 });
  expect(rows[1].config.set).toEqual({ temperature: 1 });
  expect(rows[0].config_sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(rows[0].config_sha256).not.toBe(rows[1].config_sha256);
  rmSync(dir, { recursive: true, force: true });
});
