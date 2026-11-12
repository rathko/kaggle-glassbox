import { test, expect, setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000);
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { handler } from "./serve";
import { compare, matrix, readJsonl, runStatus, runSummary } from "./data";
import { esc } from "./client";

const REPO = join(import.meta.dir, "../..");
const SAMPLE = join(REPO, "examples", "sample-runs");
const COMPS = join(REPO, "competitions");
const get = (h: (r: Request) => Promise<Response>, path: string, init?: RequestInit) => h(new Request(`http://127.0.0.1${path}`, init));
const sampleCopy = () => { const d = mkdtempSync(join(tmpdir(), "dash-test-")); cpSync(SAMPLE, d, { recursive: true }); return d; };

test("the committed sample runs are intact: every closed-and-read run is still sealed, and the two short runs are not", () => {
  const states = Object.fromEntries(readdirSync(SAMPLE).filter((d) => /-r\d+$|^live-/.test(d)).map((d) => [d, runStatus(join(SAMPLE, d)).state]));
  expect(states).toEqual({ "baseline-r1": "sealed", "baseline-r2": "sealed", "baseline-r3": "sealed", "baseline-r4": "open", "candidate-r1": "sealed", "candidate-r2": "sealed", "candidate-r3": "closed", "live-gemma4-qa": "sealed" });
});

test("matrix totals agree with each sealed run's own task_results.jsonl and with its seal", () => {
  const m = matrix(SAMPLE);
  for (const r of m.runs) {
    const rows = readJsonl(join(SAMPLE, r.run, "task_results.jsonl"));
    expect(r.tasks).toBe(rows.length);
    if (r.status.state !== "sealed") { expect(r.passed).toBeNull(); expect(r.rate).toBeNull(); continue; }
    expect(r.passed).toBe(rows.filter((x) => x.resolved === true).length);
    expect(r.passed).toBe(JSON.parse(readFileSync(join(SAMPLE, r.run, "score-read.json"), "utf8")).read.passed);
    expect(m.tasks.filter((t) => t.cells[r.run]?.outcome === true).length).toBe(r.passed!);
  }
});

test("THE SCORE RULE: a run whose score was not read through the gate shows no score and no per-task outcome", () => {
  const m = matrix(SAMPLE);
  for (const run of ["candidate-r3", "baseline-r4"]) {
    const s = m.runs.find((r) => r.run === run)!;
    expect(s.passed).toBeNull();
    for (const t of m.tasks) if (t.cells[run]) expect(t.cells[run]!.outcome).toBe("hidden");
  }
  expect(() => compare(SAMPLE, "baseline-r1", "candidate-r3")).toThrow(/no sealed score/);
});

