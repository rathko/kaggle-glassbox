import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordRunEnd, assertRepairAllowed, recordRepair, readability, sealRead, artifactHash, attributionHash } from "./score-gate";

function run(checks: Record<string, boolean>) {
  const d = mkdtempSync(join(tmpdir(), "score-gate-"));
  mkdirSync(join(d, "patches")); mkdirSync(join(d, "capture"));
  writeFileSync(join(d, "task_results.jsonl"), JSON.stringify({ instance_id: "t1", resolved: true }) + "\n");
  writeFileSync(join(d, "patches", "t1.patch"), "diff\n");
  const c = Object.fromEntries(Object.entries(checks).map(([k, ok]) => [k, { ok, detail: k }]));
  writeFileSync(join(d, "instruments.json"), JSON.stringify({ checks: c }));
  recordRunEnd(d, c);
  return { d, c };
}
const fixNow = (d: string, c: any, k: string) => { c[k].ok = true; writeFileSync(join(d, "instruments.json"), JSON.stringify({ checks: c })); };

test("run-end record is written once and never overwritten", () => {
  const { d } = run({ rows: true, capture: false });
  expect(recordRunEnd(d, { rows: { ok: true, detail: "" }, capture: { ok: true, detail: "" } })).toBe(false);
  expect(readability(d).ok).toBe(false);
});

test("rows and stack are never repairable", () => {
  const { d } = run({ rows: false, stack: true });
  expect(() => assertRepairAllowed(d, "rows")).toThrow(/not repairable/);
  expect(() => assertRepairAllowed(d, "stack")).toThrow(/not repairable/);
});

test("a valid pre-read repair makes the run readable", () => {
  const { d, c } = run({ rows: true, stack: true, capture: false });
  assertRepairAllowed(d, "capture");
  fixNow(d, c, "capture"); recordRepair(d, "capture", "test", true, "43/43");
  expect(readability(d)).toEqual({ ok: true, reasons: [] });
});

test("no repair after a score was read", () => {
  const { d } = run({ rows: true, analysis: false });
  sealRead(d, "test");
  expect(existsSync(join(d, "score-read.json"))).toBe(true);
  expect(() => assertRepairAllowed(d, "analysis")).toThrow(/already been read/);
});

test("no repair, and not readable, if raw artifacts changed since run end", () => {
  const { d, c } = run({ rows: true, capture: false });
  const before = artifactHash(d);
  writeFileSync(join(d, "patches", "t1.patch"), "diff changed\n");
  expect(artifactHash(d)).not.toBe(before);
  expect(() => assertRepairAllowed(d, "capture")).toThrow(/artifacts changed/);
  fixNow(d, c, "capture"); recordRepair(d, "capture", "test", true, "x");
  expect(readability(d).ok).toBe(false);
});

test("a repair that did not succeed does not admit the run", () => {
  const { d } = run({ rows: true, capture: false });
  recordRepair(d, "capture", "test", false, "still failing");
  expect(readability(d).ok).toBe(false);
});

test("wiring: this package's own reader gates before sealing before printing, and repair goes through score-gate", async () => {
  const B = import.meta.dir;
  const reader = await Bun.file(join(B, "score-reader.ts")).text();
  expect(reader.indexOf("readability(")).toBeLessThan(reader.indexOf("sealRead("));
  expect(reader.indexOf("sealRead(")).toBeLessThan(reader.indexOf("MEAN pass rate"));
  expect(await Bun.file(join(B, "instrument-repair.ts")).text()).toContain("assertRepairAllowed(");
});

test("a run-end record that omits a never-repairable check is not readable", () => {
  const { d } = run({ rows: true, capture: true }); // no stack check
  const r = readability(d);
  expect(r.ok).toBe(false);
  expect(r.reasons).toContain("required check 'stack' is missing from the run-end record");
});

test("editing the capture attribution after run end makes the run unreadable unless a capture repair produced it", () => {
  const { d, c } = run({ rows: true, stack: true, capture: true });
  // run() records run end before any manifest exists; record a fresh run with one
  const d2 = mkdtempSync(join(tmpdir(), "score-gate-"));
  mkdirSync(join(d2, "capture"));
  writeFileSync(join(d2, "task_results.jsonl"), JSON.stringify({ instance_id: "t1", resolved: true }) + "\n");
  writeFileSync(join(d2, "capture", "manifest.json"), JSON.stringify({ k1: { instances: ["A"] }, k2: { instances: ["B"] } }));
  writeFileSync(join(d2, "instruments.json"), JSON.stringify({ checks: c }));
  recordRunEnd(d2, c);
  expect(readability(d2).ok).toBe(true);
  const before = attributionHash(d2);
  writeFileSync(join(d2, "capture", "manifest.json"), JSON.stringify({ k1: { instances: ["B"] }, k2: { instances: ["A"] } }));
  expect(attributionHash(d2)).not.toBe(before);
  expect(artifactHash(d2)).toBe(JSON.parse(require("node:fs").readFileSync(join(d2, "instruments.runend.json"), "utf8")).artifact_hash);
  expect(readability(d2).reasons).toContain("capture attribution changed since run end without a successful capture repair");
  // the same new attribution, produced by a recorded successful capture repair, is admitted
  recordRepair(d2, "capture", "re-attribute", true, "ok");
  expect(readability(d2).ok).toBe(true);
  expect(readability(d).ok).toBe(true);
});

