import { expect, setDefaultTimeout, test } from "bun:test";
setDefaultTimeout(60_000);
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aaRow, aaStudyCounts } from "./aa-hindsight";

test("aaStudyCounts reads whole counts and refuses anything else", () => {
  expect(aaStudyCounts("anon_draw,resolved_count\naa01,4\naa02,5\n")).toEqual([4, 5]);
  expect(() => aaStudyCounts("draw,count\naa01,4\n")).toThrow(/header/);
  for (const bad of ["aa01,", "aa01,4.5", "aa01,-1", "aa01,x", "aa01,4,1", ",4"])
    expect(() => aaStudyCounts(`anon_draw,resolved_count\n${bad}\n`)).toThrow(/line 2/);
  expect(() => aaStudyCounts("anon_draw,resolved_count\naa01,4\naa01,5\n")).toThrow(/duplicate/);
});

test("the shipped pre-registered study reproduces its read (16 draws, FP(4,3) 20.0%)", () => {
  const r = aaRow("aa", aaStudyCounts(readFileSync(join(import.meta.dir, "../data/aa-study.csv"), "utf8")));
  expect(r.draws).toBe(16);
  expect((100 * r.fp).toFixed(1)).toBe("20.0");
});