test("a sealed run whose rows change after the read is shown as broken, its score hidden", () => {
  const d = sampleCopy();
  try {
    appendFileSync(join(d, "baseline-r2", "task_results.jsonl"), JSON.stringify({ instance_id: "task-99", resolved: true }) + "\n");
    const s = runSummary(d, "baseline-r2");
    expect(s.status.state).toBe("broken");
    expect(s.passed).toBeNull();
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("compare pairs two sealed runs on their shared tasks: same agent, 5 vs 10, and the verdict still says noise", () => {
  const c = compare(SAMPLE, "baseline-r1", "baseline-r3");
  expect(c.shared).toBe(16);
  expect(c.bPassed - c.aPassed).toBe(c.bOnly.length - c.aOnly.length);
  expect(c.pValue).toBeGreaterThan(0.05);
  expect(c.verdict).toMatch(/within what chance produces/);
});

test("server contract: status codes, JSON errors, traversal refused, read-only", async () => {
  const h = handler({ results: SAMPLE, competitions: COMPS });
  const cases: [string, number][] = [
    ["/", 200], ["/app.js", 200], ["/api/runs", 200], ["/api/matrix", 200], ["/api/task/baseline-r1/task-11", 200],
    ["/api/compare/baseline-r1/baseline-r3", 200], ["/api/competitions", 200], ["/api/competition/gemma4-swe-agent", 200],
    ["/fig/gemma4-swe-agent/frontier.svg", 200],
    ["/api/task/nope/task-11", 404], ["/api/task/baseline-r1/nope", 404], ["/api/competition/nope", 404], ["/fig/gemma4-swe-agent/nope.svg", 404],
    ["/api/runs/extra", 404], ["/api/nope", 404], ["/fig/nope", 404], ["/elsewhere", 404],
    ["/api/compare/baseline-r1/candidate-r3", 404],
  ];
  for (const [p, code] of cases) expect([p, (await get(h, p)).status]).toEqual([p, code]);
  for (const p of ["/api/task/..%2F..%2Fetc/passwd", "/api/task/%2E%2E/x", "/api/task/baseline-r1/..%2F..%2Fpackage.json", "/api/competition/..%2Fsrc", "/api/task/%E0%A4%A/x"]) {
    const r = await get(h, p);
    expect([p, r.status >= 400 && r.status < 500]).toEqual([p, true]);
    expect(await r.json()).toHaveProperty("error");
  }
  expect((await get(h, "/api/runs", { method: "POST" })).status).toBe(405);
  const runs: any = await (await get(h, "/api/runs")).json();
  expect(runs.results).toBe("examples/sample-runs"); // repo-relative: no home path on the page
  const js = await (await get(h, "/app.js")).text();
  expect(js).not.toMatch(/^export /m); // a classic <script>: an ES export would be a syntax error in the browser
});

test("an exception inside a request is a 500 JSON, and the next request is still served", async () => {
  const comps = mkdtempSync(join(tmpdir(), "dash-comps-"));
  try {
    mkdirSync(join(comps, "boom"));
    writeFileSync(join(comps, "boom", "dashboard.ts"), `export const title = "boom"; export const summary = ""; export const figures = []; export function numbers() { throw new Error("kaboom"); }\n`);
    const h = handler({ results: SAMPLE, competitions: comps });
    const quiet = console.error; console.error = () => {};
    try {
      const r = await get(h, "/api/competition/boom");
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({ error: "internal error" }); // the message stays in the server log
    } finally { console.error = quiet; }
    expect((await get(h, "/api/runs")).status).toBe(200);
  } finally { rmSync(comps, { recursive: true, force: true }); }
});

test("a torn final line (an append in flight) is skipped, complete rows still serve", () => {
  const d = sampleCopy();
  try {
    appendFileSync(join(d, "baseline-r4", "task_results.jsonl"), '{"instance_id":"task-17","reso');
    expect(runSummary(d, "baseline-r4").tasks).toBe(16);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("task drill-down reads the compacted capture in order, with replays and forks", async () => {
  const h = handler({ results: SAMPLE, competitions: COMPS });
  const t: any = await (await get(h, "/api/task/baseline-r1/task-11")).json();
  expect(t.steps.length).toBeGreaterThan(1);
  expect(t.steps.map((s: any) => s.seq)).toEqual([...t.steps.map((s: any) => s.seq)].sort((a: number, b: number) => a - b));
  expect(t.replays.length).toBe(1);
  expect(t.forks[0]).toMatchObject({ task: "task-11", n: 4, valid: 4 });
  const live: any = await (await get(h, "/api/task/live-gemma4-qa/q1")).json();
  expect(live.steps[0].tools[0].name).toBe("calc");
});

test("esc covers & < > \" '", () => {
  expect(esc(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
});

test("the sample data carries no absolute home or temp path, compressed captures included", () => {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
  for (const f of walk(SAMPLE)) {
    const text = f.endsWith(".gz") ? gunzipSync(readFileSync(f)).toString("utf8") : readFileSync(f, "utf8");
    expect([f, /\/home\/|\/tmp\/|\/Users\//.test(text)]).toEqual([f, false]);
  }
});