test("stack.json is part of the artifact hash", () => {
  const { d } = run({ rows: true, stack: true });
  const before = artifactHash(d);
  writeFileSync(join(d, "stack.json"), JSON.stringify({ server: "x" }));
  expect(artifactHash(d)).not.toBe(before);
  expect(readability(d).reasons).toContain("raw artifacts changed since run end");
});

test("artifactHash covers artifacts/ recursively: an edited, renamed or added submitted file changes it", () => {
  const { d } = run({ rows: true, stack: true });
  const h0 = artifactHash(d);
  mkdirSync(join(d, "artifacts", "model"), { recursive: true });
  writeFileSync(join(d, "artifacts", "submission.csv"), "id,y\n1,0.5\n");
  writeFileSync(join(d, "artifacts", "model", "weights.bin"), "abc");
  const h1 = artifactHash(d);
  expect(h1).not.toBe(h0);
  writeFileSync(join(d, "artifacts", "submission.csv"), "id,y\n1,0.6\n");
  const h2 = artifactHash(d);
  expect(h2).not.toBe(h1);
  require("node:fs").renameSync(join(d, "artifacts", "model", "weights.bin"), join(d, "artifacts", "model", "weights2.bin"));
  expect(artifactHash(d)).not.toBe(h2);
  expect(artifactHash(d)).toBe(artifactHash(d));
});

test("the artifact hash is framed: moving bytes across a file boundary changes it", () => {
  const mk = (files: Record<string, string>) => {
    const d = mkdtempSync(join(tmpdir(), "score-gate-frame-"));
    mkdirSync(join(d, "patches"));
    for (const [f, c] of Object.entries(files)) writeFileSync(join(d, "patches", f), c);
    return artifactHash(d);
  };
  // unframed, these two feed sha256 the same byte stream: "/patches/a" + "X/patches/bY" vs "/patches/a" + "X" + "/patches/b" + "Y"
  expect(mk({ a: "X/patches/bY" })).not.toBe(mk({ a: "X", b: "Y" }));
});

test("artifacts/ must hold copies: a symlink is refused by the hash and makes the run unreadable", () => {
  const { symlinkSync } = require("node:fs");
  const { d } = run({ rows: true, stack: true });
  mkdirSync(join(d, "artifacts"));
  const target = join(mkdtempSync(join(tmpdir(), "score-gate-tgt-")), "submission.csv");
  writeFileSync(target, "id,y\n1,0.5\n");
  symlinkSync(target, join(d, "artifacts", "submission.csv"));
  expect(() => artifactHash(d)).toThrow(/symlink/);
  const r = readability(d);
  expect(r.ok).toBe(false);
  expect(r.reasons.join(" ")).toMatch(/symlink/);
});

test("an artifact-only record requires artifacts and stack, not rows", () => {
  const d = mkdtempSync(join(tmpdir(), "score-gate-ao-"));
  mkdirSync(join(d, "artifacts"));
  writeFileSync(join(d, "artifacts", "submission.csv"), "id,y\n1,0.5\n");
  recordRunEnd(d, { artifacts: { ok: true, detail: "" }, stack: { ok: true, detail: "" } }, { artifactOnly: true });
  expect(readability(d)).toEqual({ ok: true, reasons: [] });
  writeFileSync(join(d, "artifacts", "submission.csv"), "id,y\n1,0.9\n");
  expect(readability(d).reasons).toContain("raw artifacts changed since run end");
  const e = mkdtempSync(join(tmpdir(), "score-gate-ao-"));
  mkdirSync(join(e, "artifacts")); writeFileSync(join(e, "artifacts", "s.csv"), "x");
  recordRunEnd(e, { stack: { ok: true, detail: "" } }, { artifactOnly: true });
  expect(readability(e).reasons.join(" ")).toMatch(/required check 'artifacts'/);
});

