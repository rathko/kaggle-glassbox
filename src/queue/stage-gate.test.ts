import { test, expect } from "bun:test";
import { stageOf, assertAdmissible, appendLedger, type LedgerEntry, type StageSpec } from "./stage-gate";

const STAGES: StageSpec[] = [
  { name: "screen", maxIds: 10 },
  { name: "calibration", maxIds: 10, calibrationSlateBasename: "calibration-slate.txt" },
  { name: "fast-lane", maxIds: 43 },
  { name: "full", maxIds: null },
];
const ORDER = ["screen", "fast-lane", "full"]; // calibration stands outside the gated ladder
const GATED = new Set(["fast-lane", "full"]);

test("stageOf classifies by a calibration-named slate first, regardless of size", () => {
  expect(stageOf(STAGES, "calibration-slate.txt", 5)).toBe("calibration");
});

test("stageOf classifies by size when no calibration name matches", () => {
  expect(stageOf(STAGES, "any-slate.txt", 5)).toBe("screen");
  expect(stageOf(STAGES, "any-slate.txt", 30)).toBe("fast-lane");
  expect(stageOf(STAGES, "any-slate.txt", 1000)).toBe("full");
});

test("stageOf throws when no maxIds: null catch-all exists and nothing matches", () => {
  const noFinal: StageSpec[] = [{ name: "screen", maxIds: 10 }];
  expect(() => stageOf(noFinal, "x.txt", 1000)).toThrow(/no stage matched/);
});

test("ungated stages are always admissible with no ledger lookup", () => {
  const res = assertAdmissible({ hypothesis: "H-A", stage: "screen", stageOrder: ORDER, gatedStages: GATED, ledger: [] });
  expect(res).toBeNull();
});

test("a gated stage with no prior PASS throws, naming the stage that's missing", () => {
  expect(() =>
    assertAdmissible({ hypothesis: "H-A", stage: "fast-lane", stageOrder: ORDER, gatedStages: GATED, ledger: [] }),
  ).toThrow(/no screen PASS is recorded for H-A/);
});

test("a gated stage is admitted once the previous stage's PASS is recorded for the same hypothesis", () => {
  const ledger: LedgerEntry[] = [{ hypothesis: "H-A", stage: "screen", verdict: "pass", at: "t", detail: "ok" }];
  const res = assertAdmissible({ hypothesis: "H-A", stage: "fast-lane", stageOrder: ORDER, gatedStages: GATED, ledger });
  expect(res).toBeNull();
});

test("lineage via funnelFrom admits a descendant hypothesis on its ancestor's PASS", () => {
  const ledger: LedgerEntry[] = [{ hypothesis: "H-ANCESTOR", stage: "screen", verdict: "pass", at: "t", detail: "ok" }];
  const res = assertAdmissible({
    hypothesis: "H-CHILD", stage: "fast-lane", stageOrder: ORDER, gatedStages: GATED, ledger, funnelFrom: "H-ANCESTOR",
  });
  expect(res).toBeNull();
});

test("role: baseline admits without any ledger lookup and logs a baseline entry", () => {
  const res = assertAdmissible({ hypothesis: "H-A", stage: "full", stageOrder: ORDER, gatedStages: GATED, ledger: [], role: "baseline" });
  expect(res).toEqual({ hypothesis: "H-A", stage: "full", verdict: "baseline", detail: "role: baseline (calibration of an existing package)" });
});

test("a skip reason under 20 characters is rejected", () => {
  expect(() =>
    assertAdmissible({ hypothesis: "H-A", stage: "fast-lane", stageOrder: ORDER, gatedStages: GATED, ledger: [], skipReason: "too short" }),
  ).toThrow(/needs to be real/);
});

test("a real skip reason admits and logs a skip entry", () => {
  const res = assertAdmissible({
    hypothesis: "H-A", stage: "fast-lane", stageOrder: ORDER, gatedStages: GATED, ledger: [],
    skipReason: "deliberate exception, discussed with the team on 2026-01-01",
  });
  expect(res?.verdict).toBe("skip");
  expect(res?.detail).toContain("deliberate exception");
});

test("a FAIL at the previous stage does not admit — only PASS counts", () => {
  const ledger: LedgerEntry[] = [{ hypothesis: "H-A", stage: "screen", verdict: "fail", at: "t", detail: "no" }];
  expect(() =>
    assertAdmissible({ hypothesis: "H-A", stage: "fast-lane", stageOrder: ORDER, gatedStages: GATED, ledger }),
  ).toThrow(/no screen PASS/);
});

test("appendLedger is a pure append, not a mutation", () => {
  const ledger: LedgerEntry[] = [{ hypothesis: "H-A", stage: "screen", verdict: "pass", at: "t", detail: "ok" }];
  const next = appendLedger(ledger, { hypothesis: "H-B", stage: "screen", verdict: "pass", detail: "ok" }, "t2");
  expect(ledger).toHaveLength(1);
  expect(next).toHaveLength(2);
  expect(next[1]).toEqual({ hypothesis: "H-B", stage: "screen", verdict: "pass", detail: "ok", at: "t2" });
});
