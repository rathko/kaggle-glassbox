// state-rows: ordering and identity of rows in a states index (replay-states.ts, slip-logprobs.ts). Rows are ordered by
// corpus, then run, then seq, each compared on its own: concatenating them ("a"+"bc" vs "ab"+"c") would interleave
// two runs, so a retry of the same call would read as a second onset. A run is shown as "<corpus>/<run>"; two
// different (corpus, run) pairs that print the same ("a/b" + "c" and "a" + "b/c") are refused rather than merged.

export const byRun = (x: any, y: any): number =>
  String(x.corpus).localeCompare(String(y.corpus)) || String(x.run).localeCompare(String(y.run)) || x.seq - y.seq;

/** The one identity of a run, used everywhere a run is compared or keyed (repeat detection, the run loader, the
 *  printed-name collision check): the (corpus, run) tuple, never a concatenation. */
export const runKey = (corpus: string, run: string): string => JSON.stringify([corpus, run]);

/** Problems with a states index, before anything is selected from it: corpus, run and group must be non-empty
 *  strings (a numeric run 1 and a string run "1" would be one run to one check and two to another), seq a positive
 *  whole number, and no (corpus, run, seq) may appear twice. The fields that drive selection are typed too: a missing
 *  fingerprint would make two different calls compare equal (undefined === undefined) and hide the second as a
 *  repeat, and a string "false" is truthy, so `fingerprint` must be a non-empty string or a finite number, `flagged`
 *  a boolean, `ambiguous` a boolean when present, and `outcome` a string when present. Empty when the index is sound. */
export function stateRowProblems(rows: any[]): string[] {
  const out: string[] = [], seen = new Set<string>();
  rows.forEach((r, i) => {
    const at = `line ${i + 1}`;
    if (!r || typeof r !== "object" || Array.isArray(r)) { out.push(`${at}: not a JSON object`); return; }
    let ok = true;
    for (const f of ["corpus", "run", "group"]) {
      if (typeof r[f] !== "string" || r[f] === "") { out.push(`${at}: "${f}" must be a non-empty string, got ${JSON.stringify(r[f])}`); ok = false; }
    }
    if (!Number.isSafeInteger(r.seq) || r.seq < 1) { out.push(`${at}: "seq" must be a positive whole number, got ${JSON.stringify(r.seq)}`); ok = false; }
    const fp = r.fingerprint;
    if (!((typeof fp === "string" && fp !== "") || (typeof fp === "number" && Number.isFinite(fp)))) { out.push(`${at}: "fingerprint" must be a non-empty string or a finite number, got ${JSON.stringify(fp)}`); ok = false; }
    if (typeof r.flagged !== "boolean") { out.push(`${at}: "flagged" must be true or false, got ${JSON.stringify(r.flagged)}`); ok = false; }
    if (r.ambiguous !== undefined && typeof r.ambiguous !== "boolean") { out.push(`${at}: "ambiguous" must be true or false when given, got ${JSON.stringify(r.ambiguous)}`); ok = false; }
    if (r.outcome !== undefined && r.outcome !== null && typeof r.outcome !== "string") { out.push(`${at}: "outcome" must be a string when given, got ${JSON.stringify(r.outcome)}`); ok = false; }
    if (!ok) return;
    const k = JSON.stringify([r.corpus, r.run, r.seq]);
    if (seen.has(k)) out.push(`${at}: ${r.corpus}/${r.run} seq ${r.seq} appears twice`);
    seen.add(k);
  });
  return out;
}

/** Pairs of distinct (corpus, run) that print as the same "<corpus>/<run>"; empty when every shown run is one run. */
export function runKeyCollisions(rows: any[]): string[] {
  const seen = new Map<string, string>(), out: string[] = [];
  for (const r of rows) {
    const shown = `${r.corpus}/${r.run}`, tuple = runKey(r.corpus, r.run);
    const prior = seen.get(shown);
    if (prior !== undefined && prior !== tuple) out.push(`runs ${prior} and ${tuple} both print as ${shown}; rename one`);
    else seen.set(shown, tuple);
  }
  return out;
}

/** Walks every row of the index in run order and marks each one that repeats the call just before it in the same run
 *  (same fingerprint). Ambiguous rows take part in that walk, since they are real calls of the trajectory: in
 *  A (flagged), B (ambiguous), A (flagged) the second A is a new call, not a repeat. Only the non-ambiguous rows are
 *  returned, because an ambiguous row can never itself become a state. */
