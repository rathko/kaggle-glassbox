import { describe, expect, test } from "bun:test";
import { byRun, makeRunLoader, runKeyCollisions, spreadSample } from "./state-rows";

test("rows sort by corpus, then run, then seq, never by a concatenated key", () => {
  const rows = [
    { corpus: "ab", run: "c", seq: 1, id: "ab/c#1" },
    { corpus: "a", run: "bc", seq: 1, id: "a/bc#1" },
    { corpus: "a", run: "bc", seq: 2, id: "a/bc#2" },
    { corpus: "ab", run: "c", seq: 2, id: "ab/c#2" },
  ];
  // "a"+"bc" and "ab"+"c" are both "abc": the old key interleaved the two runs by seq
  expect([...rows].sort(byRun).map((r) => r.id)).toEqual(["a/bc#1", "a/bc#2", "ab/c#1", "ab/c#2"]);
});

test("two runs that print as the same corpus/run are reported, one run repeated is not", () => {
  expect(runKeyCollisions([{ corpus: "a/b", run: "c" }, { corpus: "a", run: "b/c" }])).toHaveLength(1);
  expect(runKeyCollisions([{ corpus: "a", run: "b" }, { corpus: "a", run: "b" }, { corpus: "a", run: "c" }])).toEqual([]);
});

test("an ambiguous call between two identical flagged calls breaks the repeat: the second one is a new onset", async () => {
  const { candidateRows } = await import("./state-rows");
  const rows = [
    { corpus: "c", run: "r", seq: 3, fingerprint: "A", flagged: true },
    { corpus: "c", run: "r", seq: 1, fingerprint: "A", flagged: true },
    { corpus: "c", run: "r", seq: 2, fingerprint: "B", ambiguous: true },
    { corpus: "c", run: "r", seq: 4, fingerprint: "A", flagged: true },
  ];
  const got = candidateRows(rows).map(({ row, repeat }) => [row.seq, repeat]);
  // seq 2 is never returned (ambiguous), but it still separates seq 1 from seq 3; seq 4 repeats seq 3
  expect(got).toEqual([[1, false], [3, false], [4, true]]);
});

test("spreadSample picks exactly n items across the whole list, never a prefix", () => {
  const xs = Array.from({ length: 100 }, (_, i) => i);
  const s = spreadSample(xs, 60);
  expect(s.length).toBe(60);
  expect(new Set(s).size).toBe(60);
  expect(Math.max(...s)).toBeGreaterThanOrEqual(98); // reaches the last slice (the old rule took 0..59)
  expect(s).toEqual([...s].sort((a, b) => a - b));
  for (const n of [1, 7, 33, 99]) { const t = spreadSample(xs, n); expect(t.length).toBe(n); expect(new Set(t).size).toBe(n); }
  expect(spreadSample(xs, 1)).toEqual([50]);
  expect(spreadSample(xs, 100)).toEqual(xs);
  expect(spreadSample(xs, 500)).toEqual(xs);
  expect(spreadSample(xs, 0)).toEqual([]);
  expect(spreadSample([], 5)).toEqual([]);
});

test("stateRowProblems: string identities, positive seq, no duplicate row; runKey is the one tuple identity", async () => {
  const { stateRowProblems, runKey } = await import("./state-rows");
  const ok = { corpus: "c", run: "r", group: "g", seq: 1, fingerprint: "fp", flagged: false };
  expect(stateRowProblems([ok, { ...ok, seq: 2 }])).toEqual([]);
  // a numeric run 1 and a string run "1" would be one run to repeat detection and two to the run loader
  expect(stateRowProblems([ok, { ...ok, run: 1, seq: 2 }]).join()).toMatch(/line 2: "run" must be a non-empty string, got 1/);
  expect(stateRowProblems([{ ...ok, group: 7 }]).join()).toMatch(/"group" must be a non-empty string/);
  expect(stateRowProblems([{ ...ok, corpus: "" }]).join()).toMatch(/"corpus" must be a non-empty string/);
  for (const seq of [0, -1, 1.5, "1", null]) expect(stateRowProblems([{ ...ok, seq }]).join()).toMatch(/"seq" must be a positive whole number/);
  expect(stateRowProblems([ok, { ...ok, group: "other" }]).join()).toMatch(/line 2: c\/r seq 1 appears twice/);
  expect(stateRowProblems([null, [1]]).length).toBe(2);
  expect(runKey("a", "bc")).not.toBe(runKey("ab", "c"));
});

test("stateRowProblems types the selection fields: a missing fingerprint or a string \"false\" flag is refused", async () => {
  const { stateRowProblems } = await import("./state-rows");
  const ok = { corpus: "c", run: "r", group: "g", seq: 1, fingerprint: "fp", flagged: true };
  expect(stateRowProblems([ok, { ...ok, seq: 2, fingerprint: 7, ambiguous: false, outcome: "success" }, { ...ok, seq: 3, outcome: null }])).toEqual([]);
  // two rows without a fingerprint would compare undefined === undefined and the second distinct call would hide as a repeat
  for (const fingerprint of [undefined, "", null, NaN, {}]) expect(stateRowProblems([{ ...ok, fingerprint }]).join()).toMatch(/"fingerprint" must be a non-empty string or a finite number/);
  for (const flagged of [undefined, "false", 0, 1]) expect(stateRowProblems([{ ...ok, flagged }]).join()).toMatch(/"flagged" must be true or false/);
  expect(stateRowProblems([{ ...ok, ambiguous: "false" }]).join()).toMatch(/"ambiguous" must be true or false when given/);
  expect(stateRowProblems([{ ...ok, outcome: 1 }]).join()).toMatch(/"outcome" must be a string when given/);
});

describe("makeRunLoader with a capture group shared by two runs", () => {
  const row = (run: string, seq: number, group = "g") => ({ corpus: "c", run, group, seq, fingerprint: `f${seq}`, flagged: false });
  const snap = (seq: number) => ({ seq });
  const noCheck = () => {};
  test("each run keeps only its own listed seqs", () => {
    const load = makeRunLoader([row("r1", 1), row("r2", 2)], () => [snap(1), snap(2)], noCheck);
    expect(load("c", "r1").map((x) => x.snap.seq)).toEqual([1]);
    expect(load("c", "r2").map((x) => x.snap.seq)).toEqual([2]);
  });
  test("a snapshot in a shared group that no run lists is refused", () => {
    const load = makeRunLoader([row("r1", 1), row("r2", 2)], () => [snap(1), snap(2), snap(3)], noCheck);
    expect(() => load("c", "r1")).toThrow(/listed for none/);
  });
  test("a group used by one run is taken whole, unlisted calls included", () => {
    const load = makeRunLoader([row("r1", 1)], () => [snap(1), snap(2)], noCheck);
    expect(load("c", "r1").map((x) => x.snap.seq)).toEqual([1, 2]);
  });
  test("an indexed seq missing from its group is refused", () => {
    const load = makeRunLoader([row("r1", 1), row("r1", 5)], () => [snap(1), snap(2)], noCheck);
    expect(() => load("c", "r1")).toThrow(/no such exchange/);
  });
});
