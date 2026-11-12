import { test, expect } from "bun:test";
import { join, resolve } from "node:path";
import { isSafeId, safeId, within } from "./safe-id";

test("a tame id passes through; separators, dot-dot and leading dots become a slug plus a hash", () => {
  for (const id of ["django__django-11099", "task_7", "A.b-c"]) expect(safeId(id)).toBe(id);
  for (const id of ["a/b", "../x", "..", ".", ".hidden", "a\\b", "", "x".repeat(200), "a b", "a..b"]) {
    const s = safeId(id);
    expect(isSafeId(s)).toBe(true);
    expect(s).not.toContain("/");
    expect(s).not.toBe(id);
  }
  // different unsafe ids never share a name, even when their slugs agree
  expect(safeId("a/b")).not.toBe(safeId("a:b"));
  expect(safeId("a/b")).toMatch(/^a_b-[0-9a-f]{10}$/);
});

test("within keeps a path inside its root and refuses one that escapes", () => {
  expect(within("/r", "x", "y")).toBe(resolve("/r/x/y"));
  expect(() => within("/r", "../x")).toThrow("outside");
  expect(() => within("/r", "a/../../x")).toThrow("outside");
  expect(() => within("/r", "/etc/passwd")).toThrow("outside");
  expect(() => within("/r", ".")).toThrow("outside");
  expect(within("/r", join("a", "..", "b"))).toBe(resolve("/r/b"));
});
