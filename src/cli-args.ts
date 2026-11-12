// cli-args: the one argument check every command-line tool here runs before it does anything. A hand-rolled
// `flag("system-file")` lookup never notices `--sytem-file`, so a typo used to run an unchanged control while looking
// like an intervention. This refuses, with exit 2 and the usage line, anything the tool does not take: an unknown
// flag, a flag given twice, a valued flag with no value, or the wrong number of positional arguments.
//
//   strictArgs(argv, { valued: ["out", "seq"], bool: ["drop-tools"], positionals: [0, 0] }, USAGE)
//
// Flags are `--name value` or `--name` (bool); a value may itself start with "-" (a negative number) but not with
// "--". `--help` / `-h` print the usage and exit 0. `repeatable` names valued flags that may be given more than once.

export interface ArgSpec {
  valued?: string[];
  bool?: string[];
  repeatable?: string[];
  /** [min, max] positional arguments (max Infinity for any number); default [0, 0] */
  positionals?: [number, number];
}

/** Validates `argv` against `spec`; on any problem prints it with `usage` and exits 2. Returns the positionals. */
export function strictArgs(argv: string[], spec: ArgSpec, usage: string): string[] {
  const problems = argProblems(argv, spec);
  if (argv.includes("--help") || argv.includes("-h")) { console.log(usage); process.exit(0); }
  if (problems.length) { console.error(`${problems.join("\n")}\n${usage}`); process.exit(2); }
  return positionalsOf(argv, spec);
}

/** The problems strictArgs would refuse on (empty = valid). Pure, for tests. */
export function argProblems(argv: string[], spec: ArgSpec): string[] {
  const valued = new Set(spec.valued ?? []), bool = new Set(spec.bool ?? []), repeatable = new Set(spec.repeatable ?? []);
  const [min, max] = spec.positionals ?? [0, 0];
  const seen = new Set<string>(), out: string[] = [];
  let positionals = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") continue;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (valued.has(name)) {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith("--")) out.push(`${a} needs a value`);
        else i++;
      } else if (!bool.has(name)) { out.push(`unknown option ${a}`); continue; }
      if (seen.has(name) && !repeatable.has(name)) out.push(`${a} given twice`);
      seen.add(name);
    } else positionals++;
  }
  if (positionals < min || positionals > max)
    out.push(max === min ? `expected ${min} positional argument(s), got ${positionals}` : `expected ${min}${max === Infinity ? " or more" : `-${max}`} positional argument(s), got ${positionals}`);
  return out;
}

function positionalsOf(argv: string[], spec: ArgSpec): string[] {
  const valued = new Set(spec.valued ?? []), out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) { if (valued.has(a.slice(2))) i++; continue; }
    if (a === "-h") continue;
    out.push(a);
  }
  return out;
}
