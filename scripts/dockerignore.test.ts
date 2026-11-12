import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const lines = (f: string) => readFileSync(join(ROOT, f), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

// a Docker build copies the working tree; anything git keeps out of the repo must stay out of the image too
test(".dockerignore covers every .gitignore entry", () => {
  const docker = new Set(lines(".dockerignore").map((l) => l.replace(/^\*\*\//, "").replace(/^\//, "").replace(/\/$/, "")));
  for (const g of lines(".gitignore")) expect(docker.has(g.replace(/^\//, "").replace(/\/$/, ""))).toBe(true);
  expect(docker.has("*.private.json")).toBe(true);
  expect(lines(".dockerignore")).toContain("**/*.private.json");
});
