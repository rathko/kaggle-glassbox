#!/usr/bin/env bun
// check-links: every relative link and #anchor in the repo's markdown resolves. Exits 1 and lists the broken ones.
// usage: bun scripts/check-links.ts
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const slug = (h: string) => h.trim().toLowerCase().replace(/[`*_~]/g, "").replace(/[^\w\- ]+/g, "").replace(/ /g, "-");
export function anchors(md: string): Set<string> {
  const out = new Set<string>(), seen = new Map<string, number>();
  let fence = false;
  for (const l of md.split("\n")) {
    if (/^```/.test(l)) fence = !fence;
    const m = !fence && l.match(/^#{1,6}\s+(.*)$/);
    if (!m) continue;
    const s = slug(m[1]!), n = seen.get(s) ?? 0;
    out.add(n ? `${s}-${n}` : s); seen.set(s, n + 1);
  }
  return out;
}
function mdFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (e === "node_modules" || e.startsWith(".")) return [];
    return statSync(p).isDirectory() ? mdFiles(p) : e.endsWith(".md") ? [p] : [];
  });
}
export function brokenLinks(root = ROOT): string[] {
  const bad: string[] = [];
  for (const f of mdFiles(root)) {
    const text = readFileSync(f, "utf8").replace(/```[\s\S]*?```/g, "");
    for (const m of text.matchAll(/\]\(([^)\s]+)\)|srcset="([^"]+)"|src="([^"]+)"/g)) {
      const target = m[1] ?? m[2] ?? m[3]!;
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [path, anchor] = target.split("#");
      const file = path ? resolve(dirname(f), path) : f;
      if (!existsSync(file)) { bad.push(`${relative(root, f)}: ${target} (no such file)`); continue; }
      if (anchor && file.endsWith(".md") && !anchors(readFileSync(file, "utf8")).has(anchor)) bad.push(`${relative(root, f)}: ${target} (no such heading)`);
    }
  }
  return bad;
}
if (import.meta.main) {
  (await import("../src/cli-args.ts")).strictArgs(process.argv.slice(2), {}, "usage: bun scripts/check-links.ts   (checks every markdown link and anchor in the repo)");
  const bad = brokenLinks();
  if (bad.length) { console.log(bad.join("\n")); process.exit(1); }
  console.log("all markdown links resolve");
}
