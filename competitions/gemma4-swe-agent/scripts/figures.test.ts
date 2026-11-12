import { test, expect, setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000); // statistical tests can take seconds on a loaded machine (the bunfig preload alone did not always apply)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scoreTimelineSvg } from "./fig-score-timeline";
import { decisionsSvg } from "./fig-decisions";
import { parsePlatformHistory } from "./reproduce-paper-numbers";

const data = (f: string) => readFileSync(join(import.meta.dir, "..", "data", f), "utf8");

test("Figure 1 is drawn from platform-history.csv alone: 36 uploads, 4 same-bytes arcs, public-base mean and band as in the paper", () => {
  const r = scoreTimelineSvg(parsePlatformHistory(data("platform-history.csv")));
  expect(r.points).toBe(36);
  expect(r.arcs).toBe(4);
  expect(r.mean).toBeCloseTo(0.1725, 4);
  expect(r.sdScore).toBeCloseTo(1.46 / 58, 3);
  expect((r.svg.match(/<circle /g) ?? []).length).toBe(36);
  expect(r.svg).not.toMatch(/\bv\d{2,3}\b/); // anonymised labels only
});

test("Figure 7 is drawn from flaky10-decisions.json alone: 23 primary reads, 4 promoted", () => {
  const r = decisionsSvg(JSON.parse(data("flaky10-decisions.json")));
  expect(r.reads).toBe(23);
  expect(r.promoted).toBe(4);
  expect((r.svg.match(/fill="#1d4ed8" stroke/g) ?? []).length).toBe(4);
});
