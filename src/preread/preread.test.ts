import { test, expect } from "bun:test";
import { extractBlock, validate, parseDoc, classify, PreReadError } from "./preread";

const GOOD_BLOCK = `
\`\`\`preread
{
  "hypothesis": "H-EXAMPLE",
  "metric": "resolved",
  "primary": "mean resolved tasks vs the baseline on the cheap screening slate",
  "bands": [
    { "min": 1, "verdict": "supported", "label": "beats baseline by >=1 task" },
    { "min": -1, "verdict": "measured-null", "label": "within noise of baseline" },
    { "min": null, "verdict": "refuted", "label": "worse than baseline" }
  ]
}
\`\`\`
`;

test("extractBlock finds the single preread fence in a larger document", () => {
  const doc = `# Some doc\n\nprose prose\n${GOOD_BLOCK}\nmore prose`;
  expect(JSON.parse(extractBlock(doc)).hypothesis).toBe("H-EXAMPLE");
});

test("extractBlock throws when no fence is present", () => {
  expect(() => extractBlock("# doc with no preread block")).toThrow(PreReadError);
});

test("extractBlock throws when two fences are present", () => {
  expect(() => extractBlock(GOOD_BLOCK + GOOD_BLOCK)).toThrow(/exactly one/);
});

test("parseDoc round-trips a valid document", () => {
  const pre = parseDoc(GOOD_BLOCK);
  expect(pre.hypothesis).toBe("H-EXAMPLE");
  expect(pre.bands).toHaveLength(3);
});

test("parseDoc checks hypothesis against a known-id registry when given one", () => {
  expect(() => parseDoc(GOOD_BLOCK, new Set(["H-OTHER"]))).toThrow(/unknown hypothesis/);
  expect(parseDoc(GOOD_BLOCK, new Set(["H-EXAMPLE"]))).toBeTruthy();
});

test("parseDoc checks metric against a known-metrics registry when given one", () => {
  expect(() => parseDoc(GOOD_BLOCK, null, new Set(["other-metric"]))).toThrow(/unknown metric/);
  expect(parseDoc(GOOD_BLOCK, null, new Set(["resolved"]))).toBeTruthy();
});

test("rejects a hypothesis id that doesn't match the H-XXX convention", () => {
  const raw = { hypothesis: "not-an-id", metric: "resolved", primary: "x", bands: [{ min: 0, verdict: "supported", label: "a" }, { min: null, verdict: "refuted", label: "b" }] };
  expect(() => validate(raw)).toThrow(/hypothesis must be an id/);
});

test("rejects a band with verdict 'confirmed' — a pre-registered read may never claim it", () => {
  const raw = { hypothesis: "H-X", metric: "resolved", primary: "x", bands: [{ min: 0, verdict: "confirmed", label: "a" }, { min: null, verdict: "refuted", label: "b" }] };
  expect(() => validate(raw)).toThrow(/may never claim/);
});

test("rejects bands with no catch-all", () => {
  const raw = { hypothesis: "H-X", metric: "resolved", primary: "x", bands: [{ min: 1, verdict: "supported", label: "a" }, { min: -1, verdict: "refuted", label: "b" }] };
  expect(() => validate(raw)).toThrow(/catch-all/);
});

test("rejects bands with two catch-alls", () => {
  const raw = { hypothesis: "H-X", metric: "resolved", primary: "x", bands: [{ min: null, verdict: "supported", label: "a" }, { min: null, verdict: "refuted", label: "b" }] };
  expect(() => validate(raw)).toThrow(/exactly one band/);
});

test("rejects a catch-all that isn't last", () => {
  const raw = { hypothesis: "H-X", metric: "resolved", primary: "x", bands: [{ min: null, verdict: "refuted", label: "a" }, { min: 1, verdict: "supported", label: "b" }] };
  expect(() => validate(raw)).toThrow(/must be the LAST band/);
});

test("rejects bands that are not strictly descending", () => {
  const raw = { hypothesis: "H-X", metric: "resolved", primary: "x", bands: [{ min: 1, verdict: "supported", label: "a" }, { min: 1, verdict: "measured-null", label: "b" }, { min: null, verdict: "refuted", label: "c" }] };
  expect(() => validate(raw)).toThrow(/strictly DESCENDING/);
});

test("rejects bands.length < 2", () => {
  const raw = { hypothesis: "H-X", metric: "resolved", primary: "x", bands: [{ min: null, verdict: "refuted", label: "a" }] };
  expect(() => validate(raw)).toThrow(/at least 2 entries/);
});

test("accepts a void_if string and carries it through", () => {
  const pre = parseDoc(GOOD_BLOCK.replace('"primary": "mean resolved tasks vs the baseline on the cheap screening slate",', '"primary": "x", "void_if": "fewer than 3 draws completed",'));
  expect(pre.void_if).toBe("fewer than 3 draws completed");
});

test("classify matches the first band whose min is <= the value, top-down", () => {
  const pre = parseDoc(GOOD_BLOCK);
  expect(classify(pre.bands, 3).verdict).toBe("supported");
  expect(classify(pre.bands, 1).verdict).toBe("supported");
  expect(classify(pre.bands, 0).verdict).toBe("measured-null");
  expect(classify(pre.bands, -1).verdict).toBe("measured-null");
  expect(classify(pre.bands, -2).verdict).toBe("refuted");
});

test("classify always matches on a validated PreRead (catch-all covers everything below)", () => {
  const pre = parseDoc(GOOD_BLOCK);
  expect(classify(pre.bands, -1000).verdict).toBe("refuted");
});
