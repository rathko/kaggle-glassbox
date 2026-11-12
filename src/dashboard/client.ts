// dashboard client: hash routes, plain DOM strings, no framework. Every value from the server goes through esc()
// (text) or encodeURIComponent (inside an href); numbers are coerced before they are printed; there are no inline
// event handlers. A stale async navigation never paints over a newer one (the seq check in route()).

// The repo typechecks without the DOM lib (it would clash with Bun's own fetch types), so the few browser globals
// used here are reached through one untyped handle.
const g: any = globalThis;
const $ = (id: string) => g.document.getElementById(id);
export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
const num = (x: unknown, d = 0) => (x !== null && x !== undefined && x !== "" && Number.isFinite(Number(x)) ? Number(x).toFixed(d) : "–");
const pct = (x: unknown) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? "–" : `${(100 * Number(x)).toFixed(1)}%`);
const href = (...parts: string[]) => `#/${parts.map(encodeURIComponent).join("/")}`;

async function api(path: string): Promise<any> {
  const r = await fetch(path, { cache: "no-store" });
  const body: any = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

const STATE_TEXT: Record<string, string> = { sealed: "sealed", closed: "closed, not read", open: "open", broken: "changed / broken" };
const stateChip = (s: { state: string; detail: string }) => `<span class="chip s-${esc(s.state)}" title="${esc(s.detail)}">${esc(STATE_TEXT[s.state] ?? s.state)}</span>`;

function cellClass(o: unknown): string {
  return o === true ? "c-pass" : o === false ? "c-fail" : o === "hidden" ? "c-hidden" : "c-null";
}
function cellTitle(o: unknown): string {
  return o === true ? "passed" : o === false ? "failed" : o === "hidden" ? "score not read through the gate yet" : "no valid outcome";
}

// ---- runs: summary, repeat groups, run x task matrix --------------------------------------------------------------
async function viewRuns(): Promise<string> {
  const [runs, m] = await Promise.all([api("/api/runs"), api("/api/matrix")]);
  const rs: any[] = runs.runs;
  if (!rs.length) return `<h1>No runs</h1><p class="muted">No run directories with a task_results.jsonl under ${esc(runs.results)}.</p>`;
  const sealed = rs.filter((r) => r.status.state === "sealed");
  const summary = `<div class="cards">
    <div class="card"><div class="v">${rs.length}</div><div class="l">runs, ${sealed.length} with a sealed score</div></div>
    <div class="card"><div class="v">${num(m.tasks.length)}</div><div class="l">distinct tasks</div></div>
    <div class="card"><div class="v">${num(rs.reduce((s, r) => s + Number(r.exchanges || 0), 0))}</div><div class="l">captured model exchanges</div></div>
    <div class="card"><div class="v">${num(rs.reduce((s, r) => s + Number(r.replays || 0), 0))} / ${num(rs.reduce((s, r) => s + Number(r.forks || 0), 0))}</div><div class="l">step replays / fork screens</div></div>
  </div>`;
  const runTable = `<table><tr><th>run</th><th>state</th><th>score</th><th>tasks</th><th>captured</th><th>exchanges</th><th>replays</th><th>forks</th><th>model</th></tr>
    ${rs.map((r) => `<tr><td>${esc(r.run)}</td><td>${stateChip(r.status)}</td>
      <td class="num">${r.passed === null ? `<span class="muted" title="${esc(r.status.detail)}">not shown</span>` : `${num(r.passed)}/${num(r.tasks)} (${pct(r.rate)})`}</td>
      <td class="num">${num(r.tasks)}</td><td class="num">${num(r.capturedTasks)}</td><td class="num">${num(r.exchanges)}</td>
      <td class="num">${num(r.replays)}</td><td class="num">${num(r.forks)}</td><td>${esc(r.stack?.model ?? "")}</td></tr>`).join("")}</table>`;
  const gs: any[] = runs.groups.filter((g: any) => g.runs.length > 1);
  const groupTable = gs.length ? `<h2>Repeats</h2><p class="muted small">Runs named <code>&lt;name&gt;-r1</code>, <code>-r2</code>… are repeats of one configuration. The spread between them is the noise every comparison has to beat.</p>
    <table><tr><th>configuration</th><th>repeats</th><th>sealed</th><th>mean</th><th>lowest</th><th>highest</th><th>spread</th></tr>
    ${gs.map((g) => `<tr><td>${esc(g.group)}</td><td class="num">${num(g.runs.length)}</td><td class="num">${num(g.sealed)}</td><td class="num">${pct(g.meanRate)}</td><td class="num">${pct(g.minRate)}</td><td class="num">${pct(g.maxRate)}</td>
      <td class="num">${g.minRate === null ? "–" : `${num(100 * (g.maxRate - g.minRate), 1)} pts`}</td></tr>`).join("")}</table>` : "";
  const runNames: string[] = m.runs.map((r: any) => r.run);
  const head = `<tr><th>task</th>${runNames.map((r) => `<th title="${esc(r)}">${esc(r)}</th>`).join("")}<th>passed / sealed</th></tr>`;
  const body = m.tasks.map((t: any) => {
    const graded = runNames.map((r) => t.cells[r]?.outcome).filter((o) => o === true || o === false);
    return `<tr><td>${esc(t.task)}</td>${runNames.map((r) => {
      const c = t.cells[r];
      if (!c) return `<td class="cell"></td>`;
      return `<td class="cell ${cellClass(c.outcome)}"><a href="${href("task", r, t.task)}" title="${esc(`${r} · ${t.task}: ${cellTitle(c.outcome)}${c.captured ? "" : " (no capture)"}`)}">${c.captured ? "·" : ""}</a></td>`;
    }).join("")}<td class="num">${graded.length ? `${graded.filter((o) => o === true).length}/${graded.length}` : "–"}</td></tr>`;
  }).join("");
  const legend = `<p class="legend small"><span><i class="sw c-pass"></i>passed</span><span><i class="sw c-fail"></i>failed</span><span><i class="sw c-hidden"></i>score not read yet (hidden on purpose)</span><span>· = steps captured, click for the drill-down</span></p>`;
  return `<h1>Runs</h1><p class="muted small">Reading <code>${esc(runs.results)}</code>. A score shows only after it was read once through the gate (<code>score-reader</code>); this page never reads or seals one itself.</p>
    ${summary}<h2>Every run</h2>${runTable}${groupTable}<h2>Run × task</h2>${legend}<div class="scroll"><table>${head}${body}</table></div>`;
}

// ---- task drill-down ----------------------------------------------------------------------------------------------
const PALETTE = ["#58a6ff", "#d29922", "#3fb950", "#bc8cff", "#ff7b72", "#39c5cf", "#f0883e", "#a5d6ff"];
// one colour per tool, in order of first use on the page (a hash would let two tools share a colour)
const toolColours = new Map<string, string>();
function colourOf(name: string): string {
  if (name === "text") return "#8b949e";
  if (!toolColours.has(name)) toolColours.set(name, PALETTE[toolColours.size % PALETTE.length]!);
  return toolColours.get(name)!;
}

function timeline(steps: any[]): string {
  if (!steps.length) return "";
  const end = Math.max(...steps.map((s) => Number(s.startMs) + Number(s.durationMs ?? 0)), 1);
  const W = 900, rowH = 16, L = 46, H = steps.length * rowH + 22;
  const x = (ms: number) => L + (ms / end) * (W - L - 10);
  const bars = steps.map((s, i) => {
    const name = s.tools[0]?.name ?? "text", x0 = x(Number(s.startMs) || 0), w = Math.max(2, x(Number(s.startMs) + Number(s.durationMs ?? 0)) - x0);
    return `<text x="4" y="${i * rowH + 12}">#${esc(num(s.seq))}</text><rect x="${num(x0, 1)}" y="${i * rowH + 3}" width="${num(w, 1)}" height="${rowH - 6}" rx="2" fill="${colourOf(name)}"><title>${esc(`${name} · ${num(s.durationMs)} ms · ${num(s.promptTokens)} prompt / ${num(s.completionTokens)} completion tokens`)}</title></rect>`;
  }).join("");
  return `<svg class="tl" width="100%" viewBox="0 0 ${W} ${H}" role="img" aria-label="time per model call">${bars}<text x="${L}" y="${H - 4}">0</text><text x="${W - 10}" y="${H - 4}" text-anchor="end">${esc(num(end / 1000, 2))} s</text></svg>`;
}

async function viewTask(run: string, task: string): Promise<string> {
  const t = await api(`/api/task/${encodeURIComponent(run)}/${encodeURIComponent(task)}`);
  const outcome = t.outcome === "hidden" ? `<span class="chip s-closed">score not read</span>` : t.outcome === true ? `<span class="chip c-pass">passed</span>` : t.outcome === false ? `<span class="chip c-fail">failed</span>` : `<span class="chip s-open">no outcome</span>`;
  const steps: any[] = t.steps;
  const toks = steps.some((x) => x.completionTokens !== null) ? steps.reduce((s, x) => s + Number(x.completionTokens || 0), 0) : null; // streamed answers may carry no usage
  const tools = [...new Set(steps.map((s) => s.tools[0]?.name ?? "text"))];
  const legend = `<p class="legend small">${tools.map((n) => `<span><i class="sw" style="background:${colourOf(n)}"></i>${esc(n)}</span>`).join("")}</p>`;
  const stepList = steps.map((s) => `<div class="step" style="border-left-color:${colourOf(s.tools[0]?.name ?? "text")}">
      <b>#${esc(num(s.seq))}</b> <span class="muted small">+${esc(num(Number(s.startMs) / 1000, 2))} s · ${esc(num(s.durationMs))} ms · ${esc(num(s.promptTokens))} prompt / ${esc(num(s.completionTokens))} completion tokens · ${esc(s.finish ?? "")}${s.streamed ? " · streamed" : ""}</span>
      <pre>${esc(s.input)}</pre>
      ${s.tools.map((c: any) => `<pre>→ ${esc(c.name)}(${esc(c.args)})</pre>`).join("")}${s.content ? `<pre>→ ${esc(s.content)}</pre>` : ""}</div>`).join("");
  const replays = t.replays.length ? `<h2>Step replays</h2><p class="muted small">The same captured request, re-sent with one change (step-replay). A changed first action is what a cheap screen looks for.</p>
    <table><tr><th>file</th><th>step</th><th>repeat</th><th>captured</th><th>replayed</th><th></th></tr>${t.replays.map((r: any) => `<tr><td>${esc(r.file)}</td><td class="num">#${esc(num(r.seq))}</td><td class="num">${esc(num(r.repeat))}</td><td>${esc(r.original)}</td><td>${esc(r.mutated)}</td><td>${r.changed ? `<span class="chip s-closed">changed</span>` : ""}</td></tr>`).join("")}</table>` : "";
  const forks = t.forks.length ? `<h2>Fork screens</h2><p class="muted small">The task replayed exactly up to a step, then continued live N times (fork-run).</p>
    <table><tr><th>tag</th><th>fork after</th><th>rollouts</th><th>valid</th><th>resolved</th><th>rate</th><th>divergent</th></tr>${t.forks.map((f: any) => `<tr><td>${esc(f.tag)}</td><td class="num">${esc(num(f.fork))}</td><td class="num">${esc(num(f.n))}</td><td class="num">${esc(num(f.valid))}</td><td class="num">${esc(num(f.resolved))}</td><td class="num">${pct(f.rate)}</td><td class="num">${esc(num(f.divergent))}</td></tr>`).join("")}</table>` : "";
  const others = t.otherRuns.length ? `<h2>This task in other runs</h2><p>${t.otherRuns.map((o: any) => `<a class="chip ${cellClass(o.outcome)}" href="${href("task", o.run, task)}" title="${esc(cellTitle(o.outcome))}">${esc(o.run)}</a>`).join(" ")}</p>` : "";
  return `<p class="small"><a href="#/runs">← runs</a></p><h1>${esc(task)} <span class="muted">in</span> ${esc(run)} ${outcome}</h1>
    <div class="cards"><div class="card"><div class="v">${num(steps.length)}</div><div class="l">model calls captured</div></div>
    <div class="card"><div class="v">${num(toks)}</div><div class="l">completion tokens</div></div>
    <div class="card"><div class="v">${steps.length ? num((Number(steps.at(-1).startMs) + Number(steps.at(-1).durationMs ?? 0)) / 1000, 2) : "–"} s</div><div class="l">first request to last answer</div></div></div>
    ${steps.length ? `<h2>Time per model call</h2>${legend}${timeline(steps)}<h2>Steps</h2>${stepList}` : `<p class="muted">No capture for this task.</p>`}${replays}${forks}${others}`;
}

// ---- compare two sealed runs ----------------------------------------------------------------------------------------
async function viewCompare(a?: string, b?: string): Promise<string> {
  const runs = (await api("/api/runs")).runs.filter((r: any) => r.status.state === "sealed").map((r: any) => r.run as string);
  if (runs.length < 2) return `<h1>Compare</h1><p class="muted">Needs two runs with a sealed score.</p>`;
  a ??= runs[0]; b ??= runs.find((r: string) => r !== a) ?? runs[1];
  const sel = (id: string, v: string) => `<select id="${id}">${runs.map((r: string) => `<option value="${esc(r)}"${r === v ? " selected" : ""}>${esc(r)}</option>`).join("")}</select>`;
  let out = `<h1>Compare two runs</h1><p class="muted small">Paired on the tasks both runs graded. Only the tasks where they disagree carry information (exact McNemar test).</p><p>${sel("ca", a!)} vs ${sel("cb", b!)}</p>`;
  try {
    const c = await api(`/api/compare/${encodeURIComponent(a!)}/${encodeURIComponent(b!)}`);
    const list = (ts: string[], run: string) => ts.length ? ts.map((t) => `<a class="chip c-pass" href="${href("task", run, t)}">${esc(t)}</a>`).join(" ") : `<span class="muted">none</span>`;
    out += `<div class="cards"><div class="card"><div class="v">${num(c.aPassed)} vs ${num(c.bPassed)}</div><div class="l">passed of ${num(c.shared)} shared tasks</div></div>
      <div class="card"><div class="v">${num(c.aOnly.length)} / ${num(c.bOnly.length)}</div><div class="l">tasks only ${esc(c.a)} / only ${esc(c.b)} solved</div></div>
      <div class="card"><div class="v">p = ${num(c.pValue, 3)}</div><div class="l">paired, two-sided</div></div>
      <div class="card"><div class="v">±${num(c.noiseBandTasks, 1)}</div><div class="l">tasks: two-SD noise band for one draw each</div></div></div>
      <h2>Verdict</h2><div class="verdict">${esc(c.verdict)}</div>
      <h2>Where they disagree</h2><p>Only ${esc(c.a)}: ${list(c.aOnly, c.a)}</p><p>Only ${esc(c.b)}: ${list(c.bOnly, c.b)}</p>`;
  } catch (e) { out += `<p class="muted">${esc((e as Error).message)}</p>`; }
  return out;
}

// ---- competitions -------------------------------------------------------------------------------------------------
async function viewCompetitions(): Promise<string> {
  const { competitions } = await api("/api/competitions");
  if (!competitions.length) return `<h1>Competitions</h1><p class="muted">None found. Add a <code>competitions/&lt;name&gt;/dashboard.ts</code>.</p>`;
  return `<h1>Competitions</h1>${competitions.map((c: any) => `<div class="card" style="max-width:640px;margin-bottom:10px"><a href="${href("competition", c.name)}"><b>${esc(c.title)}</b></a><div class="l">${esc(c.summary)}</div></div>`).join("")}`;
}

async function viewCompetition(name: string): Promise<string> {
  const c = await api(`/api/competition/${encodeURIComponent(name)}`);
  const cards = c.numbers.map((n: any) => `<div class="card"><div class="v">${esc(n.value)}</div><div class="l">${esc(n.label)}</div>${n.note ? `<div class="muted small">${esc(n.note)}</div>` : ""}</div>`).join("");
  const figs = c.figures.map((f: any) => `<figure><img src="/fig/${encodeURIComponent(name)}/${encodeURIComponent(f.id)}.svg" alt="${esc(f.title)}" loading="lazy"><figcaption><b>${esc(f.title)}.</b> <span class="muted">${esc(f.caption)}</span></figcaption></figure>`).join("");
  return `<p class="small"><a href="#/competitions">← competitions</a></p><h1>${esc(c.title)}</h1><p class="muted">${esc(c.summary)}</p><div class="cards">${cards}</div><h2>Figures</h2><div class="figs">${figs}</div>`;
}

// ---- router -------------------------------------------------------------------------------------------------------
let seq = 0;
async function route(): Promise<void> {
  const my = ++seq;
  const parts = g.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map((p: string) => { try { return decodeURIComponent(p); } catch { return ""; } });
  const tab = parts[0] === "task" ? "runs" : parts[0] === "competition" ? "competitions" : parts[0] || "runs";
  g.document.querySelectorAll("nav a").forEach((a: any) => a.classList.toggle("on", a.dataset.tab === tab));
  $("status").textContent = "loading…";
  let html: string;
  try {
    if (parts[0] === "task" && parts.length === 3) html = await viewTask(parts[1]!, parts[2]!);
    else if (parts[0] === "compare") html = await viewCompare(parts[1], parts[2]);
    else if (parts[0] === "competitions") html = await viewCompetitions();
    else if (parts[0] === "competition" && parts[1]) html = await viewCompetition(parts[1]);
    else html = await viewRuns();
  } catch (e) { html = `<h1>Could not load</h1><p class="muted">${esc((e as Error).message)}</p><p><a href="#/runs">back to runs</a></p>`; }
  if (my !== seq) return; // a newer navigation superseded this one
  $("app").innerHTML = html;
  $("status").textContent = `updated ${new Date().toLocaleTimeString()}`;
  const ca = $("ca"), cb = $("cb");
  if (ca && cb) for (const s of [ca, cb]) s.addEventListener("change", () => { g.location.hash = href("compare", ca.value, cb.value); });
}

if (g.window && g.document) {
  g.addEventListener("hashchange", route);
  route();
}