test("sealRead creates the seal exclusively and returns the existing one, payload intact, on a second call", () => {
  const { d } = run({ rows: true, stack: true });
  const first = sealRead(d, "r1", { score: 1 });
  expect(first.created).toBe(true);
  const second = sealRead(d, "r2", { score: 2 });
  expect(second.created).toBe(false);
  expect(second.record.reader).toBe("r1");
  expect(second.record.read).toEqual({ score: 1 });
});

test("a raw snapshot that appears in capture/ after run end makes the run unreadable", () => {
  const { d } = run({ rows: true, stack: true });
  expect(readability(d).reasons.filter((r) => r.includes("raw snapshot"))).toEqual([]);
  writeFileSync(join(d, "capture", "000099.json"), "{}");
  const r = readability(d);
  expect(r.ok).toBe(false);
  expect(r.reasons.join(" ")).toContain("raw snapshot");
});

test("the hashes do not depend on how the run dir is spelled: ./run-1, run-1, an absolute path and x/../run-1 agree", () => {
  const top = mkdtempSync(join(tmpdir(), "score-gate-spell-"));
  const d = join(top, "run-1");
  mkdirSync(join(d, "patches"), { recursive: true }); mkdirSync(join(d, "capture")); mkdirSync(join(d, "artifacts", "sub"), { recursive: true }); mkdirSync(join(top, "x"));
  writeFileSync(join(d, "task_results.jsonl"), "{}\n");
  writeFileSync(join(d, "patches", "t1.patch"), "diff\n");
  writeFileSync(join(d, "artifacts", "sub", "submission.csv"), "id,y\n");
  writeFileSync(join(d, "capture", "task-index.json"), "{}");
  writeFileSync(join(d, "stack.json"), "{}");
  const cwd = process.cwd();
  try {
    process.chdir(top);
    const spellings = ["./run-1", "run-1", d, "x/../run-1", "run-1/", "./x/../run-1/"];
    expect(new Set(spellings.map((s) => artifactHash(s))).size).toBe(1);
    expect(new Set(spellings.map((s) => attributionHash(s))).size).toBe(1);
  } finally { process.chdir(cwd); }
});

test("recordRunEnd never overwrites a record that appears between its check and its write", () => {
  const d = mkdtempSync(join(tmpdir(), "score-gate-"));
  writeFileSync(join(d, "task_results.jsonl"), "{}\n");
  writeFileSync(join(d, "instruments.runend.json"), '{"first":true}');
  expect(recordRunEnd(d, { rows: { ok: true, detail: "" }, stack: { ok: true, detail: "" } })).toBe(false);
  expect(require("node:fs").readFileSync(join(d, "instruments.runend.json"), "utf8")).toBe('{"first":true}');
});

test("artifactHash streams files in chunks and still gives exactly the whole-file framed hash", async () => {
  const { artifactHash, HASH_CHUNK } = await import("./score-gate");
  const { createHash } = await import("node:crypto");
  const fs = await import("node:fs");
  const d = fs.mkdtempSync(join(require("node:os").tmpdir(), "hash-stream-"));
  fs.mkdirSync(join(d, "artifacts", "sub"), { recursive: true });
  // sizes around the chunk boundary, an empty file, and a multi-chunk file
  const big = Buffer.alloc(2 * HASH_CHUNK + 3); for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 255;
  fs.writeFileSync(join(d, "artifacts", "sub", "model.bin"), big);
  fs.writeFileSync(join(d, "artifacts", "edge.bin"), big.subarray(0, HASH_CHUNK));
  fs.writeFileSync(join(d, "artifacts", "empty.csv"), "");
  fs.writeFileSync(join(d, "task_results.jsonl"), `{"instance_id":"a","resolved":true}\n`);
  fs.writeFileSync(join(d, "stack.json"), "{}");
  // reference: the framing written out by hand, whole files at once
  const h = createHash("sha256");
  const file = (rel: string, b: Buffer) => { const r = Buffer.from(rel); h.update(`file\0${r.length}\0`); h.update(r); h.update(`\0${b.length}\0`); h.update(b); };
  const dir = (rel: string) => { const r = Buffer.from(rel); h.update(`dir\0${r.length}\0`); h.update(r); h.update("\0-\0"); };
  file("task_results.jsonl", fs.readFileSync(join(d, "task_results.jsonl")));
  file("stack.json", Buffer.from("{}"));
  file("artifacts/edge.bin", big.subarray(0, HASH_CHUNK));
  file("artifacts/empty.csv", Buffer.alloc(0));
  dir("artifacts/sub");
  file("artifacts/sub/model.bin", big);
  expect(artifactHash(d)).toBe(h.digest("hex"));
});
