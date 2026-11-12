import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordRunEnd, lockRuns } from "./score-gate";

const READER = join(import.meta.dir, "score-reader.ts");
function run(rows: string) {
  const d = mkdtempSync(join(tmpdir(), "score-reader-"));
  writeFileSync(join(d, "task_results.jsonl"), rows);
  recordRunEnd(d, { rows: { ok: true, detail: "" }, stack: { ok: true, detail: "" }, capture: { ok: true, detail: "" } });
  const p = Bun.spawnSync(["bun", READER, d]);
  return { d, code: p.exitCode, out: p.stdout.toString() };
}

test("a valid run is sealed, then scored (booleans and 1/0 both count)", () => {
  const r = run(`{"instance_id":"a","resolved":true}\n{"instance_id":"b","resolved":0}\n{"instance_id":"c","resolved":1}\n`);
  expect(r.code).toBe(0);
  expect(r.out).toContain("2/3 resolved");
  expect(existsSync(join(r.d, "score-read.json"))).toBe(true);
});

test("a malformed row or a wrong outcome type stops the read BEFORE the seal", () => {
  for (const rows of [`{"instance_id":"a","resolved":true}\nnot json\n`, `{"instance_id":"a","resolved":"yes"}\n`, `{"resolved":true}\n`,
    `{"instance_id":"a","resolved":true}\n{"instance_id":"a","resolved":true}\n`, `{"instance_id":{"x":1},"resolved":true}\n`, `{"instance_id":"","resolved":true}\n`]) {
    const r = run(rows);
    expect(r.code).toBe(1);
    expect(r.out).toContain("nothing sealed");
    expect(existsSync(join(r.d, "score-read.json"))).toBe(false);
  }
});

test("a run-end record without the never-repairable checks is not readable", () => {
  const d = mkdtempSync(join(tmpdir(), "score-reader-"));
  writeFileSync(join(d, "task_results.jsonl"), `{"instance_id":"a","resolved":true}\n`);
  recordRunEnd(d, { capture: { ok: true, detail: "" } });
  const p = Bun.spawnSync(["bun", READER, d]);
  expect(p.exitCode).toBe(1);
  expect(p.stdout.toString()).toContain("required check 'rows' is missing");
  expect(existsSync(join(d, "score-read.json"))).toBe(false);
});

test("a run with only a mutable instruments.json is refused unless --allow-legacy is given", () => {
  const d = mkdtempSync(join(tmpdir(), "score-reader-"));
  writeFileSync(join(d, "instruments.json"), JSON.stringify({ checks: { rows: { ok: true }, stack: { ok: true } } }));
  writeFileSync(join(d, "task_results.jsonl"), `{"instance_id":"a","resolved":true}\n`);
  const refused = Bun.spawnSync(["bun", READER, d]);
  expect(refused.exitCode).toBe(1);
  expect(refused.stdout.toString()).toContain("no run-end record");
  expect(existsSync(join(d, "score-read.json"))).toBe(false);
  const legacy = Bun.spawnSync(["bun", READER, d, "--allow-legacy"]);
  expect(legacy.exitCode).toBe(0);
  expect(legacy.stdout.toString()).toContain("1/1 resolved");
});

test("rows edited after the run-end record cannot be scored", () => {
  const r = run(`{"instance_id":"a","resolved":false}\n`);
  const d = mkdtempSync(join(tmpdir(), "score-reader-"));
  writeFileSync(join(d, "task_results.jsonl"), `{"instance_id":"a","resolved":false}\n`);
  recordRunEnd(d, { rows: { ok: true, detail: "" }, stack: { ok: true, detail: "" } });
  writeFileSync(join(d, "task_results.jsonl"), `{"instance_id":"a","resolved":true}\n`);
  const p = Bun.spawnSync(["bun", READER, d]);
  expect(r.code).toBe(0);
  expect(p.exitCode).toBe(1);
  expect(p.stdout.toString()).toContain("raw artifacts changed since run end");
});

test("the seal binds the fields read: a second read with another outcome field is refused", () => {
  const d = mkdtempSync(join(tmpdir(), "score-reader-"));
  writeFileSync(join(d, "task_results.jsonl"), `{"instance_id":"a","resolved":true,"strict":false}\n{"instance_id":"b","resolved":true,"strict":true}\n`);
  recordRunEnd(d, { rows: { ok: true, detail: "" }, stack: { ok: true, detail: "" } });
  const first = Bun.spawnSync(["bun", READER, d]);
  expect(first.stdout.toString()).toContain("2/2 resolved");
  const again = Bun.spawnSync(["bun", READER, d]);
  expect(again.exitCode).toBe(0);
  const other = Bun.spawnSync(["bun", READER, d, "--outcome-field", "strict"]);
  expect(other.exitCode).toBe(1);
  expect(other.stdout.toString()).toContain("SEALED READ DIFFERS");
  expect(other.stdout.toString()).not.toContain("1/2");
});

