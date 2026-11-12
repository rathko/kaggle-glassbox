// stage-gate: enforce a test funnel (cheap screen -> ... -> expensive full run) IN CODE, so
// nobody can skip a rung by habit or under deadline pressure.
//
// The problem this solves: without enforcement, every idea tends to go straight to the most
// expensive, most realistic evaluation stage, because that's the stage that feels like "the real
// answer". That's enormously wasteful when most ideas turn out to do nothing — you pay full price
// to learn what a cheap screen would have told you for a fraction of the cost. The fix is a
// strictly-ordered funnel where entering stage N requires a recorded PASS at stage N-1 for the
// same idea (or its documented lineage), with exactly two logged exceptions: a run can be
// declared a `baseline` (calibration of something already known, not a new idea under test), or
// admitted via an explicit, logged `skip` with a real reason.
//
// PURE: no file I/O here. Keep the ledger (a LedgerEntry[]) wherever suits you, e.g. a JSON file you read
// before admitting a stage and append to after; the ledger shape is the only contract that matters.

export interface LedgerEntry {
  hypothesis: string;
  stage: string;
  verdict: "pass" | "fail" | "skip" | "baseline";
  at: string;
  runs?: string[];
  detail: string;
}

export interface StageSpec {
  /** Stage name, e.g. "screen", "fast-lane", "full". */
  name: string;
  /** Inclusive upper bound on slate size for this stage to apply by SIZE. `null` = no upper
   *  bound (this must be the last entry in `stages`, same rule as preread's catch-all). */
  maxIds: number | null;
  /** If set, a slate whose basename equals this string is ALWAYS this stage, regardless of
   *  size — for a fixed calibration slate that happens to be small. Checked before the
   *  size-based rule, in the order `stages` is given. */
  calibrationSlateBasename?: string;
}

/** Classify a slate into a stage: calibration-named slates first (in the order given), then by
 *  size against each stage's `maxIds`, in order. Throws if nothing matches (a `stages` list
 *  without a final `maxIds: null` entry is a configuration bug, not a runtime one). */
export function stageOf(stages: readonly StageSpec[], slateBasename: string, idCount: number): string {
  for (const s of stages) {
    if (s.calibrationSlateBasename && slateBasename === s.calibrationSlateBasename) return s.name;
  }
  for (const s of stages) {
    if (s.maxIds === null || idCount <= s.maxIds) return s.name;
  }
  throw new Error(
    `no stage matched ${idCount} ids and no stage has maxIds: null — the stage list has a gap`,
  );
}

/** Throws unless a run of `hypothesis` at `stage` is admissible. `stageOrder` is the full
 *  cheap-to-expensive ordering of stage names; `gatedStages` are the ones that actually require a
 *  previous-stage pass (your cheapest 1-2 stages are typically ungated — nothing to protect them
 *  from). Returns the ledger entry to record for a `baseline`/`skip` admission, or `null` when the
 *  previous stage's pass already covers it (nothing new to log). */
export function assertAdmissible(opts: {
  hypothesis: string;
  stage: string;
  stageOrder: readonly string[];
  gatedStages: ReadonlySet<string>;
  /** Another hypothesis id whose PASS at the previous stage this run's lineage inherits from
   *  (e.g. this run is a direct descendant of an idea that already cleared that stage). */
  funnelFrom?: string;
  /** Set when this run is a calibration/baseline draw, not a new idea under test. */
  role?: string;
  /** A logged, deliberate exception. Must be a real reason (enforced: 20+ characters). */
  skipReason?: string;
  ledger: readonly LedgerEntry[];
}): Omit<LedgerEntry, "at"> | null {
  const { hypothesis, stage, stageOrder, gatedStages, funnelFrom, role, skipReason, ledger } = opts;
  if (!gatedStages.has(stage)) return null;
  if (role === "baseline") {
    return { hypothesis, stage, verdict: "baseline", detail: "role: baseline (calibration of an existing package)" };
  }
  if (skipReason !== undefined) {
    if (skipReason.trim().length < 20) {
      throw new Error("STAGE-GATE: a skip reason needs to be real (20+ characters); it is logged in the ledger");
    }
    return { hypothesis, stage, verdict: "skip", detail: skipReason.trim() };
  }
  const idx = stageOrder.indexOf(stage);
  if (idx <= 0) {
    throw new Error(`STAGE-GATE: stage ${JSON.stringify(stage)} is gated but has no predecessor in stageOrder`);
  }
  const need = stageOrder[idx - 1];
  const lineage = new Set([hypothesis, ...(funnelFrom ? [funnelFrom] : [])]);
  const passed = ledger.some((e) => lineage.has(e.hypothesis) && e.stage === need && e.verdict === "pass");
  if (!passed) {
    throw new Error(
      `STAGE-GATE: ${hypothesis} wants stage ${stage}, but no ${need} PASS is recorded for ` +
      `${[...lineage].join(" or ")}. Run it at ${need} first, name the passing hypothesis with ` +
      `funnelFrom, or (a logged exception) pass a skipReason.`,
    );
  }
  return null;
}

/** Append-only in-memory ledger update — your caller owns persistence (read the whole array,
 *  push, write it back atomically; see `score-gate.ts` in this repo for that pattern). */
export function appendLedger(ledger: readonly LedgerEntry[], e: Omit<LedgerEntry, "at">, at = new Date().toISOString()): LedgerEntry[] {
  return [...ledger, { ...e, at }];
}
