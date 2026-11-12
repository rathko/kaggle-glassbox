import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "capture-compact.ts");

function snap(seq: number, userContent: string) {
  return {
    seq, at: new Date().toISOString(), status: 200, injected: null,
    request: { messages: [{ role: "system", content: "sys" }, { role: "user", content: userContent }] },
    response: { choices: [{ message: { role: "assistant", content: "ok" } }] },
  };
}

test("groups snapshots by first-user-message, compacts to gz, and verifies the round-trip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-compact-"));
  try {
    writeFileSync(join(dir, "000001.json"), JSON.stringify(snap(1, "task A")));
    writeFileSync(join(dir, "000002.json"), JSON.stringify(snap(2, "task A")));
    writeFileSync(join(dir, "000003.json"), JSON.stringify(snap(3, "task B")));

    const p = Bun.spawn(["bun", SCRIPT, dir], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("compacted 2 new task(s) from 3 snapshots");

    const gzFiles = readdirSync(dir).filter((f) => f.endsWith(".jsonl.gz"));
    expect(gzFiles.length).toBe(2);
    // raw files are deleted by default
    expect(readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "manifest.json").length).toBe(0);

    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const twoExchangeGroup = Object.values(manifest).find((m: any) => m.exchanges === 2) as any;
    expect(twoExchangeGroup).toBeTruthy();
    expect(twoExchangeGroup.seq_first).toBe(1);
    expect(twoExchangeGroup.seq_last).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--keep-raw leaves the original snapshot files in place", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-compact-"));
  try {
    writeFileSync(join(dir, "000001.json"), JSON.stringify(snap(1, "task A")));
    const p = Bun.spawn(["bun", SCRIPT, dir, "--keep-raw"], { stdout: "pipe" });
    await p.exited;
    expect(existsSync(join(dir, "000001.json"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--id-pattern recovers a readable guess from the prompt head", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-compact-"));
  try {
    writeFileSync(join(dir, "000001.json"), JSON.stringify(snap(1, "fix bug in widget_42 please")));
    const p = Bun.spawn(["bun", SCRIPT, dir, "--id-pattern", "widget_\\d+"], { stdout: "pipe" });
    await p.exited;
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const entry = Object.values(manifest)[0] as any;
    expect(entry.instance_guess).toBe("widget_42");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tasks that share one first instruction are split by a harness task id, or by --group-by", async () => {
  const same = (seq: number, extra: Record<string, unknown> = {}, sys = "") => ({
    seq, ...extra,
    request: { messages: [{ role: "system", content: sys }, { role: "user", content: "Solve the task." }] },
    response: { choices: [{ message: { role: "assistant", content: "ok" } }] },
  });
  // (1) task_id recorded by wire-tap
  const d1 = mkdtempSync(join(tmpdir(), "compact-tid-"));
  writeFileSync(join(d1, "000001.json"), JSON.stringify(same(1, { task_id: "alpha" })));
  writeFileSync(join(d1, "000002.json"), JSON.stringify(same(2, { task_id: "beta" })));
  writeFileSync(join(d1, "000003.json"), JSON.stringify(same(3, { task_id: "alpha" })));
  expect(await Bun.spawn(["bun", SCRIPT, d1], { stdout: "pipe", stderr: "pipe" }).exited).toBe(0);
  const m1 = JSON.parse(readFileSync(join(d1, "manifest.json"), "utf8"));
  expect(Object.values(m1).map((e: any) => e.instances[0]).sort()).toEqual(["alpha", "beta"]);
  expect(Object.values(m1).find((e: any) => e.task_id === "alpha")).toMatchObject({ exchanges: 2 });
  // (2) --group-by on the system message; without it the three would collapse into one group
  const d2 = mkdtempSync(join(tmpdir(), "compact-gb-"));
  writeFileSync(join(d2, "000001.json"), JSON.stringify(same(1, {}, "id=T1")));
  writeFileSync(join(d2, "000002.json"), JSON.stringify(same(2, {}, "id=T2")));
  writeFileSync(join(d2, "000003.json"), JSON.stringify(same(3, {}, "id=T1")));
  expect(await Bun.spawn(["bun", SCRIPT, d2, "--group-by", "id=(T\\d+)"], { stdout: "pipe", stderr: "pipe" }).exited).toBe(0);
  expect(Object.keys(JSON.parse(readFileSync(join(d2, "manifest.json"), "utf8")))).toHaveLength(2);
  rmSync(d1, { recursive: true, force: true }); rmSync(d2, { recursive: true, force: true });
});

test("a second compaction adds new tasks, merges new exchanges into an existing task archive, and files are owner-only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-compact-"));
  const run = async (...extra: string[]) => { const p = Bun.spawn(["bun", SCRIPT, dir, ...extra], { stdout: "pipe", stderr: "pipe" }); return { code: await p.exited, err: await new Response(p.stderr).text() }; };
  try {
    writeFileSync(join(dir, "000001.json"), JSON.stringify(snap(1, "task A")));
    expect((await run()).code).toBe(0);
    const { statSync } = await import("node:fs");
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    writeFileSync(join(dir, "000002.json"), JSON.stringify(snap(2, "task B")));
    expect((await run()).code).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))).length).toBe(2);
    // more exchanges of task A arrive: merged into A's archive, in seq order, manifest updated, raw files gone
    writeFileSync(join(dir, "000003.json"), JSON.stringify(snap(3, "task A")));
    writeFileSync(join(dir, "000004.json"), JSON.stringify(snap(4, "task A")));
    const r = await run();
    expect(r.code).toBe(0);
    const man = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(Object.keys(man).length).toBe(2);
    const a = Object.entries(man).find(([, m]: any) => m.seq_first === 1)!;
    expect((a[1] as any).exchanges).toBe(3);
    expect((a[1] as any).seq_last).toBe(4);
    const lines = Buffer.from(Bun.gunzipSync(readFileSync(join(dir, `task-${a[0]}.jsonl.gz`)))).toString("utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).seq)).toEqual([1, 3, 4]);
    expect(readdirSync(dir).filter((f) => /^\d+\.json$/.test(f) || f.endsWith(".tmp"))).toEqual([]);
    // a fourth run with nothing new reads every archive and agrees with the manifest
    const again = await run();
    expect(again.code).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one malformed snapshot aborts the whole compaction: nothing is written or deleted", () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-compact-"));
  try {
    writeFileSync(join(dir, "000001.json"), JSON.stringify(snap(1, "task A")));
    writeFileSync(join(dir, "000002.json"), '{"seq": 2, "request": {"messa');
    writeFileSync(join(dir, "000003.json"), "[1,2]");
    const p = Bun.spawnSync(["bun", SCRIPT, dir]);
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain("000002.json");
    expect(p.stderr.toString()).toContain("000003.json");
    expect(readdirSync(dir).sort()).toEqual(["000001.json", "000002.json", "000003.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function compact(dir: string) {
  const p = Bun.spawn(["bun", SCRIPT, dir], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, stdout, stderr };
}

test("a missing, non-positive or duplicate seq refuses the compaction before anything is written or deleted", async () => {
  for (const bad of [[snap(1, "A"), snap(1, "B")], [snap(1, "A"), { ...snap(2, "B"), seq: undefined }], [snap(0, "A")], [snap(1.5 as any, "A")]]) {
    const dir = mkdtempSync(join(tmpdir(), "capture-compact-"));
    try {
      bad.forEach((s, i) => writeFileSync(join(dir, `00000${i + 1}.json`), JSON.stringify(s)));
      const before = readdirSync(dir).sort();
      const r = await compact(dir);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("bad or duplicate seq");
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("a seq already used by an earlier archive is refused on the incremental run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-compact-"));
  try {
    writeFileSync(join(dir, "000001.json"), JSON.stringify(snap(1, "task A")));
    expect((await compact(dir)).code).toBe(0);
    writeFileSync(join(dir, "000002.json"), JSON.stringify(snap(1, "task B")));
    const r = await compact(dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("seq 1 already used by task-");
    expect(existsSync(join(dir, "000002.json"))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an archive that manifest.json does not list (an interrupted run) refuses the merge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-compact-"));
  try {
    writeFileSync(join(dir, "task-aaaaaaaaaaaa.jsonl.gz"), Bun.gzipSync(Buffer.from(JSON.stringify(snap(1, "orphan")) + "\n")));
    writeFileSync(join(dir, "000002.json"), JSON.stringify(snap(2, "task B")));
    const r = await compact(dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not in manifest.json");
    expect(existsSync(join(dir, "manifest.json"))).toBe(false);
    expect(existsSync(join(dir, "000002.json"))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a successful run leaves no staged temporary files and a manifest listing every archive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-compact-"));
  try {
    for (let i = 1; i <= 4; i++) writeFileSync(join(dir, `00000${i}.json`), JSON.stringify(snap(i, `task ${i % 2}`)));
    expect((await compact(dir)).code).toBe(0);
    const files = readdirSync(dir);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    const man = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(files.filter((f) => f.endsWith(".jsonl.gz")).map((f) => f.slice(5, -9)).sort()).toEqual(Object.keys(man).sort());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("with no new snapshots, an orphan archive or a missing listed archive is still refused, not 'nothing to compact'", () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-compact-norow-"));
  try {
    writeFileSync(join(dir, "000001.json"), JSON.stringify(snap(1, "task A")));
    expect(Bun.spawnSync(["bun", SCRIPT, dir]).exitCode).toBe(0);
    expect(Bun.spawnSync(["bun", SCRIPT, dir]).exitCode).toBe(0); // consistent and empty: fine
    writeFileSync(join(dir, "task-0123456789ab.jsonl.gz"), Bun.gzipSync(Buffer.from(JSON.stringify(snap(9, "x")) + "\n")));
    const orphan = Bun.spawnSync(["bun", SCRIPT, dir]);
    expect(orphan.exitCode).toBe(1);
    expect(orphan.stderr.toString()).toContain("not in manifest.json");
    rmSync(join(dir, "task-0123456789ab.jsonl.gz"));
    const listed = readdirSync(dir).find((f) => f.endsWith(".jsonl.gz"))!;
    rmSync(join(dir, listed));
    const missing = Bun.spawnSync(["bun", SCRIPT, dir]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain("do not exist");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("manifest raw_bytes counts UTF-8 bytes on disk, not string length", () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-compact-utf8-"));
  try {
    const raw = JSON.stringify(snap(1, "zażółć gęślą jaźń ✓"));
    writeFileSync(join(dir, "000001.json"), raw);
    expect(Bun.spawnSync(["bun", SCRIPT, dir]).exitCode).toBe(0);
    const m = Object.values(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")))[0] as any;
    expect(m.raw_bytes).toBe(Buffer.byteLength(raw, "utf8"));
    expect(m.raw_bytes).toBeGreaterThan(raw.length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("with no new snapshots, every listed archive is read: bad JSON, a bad seq, or a count that disagrees with the manifest fails", async () => {
  const run = (dir: string) => Bun.spawnSync(["bun", SCRIPT, dir]);
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-compact-"));
    writeFileSync(join(dir, "000001.json"), JSON.stringify(snap(1, "task A")));
    writeFileSync(join(dir, "000002.json"), JSON.stringify(snap(2, "task A")));
    expect(run(dir).exitCode).toBe(0);
    const man = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const key = Object.keys(man)[0]!;
    return { dir, man, key, gz: join(dir, `task-${key}.jsonl.gz`) };
  };
  const cases: [string, (c: ReturnType<typeof setup>) => void, RegExp][] = [
    ["malformed line", (c) => writeFileSync(c.gz, Bun.gzipSync(Buffer.from(JSON.stringify(snap(1, "task A")) + "\nnot json\n"))), /not JSON/],
    ["bad seq", (c) => writeFileSync(c.gz, Bun.gzipSync(Buffer.from([snap(1, "task A"), { ...snap(2, "task A"), seq: 0 }].map((x) => JSON.stringify(x)).join("\n") + "\n"))), /not a positive whole number/],
    ["count mismatch", (c) => writeFileSync(join(c.dir, "manifest.json"), JSON.stringify({ [c.key]: { ...c.man[c.key], exchanges: 3 } })), /manifest says 3/],
    ["seq range mismatch", (c) => writeFileSync(join(c.dir, "manifest.json"), JSON.stringify({ [c.key]: { ...c.man[c.key], seq_last: 9 } })), /manifest says 1-9/],
    ["not gzip", (c) => writeFileSync(c.gz, "plain"), /does not gunzip/],
  ];
  for (const [name, mutate, why] of cases) {
    const c = setup();
    try {
      mutate(c);
      const r = run(c.dir);
      expect({ name, code: r.exitCode }).toEqual({ name, code: 1 });
      expect(r.stderr.toString()).toMatch(why);
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  }
});

test("an unlisted archive is refused whatever its name, not only task-<hex>", () => {
  for (const stray of ["extra.jsonl.gz", "task-XYZ.jsonl.gz"]) {
    const dir = mkdtempSync(join(tmpdir(), "capture-compact-stray-"));
    try {
      writeFileSync(join(dir, "000001.json"), JSON.stringify(snap(1, "task A")));
      expect(Bun.spawnSync(["bun", SCRIPT, dir]).exitCode).toBe(0);
      writeFileSync(join(dir, stray), Bun.gzipSync(Buffer.from(JSON.stringify(snap(9, "x")) + "\n")));
      const r = Bun.spawnSync(["bun", SCRIPT, dir]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain(`not in manifest.json (${stray})`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("merging into an attributed archive drops capture-attribute's attribution (stale), but a header-attributed one stays exact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-compact-"));
  const run = async () => { const p = Bun.spawn(["bun", SCRIPT, dir], { stdout: "pipe", stderr: "pipe" }); return { code: await p.exited, err: await new Response(p.stderr).text() }; };
  const man = () => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  try {
    // no header: capture-attribute later wrote instances and a per-seq map for the archive
    writeFileSync(join(dir, "000001.json"), JSON.stringify(snap(1, "shared head")));
    expect((await run()).code).toBe(0);
    let m = man(); const key = Object.keys(m)[0]!;
    m[key].instances = ["A", "B"]; m[key].seq_tasks = { "1": "A" };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
    writeFileSync(join(dir, "000002.json"), JSON.stringify(snap(2, "shared head")));
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.err).toContain("re-run capture-attribute");
    m = man();
    expect(m[key].instances).toBeUndefined();
    expect(m[key].seq_tasks).toBeUndefined();
    expect(m[key].attribution_stale).toContain("re-run capture-attribute");
    // header-attributed: every new snapshot carries the entry's task id, so attribution (and any per-seq map) is kept exact
    const withId = (seq: number) => ({ ...snap(seq, "t"), task_id: "T1" });
    writeFileSync(join(dir, "000003.json"), JSON.stringify(withId(3)));
    expect((await run()).code).toBe(0);
    m = man(); const tk = Object.keys(m).find((k) => m[k].task_id === "T1")!;
    m[tk].seq_tasks = { "3": "T1" };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
    writeFileSync(join(dir, "000004.json"), JSON.stringify(withId(4)));
    const r2 = await run();
    expect(r2.code).toBe(0);
    expect(r2.err).toBe("");
    m = man();
    expect(m[tk].instances).toEqual(["T1"]);
    expect(m[tk].seq_tasks).toEqual({ "3": "T1", "4": "T1" });
    expect(m[tk].attribution_stale).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
