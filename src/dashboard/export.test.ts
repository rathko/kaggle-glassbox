// The static export (GitHub Pages demo) must carry every answer the page asks for, mark itself static, and leak no
// path of the machine that built it.
import { expect, test, setDefaultTimeout } from "bun:test";
setDefaultTimeout(120_000);
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exportStatic } from "./export.ts";

const REPO = resolve(import.meta.dir, "../..");
const out = mkdtempSync(join(tmpdir(), "dash-export-"));
const ready = exportStatic({ results: join(REPO, "examples", "sample-runs"), competitions: join(REPO, "competitions"), out });

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : [p]; });
}

test("the export has the page, the client and every API answer it needs", async () => {
  await ready;
  for (const f of ["index.html", "app.js", ".nojekyll", "api/runs.json", "api/matrix.json", "api/competitions.json", "api/competition/gemma4-swe-agent.json"]) expect(existsSync(join(out, f))).toBe(true);
  const m = JSON.parse(readFileSync(join(out, "api/matrix.json"), "utf8"));
  for (const t of m.tasks) for (const run of Object.keys(t.cells)) expect(existsSync(join(out, "api/task", run, `${t.task}.json`))).toBe(true);
  const c = JSON.parse(readFileSync(join(out, "api/competition/gemma4-swe-agent.json"), "utf8"));
  for (const f of c.figures) expect(readFileSync(join(out, "fig/gemma4-swe-agent", `${f.id}.svg`), "utf8")).toContain("<svg");
});

test("index.html is marked static, shows the banner, and loads the client by a relative path", async () => {
  await ready;
  const html = readFileSync(join(out, "index.html"), "utf8");
  expect(html).toContain(`<body data-static="1">`);
  expect(html).toContain(`<div class="banner" id="banner">Static demo`);
  expect(html).toContain(`<script src="app.js">`);
});

test("compare: every sealed pair is pre-rendered, and a refusal is stored as its error", async () => {
  await ready;
  const runs = JSON.parse(readFileSync(join(out, "api/runs.json"), "utf8")).runs.filter((r: any) => r.status.state === "sealed").map((r: any) => r.run);
  for (const a of runs) for (const b of runs) if (a !== b) {
    const j = JSON.parse(readFileSync(join(out, "api/compare", a, `${b}.json`), "utf8"));
    expect(typeof j.verdict === "string" || typeof j.error === "string").toBe(true);
  }
});

test("a structure-only task drill-down carries its structure and no captured text", async () => {
  await ready;
  const dir = join(out, "api/task/D176-sample");
  const t = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]!), "utf8"));
  expect(t.structure.steps.length).toBeGreaterThan(2);
  expect(t.steps).toEqual([]);
});

test("no file leaks a path of the machine that built it", async () => {
  await ready;
  const bad = /\/home\/|\/tmp\/|\/Users\/|[A-Z]:\\\\/;
  const hits = files(out).filter((f) => bad.test(readFileSync(f, "utf8")) || readFileSync(f, "utf8").includes(REPO));
  expect(hits.map((f) => f.slice(out.length))).toEqual([]);
});