test("runs that score different task sets are refused unless --mixed-slates", () => {
  const mk = (ids: string[]) => { const d = mkdtempSync(join(tmpdir(), "score-reader-")); writeFileSync(join(d, "task_results.jsonl"), ids.map((i) => JSON.stringify({ instance_id: i, resolved: true })).join("\n") + "\n"); recordRunEnd(d, { rows: { ok: true, detail: "" }, stack: { ok: true, detail: "" } }); return d; };
  const a = mk(["t1", "t2"]), b = mk(["t1", "t3"]);
  const p = Bun.spawnSync(["bun", READER, a, b]);
  expect(p.exitCode).toBe(1);
  expect(p.stdout.toString()).toContain("DIFFERENT TASK SETS");
  expect(existsSync(join(a, "score-read.json"))).toBe(false);
  expect(Bun.spawnSync(["bun", READER, a, b, "--mixed-slates"]).exitCode).toBe(0);
});

test("a batch with one conflicting seal seals none of its other runs", () => {
  const mk = () => { const d = mkdtempSync(join(tmpdir(), "score-reader-")); writeFileSync(join(d, "task_results.jsonl"), `{"instance_id":"t1","resolved":true,"strict":false}\n`); recordRunEnd(d, { rows: { ok: true, detail: "" }, stack: { ok: true, detail: "" } }); return d; };
  const fresh = mk(), sealed = mk();
  expect(Bun.spawnSync(["bun", READER, sealed, "--outcome-field", "strict"]).exitCode).toBe(0);
  const p = Bun.spawnSync(["bun", READER, fresh, sealed]);
  expect(p.exitCode).toBe(1);
  expect(existsSync(join(fresh, "score-read.json"))).toBe(false);
});

test("a seal that recorded no read (older or custom reader) blocks a new score", () => {
  const d = mkdtempSync(join(tmpdir(), "score-reader-"));
  writeFileSync(join(d, "task_results.jsonl"), `{"instance_id":"a","resolved":true}\n`);
  recordRunEnd(d, { rows: { ok: true, detail: "" }, stack: { ok: true, detail: "" } });
  writeFileSync(join(d, "score-read.json"), JSON.stringify({ at: "x", reader: "custom" }));
  const p = Bun.spawnSync(["bun", READER, d]);
  expect(p.exitCode).toBe(1);
  expect(p.stdout.toString()).toContain("recorded no read");
});

test("a run another reader holds locked is refused with nothing sealed; the lock is released after every read", () => {
  const mk = () => { const d = mkdtempSync(join(tmpdir(), "score-reader-lock-")); writeFileSync(join(d, "task_results.jsonl"), `{"instance_id":"t1","resolved":true}\n`); recordRunEnd(d, { rows: { ok: true, detail: "" }, stack: { ok: true, detail: "" } }); return d; };
  const a = mk(), b = mk();
  writeFileSync(join(b, "score-read.lock"), "{}\n");
  const p = Bun.spawnSync(["bun", READER, a, b]);
  expect(p.exitCode).toBe(1);
  expect(p.stdout.toString()).toContain("being read by another reader");
  // the batch took no lock it kept and sealed nothing, not even the unlocked run
  expect(existsSync(join(a, "score-read.lock"))).toBe(false);
  expect(existsSync(join(a, "score-read.json"))).toBe(false);
  rmSync(join(b, "score-read.lock"));
  expect(Bun.spawnSync(["bun", READER, a, b]).exitCode).toBe(0);
  for (const d of [a, b]) expect(existsSync(join(d, "score-read.lock"))).toBe(false);
  // a failed read releases its locks too
  const bad = Bun.spawnSync(["bun", READER, a, "--outcome-field", "strict"]);
  expect(bad.exitCode).toBe(1);
  expect(existsSync(join(a, "score-read.lock"))).toBe(false);
});

