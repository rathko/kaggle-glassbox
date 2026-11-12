#!/usr/bin/env bun
// dashboard: a local, read-only viewer for your runs and for each competition's figures. One Bun server, loopback
// only, zero dependencies, no telemetry. Everything is read fresh from disk per request, so a run in flight is
// current on refresh. It never writes: it does not close, repair or seal a run, and it shows a score only for a
// run already read through the gate (see "THE SCORE RULE" in data.ts).
//
//   bun run dashboard                                   (sample runs in examples/sample-runs, port 8180)
//   bun src/dashboard/serve.ts [--results <dir>] [--competitions <dir>] [--port N]
//   DASH_PORT=8181 bun run dashboard
//
// API (all JSON; contract in docs/guide.md#dashboard, tested in serve.test.ts):
//   GET /api/runs                    run summaries + groups of repeats       GET /api/matrix   runs x tasks
//   GET /api/task/<run>/<task>       captured steps, replays, forks, the task in other runs
//   GET /api/compare/<a>/<b>         two sealed runs, paired                  GET /api/competitions
//   GET /api/competition/<name>      its numbers and figure list              GET /fig/<name>/<id>.svg
// Unknown /api, /fig paths and unknown runs/tasks are 404 JSON; any unexpected error is 500 JSON and the server
// keeps serving.
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { NotFound, checkId, compare, groups, listRuns, matrix, runSummary, taskView } from "./data.ts";
import { isSafeId, within } from "../safe-id.ts";
import { strictArgs } from "../cli-args.ts";

const REPO = resolve(import.meta.dir, "../..");

export interface Figure { id: string; title: string; caption: string; svg: () => string }
export interface CompetitionDashboard { title: string; summary: string; numbers: () => { label: string; value: string; note?: string }[]; figures: Figure[] }

export interface DashOptions { results: string; competitions: string; port?: number }

export function listCompetitions(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((d) => isSafeId(d) && existsSync(join(root, d, "dashboard.ts"))).sort();
}

async function competition(root: string, name: string): Promise<CompetitionDashboard> {
  checkId(name, "competition");
  if (!listCompetitions(root).includes(name)) throw new NotFound(`unknown competition ${name}`);
  return (await import(within(root, name, "dashboard.ts"))) as CompetitionDashboard;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

let clientJs: Promise<string> | null = null;
async function buildClient(): Promise<string> {
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, "client.ts")], target: "browser", format: "iife", minify: false });
  if (!built.success) throw new Error(built.logs.map(String).join("\n"));
  return built.outputs[0]!.text();
}

export function handler(opts: DashOptions): (req: Request) => Promise<Response> {
  const results = resolve(opts.results), comps = resolve(opts.competitions);
  // the results path as shown on the page: repo-relative when it is inside the repo, so a screenshot carries no home path
  const rel = relative(REPO, results), shown = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : results;
  return async (req) => {
    const url = new URL(req.url);
    let parts: string[];
    try { parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); }
    catch { return json({ error: "bad path" }, 400); }
    try {
      if (req.method !== "GET") return json({ error: "read-only" }, 405);
      if (url.pathname === "/") return new Response(Bun.file(join(import.meta.dir, "index.html")), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
      if (url.pathname === "/app.js") {
        clientJs ??= buildClient().catch((e) => { clientJs = null; throw e; });
        return new Response(await clientJs, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" } });
      }
      const [a, b, c, d] = parts;
      if (a === "api") {
        if (b === "runs" && parts.length === 2) return json({ results: shown, runs: listRuns(results).map((r) => runSummary(results, r)), groups: groups(results) });
        if (b === "matrix" && parts.length === 2) return json(matrix(results));
        if (b === "task" && parts.length === 4) return json(taskView(results, c!, d!));
        if (b === "compare" && parts.length === 4) return json(compare(results, c!, d!));
        if (b === "competitions" && parts.length === 2) {
          const list = await Promise.all(listCompetitions(comps).map(async (n) => { const m = await competition(comps, n); return { name: n, title: m.title, summary: m.summary }; }));
          return json({ competitions: list });
        }
        if (b === "competition" && parts.length === 3) {
          const m = await competition(comps, c!);
          return json({ name: c, title: m.title, summary: m.summary, numbers: m.numbers(), figures: m.figures.map((f) => ({ id: f.id, title: f.title, caption: f.caption })) });
        }
        return json({ error: "unknown endpoint" }, 404);
      }
      if (a === "fig" && parts.length === 3 && d === undefined && c!.endsWith(".svg")) {
        const m = await competition(comps, b!), f = m.figures.find((x) => `${x.id}.svg` === c);
        if (!f) return json({ error: "unknown figure" }, 404);
        return new Response(f.svg(), { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store", "Content-Security-Policy": "script-src 'none'" } });
      }
      if (a === "fig") return json({ error: "unknown figure" }, 404);
      return new Response("not found", { status: 404 });
    } catch (e) {
      if (e instanceof NotFound) return json({ error: e.message }, 404);
      if (e instanceof Error && / is outside /.test(e.message)) return json({ error: "bad path" }, 400);
      console.error(`dashboard: ${url.pathname}: ${(e as Error)?.stack ?? e}`);
      return json({ error: "internal error" }, 500);
    }
  };
}

export function startDashboard(opts: DashOptions) {
  return Bun.serve({ hostname: "127.0.0.1", port: opts.port ?? 8180, fetch: handler(opts) });
}

if (import.meta.main) {
  const usage = "usage: bun src/dashboard/serve.ts [--results <dir>] [--competitions <dir>] [--port N]   (defaults: examples/sample-runs, competitions, $DASH_PORT or 8180)";
  const argv = process.argv.slice(2);
  strictArgs(argv, { valued: ["results", "competitions", "port"] }, usage);
  const val = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const results = val("results") ?? join(REPO, "examples", "sample-runs");
  const port = Number(val("port") ?? process.env.DASH_PORT ?? 8180);
  if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error(`bad port\n${usage}`); process.exit(2); }
  if (!existsSync(results)) { console.error(`no such results directory: ${results}\n${usage}`); process.exit(2); }
  const s = startDashboard({ results, competitions: val("competitions") ?? join(REPO, "competitions"), port });
  console.log(`dashboard on http://127.0.0.1:${s.port}  (runs: ${results}, ${listRuns(resolve(results)).length} found)`);
}
