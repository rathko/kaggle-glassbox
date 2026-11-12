// cli-num: the one check every replay/analysis tool runs on its count and concurrency flags BEFORE it creates any
// output. A zero, negative, fractional or non-numeric count used to "succeed" while doing nothing (or appending a
// record that claimed work it never did), so it is a usage error instead.

/** Parses `raw` (or `dflt` when the flag is absent) as a positive safe integer; exits 2 with a message otherwise.
 *  `min` 0 admits zero for flags where 0 explicitly means "off" or "no limit". */
export function countFlag(name: string, raw: string | undefined, dflt: number, min = 1): number {
  if (raw === undefined) return dflt;
  const x = Number(raw);
  if (raw.trim() === "" || !Number.isSafeInteger(x) || x < min) {
    console.error(`--${name} must be a whole number >= ${min}, got '${raw}'`);
    process.exit(2);
  }
  return x;
}
