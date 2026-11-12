import { test, expect, setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000); // statistical tests can take seconds on a loaded machine (the bunfig preload alone did not always apply)
import { brokenLinks, anchors } from "./check-links";

test("every relative link and anchor in the repo's markdown resolves", () => {
  expect(brokenLinks()).toEqual([]);
});

test("anchor slugs follow GitHub's rules, including repeated headings", () => {
  const a = anchors("# Reproducing the paper's numbers\n## A/B\n## A/B\n```\n# not a heading\n```");
  expect(a.has("reproducing-the-papers-numbers")).toBe(true);
  expect(a.has("ab")).toBe(true);
  expect(a.has("ab-1")).toBe(true);
  expect(a.has("not-a-heading")).toBe(false);
});

test("every package export resolves to a module with exports, and the bin is executable TypeScript", async () => {
  const { join } = await import("node:path");
  const root = join(import.meta.dir, "..");
  const pkg = JSON.parse(await Bun.file(join(root, "package.json")).text());
  for (const [name, path] of Object.entries(pkg.exports as Record<string, string>)) {
    const m = await import(join(root, path));
    expect(Object.keys(m).length, name).toBeGreaterThan(0);
  }
  const bin = await Bun.file(join(root, pkg.bin.leaderboard)).text();
  expect(bin.startsWith("#!/usr/bin/env bun")).toBe(true);
});
