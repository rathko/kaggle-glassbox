// test-fixture: for tests that hand-write a compacted capture. capture-compact.ts always records exchanges, seq_first
// and seq_last per archive, and every reader checks them (archives.ts checkArchive); fillManifest adds the fields a
// hand-written manifest leaves out, computed from the archives present, and never touches a field the test set.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { archiveName } from "./archives";

export function fillManifest(captureDir: string): void {
  const p = join(captureDir, "manifest.json");
  const m = JSON.parse(readFileSync(p, "utf8"));
  for (const [k, e] of Object.entries<any>(m)) {
    const f = join(captureDir, archiveName(k));
    if (!existsSync(f)) continue;
    const seqs = Buffer.from(Bun.gunzipSync(readFileSync(f))).toString("utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l).seq; } catch { return undefined; } });
    const nums = seqs.filter((q): q is number => typeof q === "number");
    e.exchanges ??= seqs.length;
    if (nums.length) { e.seq_first ??= Math.min(...nums); e.seq_last ??= Math.max(...nums); }
  }
  writeFileSync(p, JSON.stringify(m));
}
