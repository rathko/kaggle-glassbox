// The dashboard page for this competition (src/dashboard/serve.ts picks up any competitions/<name>/dashboard.ts).
// Every figure is drawn live from data/ by the same script that writes it for the paper; the headline numbers come
// from the same functions scripts/reproduce-paper-numbers.ts prints (the slow Monte Carlo lines are left to it).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CompetitionDashboard } from "../../src/dashboard/serve.ts";
import { scoreTimelineSvg } from "./scripts/fig-score-timeline.ts";
import { decisionsSvg } from "./scripts/fig-decisions.ts";
import { falsePassSvg } from "./scripts/fig-false-pass.ts";
import { driftSvg } from "./scripts/fig-flaky10-drift.ts";
import { frontierSvg, parseAttempts } from "./scripts/fig-frontier.ts";
import { FLAKY10_PER_DRAW_SD, driftRanges, flaky10PassRateSummary, pairedDiffs, parseFlaky10Drift, parsePlatformHistory, rescoreSdWithCi } from "./scripts/reproduce-paper-numbers.ts";
import { aaRow, aaStudyCounts } from "./scripts/aa-hindsight.ts";

const data = (f: string) => readFileSync(join(import.meta.dir, "data", f), "utf8");
const pct = (x: number, d = 1) => `${(100 * x).toFixed(d)}%`;

export const title = "Gemma 4 SWE agent (Kaggle)";
export const summary = "A coding agent on a 58-task hidden leaderboard, two local RTX 3090s, 197 sealed draws. The paper's figures and headline numbers, recomputed from data/ on every load.";

let cached: ReturnType<CompetitionDashboard["numbers"]> | null = null;
export function numbers(): ReturnType<CompetitionDashboard["numbers"]> {
  if (cached) return cached; // data/ is committed and static; the A/A bootstrap takes a few seconds
  const platform = parsePlatformHistory(data("platform-history.csv"));
  const re = rescoreSdWithCi(pairedDiffs(platform));
  const fp = flaky10PassRateSummary();
  const drift = driftRanges(parseFlaky10Drift(data("flaky10-drift.csv")));
  const aa = aaRow("pre-registered A/A", aaStudyCounts(data("aa-study.csv")));
  const dec = decisionsSvg(JSON.parse(data("flaky10-decisions.json")));
  cached = [
    { label: "leaderboard uploads", value: String(platform.length), note: "data/platform-history.csv" },
    { label: "re-score SD, identical bytes", value: `${re.sd.toFixed(2)} tasks`, note: `95% CI ${re.ciLow.toFixed(2)}-${re.ciHigh.toFixed(2)}, ${re.df} same-bytes pairs` },
    { label: "per-draw SD, 10-task stage", value: `${FLAKY10_PER_DRAW_SD} solves`, note: "pooled within package and block" },
    { label: "ideas promoted by the +1 bar", value: `${dec.promoted} of ${dec.reads}`, note: `false-pass rate at 3-6 draws: ${pct(fp.nullRateLow)}-${pct(fp.nullRateHigh)}` },
    { label: "same bytes, block-to-block spread", value: Object.entries(drift).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(" · "), note: "mean solves per draw, max minus min" },
    { label: "pre-registered A/A", value: `beat itself ${pct(aa.fp, 0)} of the time`, note: `${aa.draws} draws of one unchanged version, every 4-vs-3 split; bootstrap 95% ${pct(aa.ci[0]!)}-${pct(aa.ci[1]!)}` },
  ];
  return cached;
}

export const figures: CompetitionDashboard["figures"] = [
  { id: "score-timeline", title: "Same bytes, different scores", caption: "Public score per upload. Red arcs join identical bytes uploaded twice.", svg: () => scoreTimelineSvg(parsePlatformHistory(data("platform-history.csv"))).svg },
  { id: "false-pass", title: "How often a +1 bar promotes nothing", caption: "Chance an idea with zero true effect clears the bar, by draws per arm.", svg: () => falsePassSvg().svg },
  { id: "flaky10-drift", title: "Unchanged packages drift between blocks", caption: "Identical bytes re-run in different blocks of the 10-task stage.", svg: () => driftSvg(parseFlaky10Drift(data("flaky10-drift.csv"))).svg },
  { id: "decisions", title: "Every decided idea against its own null", caption: "Grey: where a do-nothing idea lands by chance. Filled: promoted.", svg: () => decisionsSvg(JSON.parse(data("flaky10-decisions.json"))).svg },
  { id: "frontier", title: "How every attempt ended", caption: "The failure frontier per group, from the released attempts (withheld stop reasons left out).", svg: () => frontierSvg(parseAttempts(data("attempts.csv"))).svg },
];