test("lockRuns takes locks in sorted order, refuses an already-locked run holding nothing, and releases only its own", () => {
  const a = mkdtempSync(join(tmpdir(), "lock-a-")), b = mkdtempSync(join(tmpdir(), "lock-b-"));
  const release = lockRuns([b, a, a]);
  expect(existsSync(join(a, "score-read.lock")) && existsSync(join(b, "score-read.lock"))).toBe(true);
  expect(() => lockRuns([a])).toThrow(/another reader/);
  release();
  expect(existsSync(join(a, "score-read.lock")) || existsSync(join(b, "score-read.lock"))).toBe(false);
  writeFileSync(join(b, "score-read.lock"), "{}\n");
  expect(() => lockRuns([a, b])).toThrow(/another reader/);
  expect(existsSync(join(a, "score-read.lock"))).toBe(false);
  expect(existsSync(join(b, "score-read.lock"))).toBe(true);
});

test("--outcome-kind numeric: finite per-task numbers, aggregated, with kind and aggregate sealed", () => {
  const mk = (rows: string) => {
    const d = mkdtempSync(join(tmpdir(), "score-reader-num-"));
    writeFileSync(join(d, "task_results.jsonl"), rows);
    recordRunEnd(d, { rows: { ok: true, detail: "" }, stack: { ok: true, detail: "" }, capture: { ok: true, detail: "" } });
    return d;
  };
  const read = (d: string, ...extra: string[]) => { const p = Bun.spawnSync(["bun", READER, d, ...extra]); return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }; };
  const d = mk(`{"instance_id":"a","score":0.5}\n{"instance_id":"b","score":0.25}\n`);
  // the binary default refuses a partial-credit row, nothing sealed
  expect(read(d, "--outcome-field", "score").out).toContain("must be true/false or 1/0");
  expect(existsSync(join(d, "score-read.json"))).toBe(false);
  const r = read(d, "--outcome-field", "score", "--outcome-kind", "numeric");
  expect(r.code).toBe(0);
  expect(r.out).toContain("mean score 0.375 over 2");
  const seal = JSON.parse(require("node:fs").readFileSync(join(d, "score-read.json"), "utf8"));
  expect(seal.read).toEqual({ taskField: "instance_id", outcomeField: "score", outcomeKind: "numeric", aggregate: "mean", value: 0.375, total: 2,
    rowsSha256: require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(join(d, "task_results.jsonl"))).digest("hex") });
  // the same read again is fine; another aggregate over the sealed run is refused
  expect(read(d, "--outcome-field", "score", "--outcome-kind", "numeric").code).toBe(0);
  const sum = read(d, "--outcome-field", "score", "--outcome-kind", "numeric", "--aggregate", "sum");
  expect(sum.code).toBe(1);
  expect(sum.out).toContain("SEALED READ DIFFERS");
  // non-finite or boolean outcomes are refused before any seal
  for (const rows of [`{"instance_id":"a","score":true}\n`, `{"instance_id":"a","score":"0.5"}\n`, `{"instance_id":"a"}\n`]) {
    const e = mk(rows);
    expect(read(e, "--outcome-field", "score", "--outcome-kind", "numeric").out).toContain("must be a finite number");
    expect(existsSync(join(e, "score-read.json"))).toBe(false);
  }
  // usage errors
  expect(read(d, "--outcome-kind", "fuzzy").code).toBe(2);
  expect(read(d, "--aggregate", "sum").code).toBe(2);
});

test("--outcome-kind numeric: a mean does not overflow, and a non-finite sum is refused before any seal", () => {
  const mk = (rows: string) => {
    const d = mkdtempSync(join(tmpdir(), "score-reader-big-"));
    writeFileSync(join(d, "task_results.jsonl"), rows);
    recordRunEnd(d, { rows: { ok: true, detail: "" }, stack: { ok: true, detail: "" }, capture: { ok: true, detail: "" } });
    return d;
  };
  const read = (d: string, ...extra: string[]) => { const p = Bun.spawnSync(["bun", READER, d, "--outcome-field", "score", "--outcome-kind", "numeric", ...extra]); return { code: p.exitCode, out: p.stdout.toString() }; };
  const rows = `{"instance_id":"a","score":1e308}\n{"instance_id":"b","score":1e308}\n`;
  const m = mk(rows), r = read(m);
  expect(r.code).toBe(0);
  const seal = JSON.parse(require("node:fs").readFileSync(join(m, "score-read.json"), "utf8"));
  expect(seal.read.value).toBe(1e308); // the printed number and the seal agree, no Infinity/null
  expect(r.out).toContain("mean score 1e+308");
  const s = mk(rows), sum = read(s, "--aggregate", "sum");
  expect(sum.code).toBe(1);
  expect(sum.out).toContain("NON-FINITE sum");
  expect(existsSync(join(s, "score-read.json"))).toBe(false);
  // three rows at Number.MAX_VALUE: the old fallback (sum of x/3) overflowed and refused a finite mean (round 15)
  const big = mk(["a", "b", "c"].map((id) => JSON.stringify({ instance_id: id, score: Number.MAX_VALUE })).join("\n") + "\n"), rb = read(big);
  expect(rb.code).toBe(0);
  expect(JSON.parse(require("node:fs").readFileSync(join(big, "score-read.json"), "utf8")).read.value).toBe(Number.MAX_VALUE);
});

