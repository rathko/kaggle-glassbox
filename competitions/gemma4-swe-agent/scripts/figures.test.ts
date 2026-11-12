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

test("The false-pass curve uses the paper's flaky-10 SD and reproduces its 12.6-20.9% at 3-6 draws", async () => {
  const { falsePassSvg, passNull } = await import("./fig-false-pass");
  const r = falsePassSvg();
  expect(r.atUsed[0]).toBeCloseTo(0.126, 3);
  expect(r.atUsed[1]).toBeCloseTo(0.209, 3);
  expect(passNull(20, true)).toBeLessThan(passNull(1, true));
  expect(passNull(5, false)).toBeLessThan(passNull(5, true)); // a noiseless baseline halves the variance
  expect((r.svg.match(/<polyline /g) ?? []).length).toBe(2);
});

test("The drift figure is drawn from flaky10-drift.csv alone: 3 packages, 15 block means, spreads as in the paper", async () => {
  const { driftSvg } = await import("./fig-flaky10-drift");
  const { parseFlaky10Drift } = await import("./reproduce-paper-numbers");
  const r = driftSvg(parseFlaky10Drift(data("flaky10-drift.csv")));
  expect(r.packages).toBe(3);
  expect(r.ranges).toEqual({ A: 2, B: 2.17, C: 2 });
  expect((r.svg.match(/<circle /g) ?? []).length).toBe(15);
});

test("The frontier figure is drawn from attempts.csv alone: withheld stops are left out, never guessed", async () => {
  const { frontierSvg, parseAttempts, endings } = await import("./fig-frontier");
  const rows = parseAttempts(data("attempts.csv"));
  const r = frontierSvg(rows);
  expect(r.withheld).toBe(rows.filter((x) => x.stop === "withheld").length);
  const e = endings(rows);
  expect(e.groups.reduce((s, g) => s + g.n, 0) + e.withheld).toBe(rows.length);
  for (const g of e.groups) expect(Object.values(g.counts).reduce((s, c) => s + c, 0)).toBe(g.n);
  expect(Object.values(r.shares).reduce((s, c) => s + c, 0)).toBeCloseTo(1, 9);
  expect(() => endings([{ group: "X", slate: "1", resolved: false, stop: "mystery" }])).toThrow(/unknown stop/);
  expect(r.svg).not.toMatch(/\bv\d{2,3}\b/);
});
