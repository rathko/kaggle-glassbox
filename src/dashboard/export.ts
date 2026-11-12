#!/usr/bin/env bun
// dashboard:export: the dashboard as static files, for hosting with no server (the GitHub Pages demo).
//
//   bun run dashboard:export <outdir> [--results <dir>] [--competitions <dir>]
//
// Every API answer the page can ask for is pre-rendered by the SAME handler `bun run dashboard` serves, and written
// as <outdir>/<path>.json: runs, the matrix, every task drill-down in the matrix, every pair of sealed runs for
// compare (a refusal is written as its {error} body, which the page shows), competitions, and each figure as SVG.
// index.html gets data-static="1" (the client then fetches <path>.json, relative, so a subpath works) and shows a
// banner saying it is a static demo. The score rule still holds: the files carry only what the server would show.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { handler, listCompetitions } from "./serve.ts";
import { strictArgs } from "../cli-args.ts";

const REPO = resolve(import.meta.dir, "../..");

export interface ExportOptions { results: string; competitions: string; out: string }

export async function exportStatic(opts: ExportOptions): Promise<{ files: number }> {
  const h = handler({ results: opts.results, competitions: opts.competitions });
  const out = resolve(opts.out);
  rmSync(out, { recursive: true, force: true });
  let files = 0;
  const put = (rel: string, body: string) => {
    const p = join(out, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    files++;
  };
  const get = async (path: string, allow404 = false): Promise<string> => {
    const r = await h(new Request(`http://dashboard.local/${path}`));
    if (r.status !== 200 && !(allow404 && r.status === 404)) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`);
    return r.text();
  };
  const json = async (path: string, allow404 = false) => { const body = await get(path, allow404); put(`${path}.json`, body); return JSON.parse(body); };

  const runs = await json("api/runs");
  const m = await json("api/matrix");
  for (const t of m.tasks) for (const run of Object.keys(t.cells)) await json(`api/task/${run}/${t.task}`);
  const sealed: string[] = runs.runs.filter((r: any) => r.status.state === "sealed").map((r: any) => r.run);
  for (const a of sealed) for (const b of sealed) if (a !== b) await json(`api/compare/${a}/${b}`, true);
  await json("api/competitions");
  for (const name of listCompetitions(resolve(opts.competitions))) {
    const c = await json(`api/competition/${name}`);
    for (const f of c.figures) put(`fig/${name}/${f.id}.svg`, await get(`fig/${name}/${f.id}.svg`));
  }

  put("app.js", await get("app.js"));
  const html = readFileSync(join(import.meta.dir, "index.html"), "utf8")
    .replace("<body>", `<body data-static="1">`)
    .replace(`<div class="banner" id="banner" hidden>`, `<div class="banner" id="banner">`);
  if (!html.includes(`data-static="1"`) || html.includes(`id="banner" hidden`)) throw new Error("index.html changed shape: static markers not applied");
  put("index.html", html);
  put(".nojekyll", ""); // GitHub Pages: serve files as they are
  return { files };
}

if (import.meta.main) {
  const usage = "usage: bun run dashboard:export <outdir> [--results <dir>] [--competitions <dir>]   (defaults: examples/sample-runs, competitions)";
  const argv = process.argv.slice(2);
  const [outDir] = strictArgs(argv, { valued: ["results", "competitions"], positionals: [1, 1] }, usage);
  const val = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const results = val("results") ?? join(REPO, "examples", "sample-runs");
  if (!existsSync(results)) { console.error(`no such results directory: ${results}\n${usage}`); process.exit(2); }
  const { files } = await exportStatic({ results, competitions: val("competitions") ?? join(REPO, "competitions"), out: outDir });
  console.log(`exported ${files} files to ${outDir}`);
}