export function candidateRows(allRows: any[]): { row: any; repeat: boolean }[] {
  const out: { row: any; repeat: boolean }[] = [];
  let prev: { run: string; fp: unknown } | null = null;
  for (const r of [...allRows].sort(byRun)) {
    const run = runKey(r.corpus, r.run);
    const repeat = !!prev && prev.run === run && prev.fp === r.fingerprint;
    prev = { run, fp: r.fingerprint };
    if (!r.ambiguous) out.push({ row: r, repeat });
  }
  return out;
}

/** Exactly min(n, items.length) items spread evenly over the whole list (the middle of each of n equal slices), in
 *  list order. A prefix would over-represent whichever corpora and runs sort first; this reaches the end of the list
 *  for every n. n <= 0 selects nothing. */
export function spreadSample<T>(items: T[], n: number): T[] {
  if (n <= 0) return [];
  if (n >= items.length) return [...items];
  return Array.from({ length: n }, (_, i) => items[Math.floor(((i + 0.5) * items.length) / n)]!);
}

/** One run's trajectory can span several capture groups, so a run is loaded as the merge of EVERY group any index
 *  row (ambiguous ones included) puts it in, sorted by seq and validated as one trajectory: a broken exchange in
 *  any of the run's groups rejects the run, not just the group a chosen state sits in. `loadGroup` returns that
 *  group's snapshots (already checked on their own); `validate` checks the merged list (unique seqs, valid
 *  exchanges) and throws.
 *
 *  Every seq the index gives for a (corpus, run, group) must exist in that group. A group that only one run uses is
 *  taken whole (the index may list only some calls, and the unlisted ones are still that run's trajectory, e.g. the
 *  retry after an onset). A group that several runs use is split by the index: each run keeps only its own listed
 *  seqs, and a snapshot that no run lists is refused, since it cannot be given to either run. */
export function makeRunLoader(
  allRows: any[],
  loadGroup: (corpus: string, group: string) => any[],
  validate: (snaps: any[], where: string) => void,
): (corpus: string, run: string) => { snap: any; group: string }[] {
  const runGroups = new Map<string, { corpus: string; groups: Set<string> }>();
  // per (corpus, group): which runs list which seqs in it
  const groupSeqs = new Map<string, Map<string, Set<number>>>();
  for (const r of allRows) {
    const k = runKey(r.corpus, r.run), g = String(r.group);
    (runGroups.get(k) ?? runGroups.set(k, { corpus: r.corpus, groups: new Set() }).get(k)!).groups.add(g);
    const gk = JSON.stringify([r.corpus, g]);
    const byRunSeqs = groupSeqs.get(gk) ?? groupSeqs.set(gk, new Map()).get(gk)!;
    (byRunSeqs.get(k) ?? byRunSeqs.set(k, new Set()).get(k)!).add(Number(r.seq));
  }
  const cache = new Map<string, { snap: any; group: string }[]>();
  const groupPart = (corpus: string, g: string, k: string): any[] => {
    const snaps = loadGroup(corpus, g);
    const byRunSeqs = groupSeqs.get(JSON.stringify([corpus, g]))!;
    const have = new Set(snaps.map((x) => Number(x.seq)));
    for (const [rk, seqs] of byRunSeqs) for (const q of seqs)
      if (!have.has(q)) throw new Error(`group ${g}: the index lists seq ${q} for run ${JSON.parse(rk).join("/")}, but the capture has no such exchange`);
    if (byRunSeqs.size === 1) return snaps;
    const owner = new Map<number, string>();
    for (const [rk, seqs] of byRunSeqs) for (const q of seqs) owner.set(q, rk);
    const orphan = snaps.find((x) => !owner.has(Number(x.seq)));
    if (orphan) throw new Error(`group ${g} is shared by ${byRunSeqs.size} runs and seq ${orphan.seq} is listed for none of them; it cannot be attributed to a run`);
    return snaps.filter((x) => owner.get(Number(x.seq)) === k);
  };
  return (corpus, run) => {
    const k = runKey(corpus, run);
    if (!cache.has(k)) {
      const entry = runGroups.get(k);
      if (!entry) throw new Error(`states index: no rows for run ${corpus}/${run}`);
      const merged = [...entry.groups].sort().flatMap((g) => groupPart(corpus, g, k).map((snap) => ({ snap, group: g })));
      merged.sort((x, y) => x.snap.seq - y.snap.seq);
      validate(merged.map((m) => m.snap), `run ${corpus}/${run}`);
      cache.set(k, merged);
    }
    return cache.get(k)!;
  };
}
