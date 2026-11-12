// concordance: does a cheap evaluation stage actually predict what a more expensive stage will
// say? Generalised from a specific test-funnel's closeout logic — here it operates over a plain
// list of (variant, stage, verdict) reads and says nothing about where those reads came from.
//
// The question matters because a multi-stage funnel (cheap screen -> ... -> expensive full
// evaluation) is only worth enforcing if an early PASS actually predicts a later one. If it
// doesn't, the funnel isn't filtering noise, it's just adding latency. The honest way to check is
// NOT "did it feel predictive" — it's: for every variant read at two or more stages, do the
// verdicts agree, and how does that agreement compare to the easiest baseline predictor there is
// (always guess the most common verdict)? A funnel that only matches a constant predictor isn't
// contributing anything a lookup table of one number couldn't.
//
// PURE: takes data in, returns tables out. No opinion on what a "verdict" means beyond being one
// of a small set of comparable labels (this repo's convention, matching `preread.ts`, is
// "supported" / "measured-null" / "refuted" / "unknown" — but nothing here requires those exact
// strings).

export interface Read {
  variant: string;
  stage: string;
  verdict: string;
}

export interface StagePair {
  variant: string;
  from: string;
  to: string;
  adjacent: boolean;
  fromVerdict: string;
  toVerdict: string;
  /** Exact agreement: the two verdict strings are identical. `null` if either side is the
   *  designated "unknown" marker, if one was given. */
  agreeExact: boolean | null;
}

/** Every pair of (from-stage, to-stage) reads for the same variant, from a `stageOrder` that's
 *  cheap-to-expensive. `unknownVerdict`, if given, marks a verdict value that means "no usable
 *  read" (void, parked, still running) — pairs touching it are still reported, but with
 *  `agreeExact: null` rather than a potentially-misleading false/true. */
export function pairStages(reads: readonly Read[], stageOrder: readonly string[], unknownVerdict?: string): StagePair[] {
  const byVariant = new Map<string, Read[]>();
  for (const r of reads) (byVariant.get(r.variant) ?? byVariant.set(r.variant, []).get(r.variant)!).push(r);

  const pairs: StagePair[] = [];
  for (const [variant, rs] of byVariant) {
    // One read per stage per variant: if several exist, the FIRST one registered wins (mirrors
    // "the read that made the promotion decision" — callers that need replications reported too
    // should pass them in as a separate list and compare directly).
    const byStage = new Map<string, Read>();
    for (const r of rs) if (!byStage.has(r.stage)) byStage.set(r.stage, r);
    const ordered = stageOrder.filter((s) => byStage.has(s)).map((s) => byStage.get(s)!);
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const a = ordered[i], b = ordered[j];
        const known = a.verdict !== unknownVerdict && b.verdict !== unknownVerdict;
        pairs.push({
          variant, from: a.stage, to: b.stage,
          adjacent: stageOrder.indexOf(b.stage) - stageOrder.indexOf(a.stage) === 1,
          fromVerdict: a.verdict, toVerdict: b.verdict,
          agreeExact: known ? a.verdict === b.verdict : null,
        });
      }
    }
  }
  return pairs;
}

export interface ConcordanceTable {
  from: string;
  to: string;
  pairs: number;
  determinable: number;
  unknown: number;
  /** Count per observed (fromVerdict -> toVerdict) combination, among determinable pairs. */
  cells: Record<string, number>;
  agreeing: number;
  agreementRate: number | null;
}

/** Concordance table for one (from, to) stage pair: how many pairs agreed exactly, and the cell
 *  breakdown of what disagreements actually look like. */
export function concordanceTable(pairs: readonly StagePair[], from: string, to: string): ConcordanceTable {
  const subset = pairs.filter((p) => p.from === from && p.to === to);
  const determinable = subset.filter((p) => p.agreeExact !== null);
  const cells: Record<string, number> = {};
  for (const p of determinable) {
    const key = `${p.fromVerdict}->${p.toVerdict}`;
    cells[key] = (cells[key] ?? 0) + 1;
  }
  const agreeing = determinable.filter((p) => p.agreeExact).length;
  return {
    from, to, pairs: subset.length, determinable: determinable.length, unknown: subset.length - determinable.length,
    cells, agreeing, agreementRate: determinable.length ? agreeing / determinable.length : null,
  };
}

export interface BaselineComparison {
  /** The verdict value a "guess the mode" predictor would always output for this stage pair's
   *  `to` reads. */
  mostCommonToVerdict: string | null;
  /** How many determinable pairs that constant guess would have gotten right. */
  constantGuessCorrect: number;
  determinable: number;
}

/** How a predictor that ALWAYS guesses the most common `to` verdict would score, for the same
 *  determinable pairs a real concordance table was built from. A cheap stage that only matches
 *  this baseline isn't adding predictive information — it's reproducing the base rate. */
export function alwaysGuessModeBaseline(pairs: readonly StagePair[], from: string, to: string): BaselineComparison {
  const subset = pairs.filter((p) => p.from === from && p.to === to);
  const determinable = subset.filter((p) => p.agreeExact !== null);
  if (!determinable.length) return { mostCommonToVerdict: null, constantGuessCorrect: 0, determinable: 0 };
  const counts = new Map<string, number>();
  for (const p of determinable) counts.set(p.toVerdict, (counts.get(p.toVerdict) ?? 0) + 1);
  const [mode] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return { mostCommonToVerdict: mode, constantGuessCorrect: counts.get(mode)!, determinable: determinable.length };
}

export interface PositivePredictiveResult {
  variant: string;
  positiveAt: string;
  laterStages: { stage: string; verdict: string }[];
  confirmedLater: boolean;
}

/** For every variant with a `positiveVerdict` read at some stage, what did every LATER stage
 *  (among those with a known verdict) say? `confirmedLater` is true iff any later stage also
 *  read positive. Only variants with at least one later, known-verdict stage are returned. */
export function positivePredictiveValue(
  reads: readonly Read[], stageOrder: readonly string[], positiveVerdict: string, unknownVerdict?: string,
): PositivePredictiveResult[] {
  const byVariant = new Map<string, Read[]>();
  for (const r of reads) (byVariant.get(r.variant) ?? byVariant.set(r.variant, []).get(r.variant)!).push(r);
  const out: PositivePredictiveResult[] = [];
  for (const [variant, rs] of byVariant) {
    const byStage = new Map<string, Read>();
    for (const r of rs) if (!byStage.has(r.stage)) byStage.set(r.stage, r);
    const ordered = stageOrder.filter((s) => byStage.has(s)).map((s) => byStage.get(s)!);
    const i = ordered.findIndex((r) => r.verdict === positiveVerdict);
    if (i < 0) continue;
    const later = ordered.slice(i + 1).filter((r) => r.verdict !== unknownVerdict);
    if (!later.length) continue;
    out.push({
      variant, positiveAt: ordered[i].stage,
      laterStages: later.map((r) => ({ stage: r.stage, verdict: r.verdict })),
      confirmedLater: later.some((r) => r.verdict === positiveVerdict),
    });
  }
  return out;
}
