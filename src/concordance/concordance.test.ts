import { test, expect } from "bun:test";
import { pairStages, concordanceTable, alwaysGuessModeBaseline, positivePredictiveValue, type Read } from "./concordance";

const ORDER = ["screen", "flaky10", "platform"];

test("pairStages produces every stage combination for each variant, in the order given", () => {
  const reads: Read[] = [
    { variant: "A", stage: "screen", verdict: "positive" },
    { variant: "A", stage: "flaky10", verdict: "null" },
    { variant: "A", stage: "platform", verdict: "null" },
  ];
  const pairs = pairStages(reads, ORDER);
  expect(pairs.map((p) => `${p.from}->${p.to}`)).toEqual(["screen->flaky10", "screen->platform", "flaky10->platform"]);
});

test("pairStages marks adjacent correctly (consecutive in stageOrder vs skipping one)", () => {
  const reads: Read[] = [
    { variant: "A", stage: "screen", verdict: "positive" },
    { variant: "A", stage: "platform", verdict: "null" },
  ];
  const [pair] = pairStages(reads, ORDER);
  expect(pair.adjacent).toBe(false);
});

test("pairStages only uses the FIRST read at a stage when several exist for the same variant", () => {
  const reads: Read[] = [
    { variant: "A", stage: "screen", verdict: "positive" },
    { variant: "A", stage: "screen", verdict: "negative" }, // a later/replication read — ignored
    { variant: "A", stage: "flaky10", verdict: "null" },
  ];
  const [pair] = pairStages(reads, ORDER);
  expect(pair.fromVerdict).toBe("positive");
});

test("pairStages treats a designated unknownVerdict as undeterminable, not a false disagreement", () => {
  const reads: Read[] = [
    { variant: "A", stage: "screen", verdict: "unknown" },
    { variant: "A", stage: "flaky10", verdict: "null" },
  ];
  const [pair] = pairStages(reads, ORDER, "unknown");
  expect(pair.agreeExact).toBeNull();
});

test("concordanceTable counts exact agreement and builds the cell breakdown", () => {
  const reads: Read[] = [
    { variant: "A", stage: "flaky10", verdict: "null" }, { variant: "A", stage: "platform", verdict: "null" },
    { variant: "B", stage: "flaky10", verdict: "positive" }, { variant: "B", stage: "platform", verdict: "null" },
    { variant: "C", stage: "flaky10", verdict: "positive" }, { variant: "C", stage: "platform", verdict: "positive" },
  ];
  const pairs = pairStages(reads, ORDER);
  const table = concordanceTable(pairs, "flaky10", "platform");
  expect(table.determinable).toBe(3);
  expect(table.agreeing).toBe(2);
  expect(table.agreementRate).toBeCloseTo(2 / 3, 6);
  expect(table.cells).toEqual({ "null->null": 1, "positive->null": 1, "positive->positive": 1 });
});

test("concordanceTable reports an unknown count separately from determinable", () => {
  const reads: Read[] = [
    { variant: "A", stage: "flaky10", verdict: "unknown" }, { variant: "A", stage: "platform", verdict: "null" },
    { variant: "B", stage: "flaky10", verdict: "null" }, { variant: "B", stage: "platform", verdict: "null" },
  ];
  const pairs = pairStages(reads, ORDER, "unknown");
  const table = concordanceTable(pairs, "flaky10", "platform");
  expect(table.pairs).toBe(2);
  expect(table.determinable).toBe(1);
  expect(table.unknown).toBe(1);
});

test("alwaysGuessModeBaseline picks the most common `to` verdict and scores against it", () => {
  const reads: Read[] = [
    { variant: "A", stage: "flaky10", verdict: "positive" }, { variant: "A", stage: "platform", verdict: "null" },
    { variant: "B", stage: "flaky10", verdict: "positive" }, { variant: "B", stage: "platform", verdict: "null" },
    { variant: "C", stage: "flaky10", verdict: "null" }, { variant: "C", stage: "platform", verdict: "positive" },
  ];
  const pairs = pairStages(reads, ORDER);
  const baseline = alwaysGuessModeBaseline(pairs, "flaky10", "platform");
  expect(baseline.mostCommonToVerdict).toBe("null");
  expect(baseline.constantGuessCorrect).toBe(2);
  expect(baseline.determinable).toBe(3);
});

test("alwaysGuessModeBaseline returns null mode on an empty subset", () => {
  const baseline = alwaysGuessModeBaseline([], "flaky10", "platform");
  expect(baseline.mostCommonToVerdict).toBeNull();
  expect(baseline.determinable).toBe(0);
});

test("positivePredictiveValue finds variants with a later, confirmed positive", () => {
  const reads: Read[] = [
    { variant: "A", stage: "screen", verdict: "positive" },
    { variant: "A", stage: "flaky10", verdict: "positive" },
    { variant: "B", stage: "screen", verdict: "positive" },
    { variant: "B", stage: "flaky10", verdict: "null" },
  ];
  const ppv = positivePredictiveValue(reads, ORDER, "positive");
  expect(ppv).toHaveLength(2);
  expect(ppv.find((p) => p.variant === "A")?.confirmedLater).toBe(true);
  expect(ppv.find((p) => p.variant === "B")?.confirmedLater).toBe(false);
});

test("positivePredictiveValue skips variants with no later KNOWN-verdict stage", () => {
  const reads: Read[] = [
    { variant: "A", stage: "screen", verdict: "positive" },
    { variant: "A", stage: "flaky10", verdict: "unknown" },
  ];
  expect(positivePredictiveValue(reads, ORDER, "positive", "unknown")).toHaveLength(0);
});

test("positivePredictiveValue skips variants with no positive read at all", () => {
  const reads: Read[] = [
    { variant: "A", stage: "screen", verdict: "null" },
    { variant: "A", stage: "flaky10", verdict: "null" },
  ];
  expect(positivePredictiveValue(reads, ORDER, "positive")).toHaveLength(0);
});
