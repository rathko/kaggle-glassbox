import { test, expect, setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000); // statistical tests can take seconds on a loaded machine (the bunfig preload alone did not always apply)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sharedBaselinePassCounts, type NullRead } from "./shared-baseline.ts";

const rows = JSON.parse(readFileSync(join(import.meta.dir, "..", "data/flaky10-decisions.json"), "utf8")).filter((x: { primary: boolean }) => x.primary);
const reads = rows.map((x: { drawsArm: number; drawsCtl: number; passThreshold: number; controlType: string; fixedBaselineValue: number; fixedBaselineN: number }) => ({
  drawsArm: x.drawsArm, drawsCtl: x.drawsCtl, bar: x.passThreshold,
  baselineGroup: x.controlType === "fixed-baseline" ? `fb-${x.fixedBaselineValue}-${x.fixedBaselineN}` : null,
}));

test("sharing the fixed baseline's noise across its 3 reads leaves the null pass count at about 4.1 (90% 1 to 7)", () => {
  const r = sharedBaselinePassCounts(reads, 1.51, 4, 100_000);
  expect(r.mean).toBeCloseTo(4.07, 1);
  expect([r.lo90, r.hi90]).toEqual([1, 7]);
  expect(r.pAtLeastObserved).toBeGreaterThan(0.5);
});

test("independent reads give the same mean as the closed-form sum", () => {
  const r = sharedBaselinePassCounts(reads.map((x: object) => ({ ...x, baselineGroup: null })), 1.51, 4, 100_000);
  expect(r.mean).toBeCloseTo(4.07, 1);
});

test("two arms against one shared control: pass events are positively correlated, marginals unchanged", () => {
  // both reads pass iff arm - ctl >= bar; with one shared control, P(both pass) > P(pass)^2
  const one: NullRead = { drawsArm: 3, drawsCtl: 3, bar: 1, baselineGroup: null };
  const solo = sharedBaselinePassCounts([one], 1.5, 1, 200_000, 7);
  const sharedPair = sharedBaselinePassCounts([{ ...one, baselineGroup: "c" }, { ...one, baselineGroup: "c" }], 1.5, 2, 200_000, 7);
  const indepPair = sharedBaselinePassCounts([one, one], 1.5, 2, 200_000, 7);
  const p = solo.pAtLeastObserved;
  expect(sharedPair.mean).toBeCloseTo(2 * p, 2); // marginals unchanged
  expect(indepPair.pAtLeastObserved).toBeCloseTo(p * p, 2);
  // exact: corr(arm1 - c, arm2 - c) = 1/2, so P(both) is the bivariate-normal orthant at rho 0.5, well above p^2
  expect(sharedPair.pAtLeastObserved).toBeGreaterThan(p * p + 0.02);
});

test("an arm key shared with another read's control links the two reads", () => {
  const a: NullRead = { drawsArm: 3, drawsCtl: 3, bar: 1, baselineGroup: null, armGroup: "x" };
  const b: NullRead = { drawsArm: 3, drawsCtl: 3, bar: 1, baselineGroup: "x" };
  // read a passing needs a high x; read b passing needs a LOW x: the two passes are negatively linked
  const linked = sharedBaselinePassCounts([a, b], 1.5, 2, 200_000, 9);
  const indep = sharedBaselinePassCounts([{ ...a, armGroup: null }, b], 1.5, 2, 200_000, 9);
  expect(linked.pAtLeastObserved).toBeLessThan(indep.pAtLeastObserved - 0.005);
});

test("the campaign's reads with every reused draw set shared: mean 4.07, 90% 1-8", async () => {
  const { sharedDrawKeys } = await import("./reproduce-paper-numbers");
  const d = JSON.parse(readFileSync(join(import.meta.dir, "../data/flaky10-decisions.json"), "utf8")).filter((x: any) => x.primary);
  const keys = d.map(sharedDrawKeys);
  // the K16 control is reused by four reads, and the historical K05 control reuses V25's K02 arm draws
  expect(keys.filter((k: any) => k.baselineGroup === "V31|5.3.4.7.7")).toHaveLength(4);
  expect(keys.some((k: any) => k.armGroup === "V25|7.6.6") && keys.some((k: any) => k.baselineGroup === "V25|7.6.6")).toBe(true);
  const r = sharedBaselinePassCounts(keys, 1.51, 4);
  expect(r.mean).toBeCloseTo(4.07, 1);
  expect([r.lo90, r.hi90]).toEqual([1, 8]);
  expect(r.pAtLeastObserved).toBeCloseTo(0.58, 2);
}, 60_000);

test("a draw-set key used with two different draw counts is a data error", () => {
  const a: NullRead = { drawsArm: 3, drawsCtl: 4, bar: 1, baselineGroup: "k" };
  expect(() => sharedBaselinePassCounts([a, { ...a, drawsCtl: 5 }], 1.5, 1, 10, 1)).toThrow("used with 4 and 5 draws");
});

test("power: an effect on the arm raises passes, and a shared cross-block control adds drift covariance", () => {
  const one: NullRead = { drawsArm: 4, drawsCtl: 4, bar: 1, baselineGroup: null };
  const nul = sharedBaselinePassCounts([one], 1.5, 0, 200_000, 3);
  const eff = sharedBaselinePassCounts([{ ...one, effect: 1 }], 1.5, 0, 200_000, 3);
  expect(1 - eff.pAtMostObserved).toBeCloseTo(0.5, 2); // effect at the bar passes half the time
  expect(1 - nul.pAtMostObserved).toBeLessThan(0.25);
  // two reads (same arm block) against one baseline in an earlier block: tau adds drift, so the pass rate rises
  const fb: NullRead = { ...one, baselineGroup: "fb", armBlock: "K2", ctlBlock: "K1" };
  const t0 = sharedBaselinePassCounts([fb, fb], 1.5, 1, 200_000, 5, 0), t1 = sharedBaselinePassCounts([fb, fb], 1.5, 1, 200_000, 5, 1);
  expect(1 - t1.pAtMostObserved).toBeGreaterThan(1 - t0.pAtMostObserved);
  // tau is ignored for same-block reads
  const sb = sharedBaselinePassCounts([one], 1.5, 0, 200_000, 3, 1);
  expect(sb.pAtMostObserved).toBeCloseTo(nul.pAtMostObserved, 2);
});

test("drift is one value per physical block: A-vs-B then C-vs-A both pass with probability 1/6 (correlation -1/2)", () => {
  // no sampling noise, tau 1, bar 0: both pass iff B <= A <= C for three iid block drifts
  const r1: NullRead = { drawsArm: 1, drawsCtl: 1, bar: 0, baselineGroup: null, armBlock: "A", ctlBlock: "B" };
  const r2: NullRead = { drawsArm: 1, drawsCtl: 1, bar: 0, baselineGroup: null, armBlock: "C", ctlBlock: "A" };
  const both = 1 - sharedBaselinePassCounts([r1, r2], 0, 1, 300_000, 11, 1).pAtMostObserved;
  expect(both).toBeCloseTo(1 / 6, 2);
});