test("the same run named twice (an alias, a symlink) is a usage error, so it cannot be weighted twice", () => {
  const mk = (ok: boolean) => { const d = mkdtempSync(join(tmpdir(), "score-reader-")); writeFileSync(join(d, "task_results.jsonl"), JSON.stringify({ instance_id: "t1", resolved: ok }) + "\n"); recordRunEnd(d, { rows: { ok: true, detail: "" }, stack: { ok: true, detail: "" } }); return d; };
  const a = mk(true), b = mk(false);
  const link = join(mkdtempSync(join(tmpdir(), "score-reader-link-")), "a-alias");
  require("node:fs").symlinkSync(a, link);
  for (const alias of [`${a}/`, join(a, "."), link]) {
    const p = Bun.spawnSync(["bun", READER, a, alias, b]);
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain("named more than once");
    expect(existsSync(join(a, "score-read.json"))).toBe(false);
    expect(existsSync(join(b, "score-read.json"))).toBe(false);
  }
  const ok = Bun.spawnSync(["bun", READER, a, b]);
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout.toString()).toContain("MEAN pass rate 50.00% across n=2 run(s)");
});

test("the integrity check hashes the exact row bytes the reader parses, not whatever is on disk a moment later", async () => {
  const { readability } = await import("./score-gate");
  const d = mkdtempSync(join(tmpdir(), "score-reader-retained-"));
  const sealed = Buffer.from(`{"instance_id":"a","resolved":false}\n`);
  writeFileSync(join(d, "task_results.jsonl"), sealed);
  recordRunEnd(d, { rows: { ok: true, detail: "" }, stack: { ok: true, detail: "" } });
  // a late write lands after the reader took its copy: the retained bytes still verify, and they are what gets scored
  writeFileSync(join(d, "task_results.jsonl"), `{"instance_id":"a","resolved":true}\n`);
  expect(readability(d, { retained: new Map([["task_results.jsonl", sealed]]) }).ok).toBe(true);
  // ...and bytes the record never covered never verify, whatever sits on disk
  expect(readability(d, { retained: new Map([["task_results.jsonl", Buffer.from(`{"instance_id":"a","resolved":true}\n`)]]) }).reasons)
    .toContain("raw artifacts changed since run end");
});

test("the seal records the sha256 of the row bytes read; a seal written before that field existed still matches on the rest", () => {
  const rows = `{"instance_id":"a","resolved":true}\n{"instance_id":"b","resolved":false}\n`;
  const r = run(rows);
  expect(r.code).toBe(0);
  const seal = JSON.parse(require("node:fs").readFileSync(join(r.d, "score-read.json"), "utf8"));
  expect(seal.read.rowsSha256).toBe(require("node:crypto").createHash("sha256").update(rows).digest("hex"));
  // an older seal: same fields and counts, no digest -> the same read is still allowed
  const d = mkdtempSync(join(tmpdir(), "score-reader-oldseal-"));
  writeFileSync(join(d, "task_results.jsonl"), rows);
  recordRunEnd(d, { rows: { ok: true, detail: "" }, stack: { ok: true, detail: "" } });
  writeFileSync(join(d, "score-read.json"), JSON.stringify({ at: "x", reader: "old", read: { taskField: "instance_id", outcomeField: "resolved", passed: 1, total: 2 } }));
  const again = Bun.spawnSync(["bun", READER, d]);
  expect(again.exitCode).toBe(0);
  expect(again.stdout.toString()).toContain("1/2 resolved");
  // a seal that carries a digest must match it exactly
  writeFileSync(join(d, "score-read.json"), JSON.stringify({ at: "x", reader: "new", read: { taskField: "instance_id", outcomeField: "resolved", passed: 1, total: 2, rowsSha256: "0".repeat(64) } }));
  const other = Bun.spawnSync(["bun", READER, d]);
  expect(other.exitCode).toBe(1);
  expect(other.stdout.toString()).toContain("SEALED READ DIFFERS");
});
