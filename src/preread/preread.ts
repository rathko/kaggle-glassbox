// preread: a machine-readable pre-registered read, frozen before the score exists.
//
// Why this exists: a prose "band" in a design doc cannot be applied by a machine, so the band
// ends up read in the same breath as the number — which means the closeout was decided AFTER
// seeing the score, the one thing pre-registration is supposed to prevent. This module makes the
// band a validated data structure that lives in your change doc (an ADR, an RFC, a design-review
// note — whatever you call it) BEFORE a run happens, not after.
//
// PURE: no filesystem, no clock, no process. Every function here is a deterministic transform,
// so the rejection paths are exhaustively testable.

export type Verdict = "supported" | "measured-null" | "refuted";

/** Terminal statuses a machine is allowed to write. `confirmed` is deliberately NOT here: a local,
 *  cheap, pre-registered read can only REJECT a hypothesis or say it is worth confirming — it
 *  cannot itself promote anything to the status you'd act on. `supported` means "worth confirming
 *  on a real, more expensive read", never "ship it". Only a human reading a real downstream result
 *  gets to call something confirmed. */
export const MACHINE_VERDICTS: readonly Verdict[] = ["supported", "measured-null", "refuted"] as const;

export interface Band {
  /** Inclusive lower bound. `null` marks the mandatory final catch-all. */
  min: number | null;
  verdict: Verdict;
  label: string;
}

export interface PreRead {
  /** An id for the claim under test, e.g. "H-C". Format is yours; see `validate`'s regex. */
  hypothesis: string;
  /** The name of the metric this read is about. Free text — validate against your own registry
   *  of known metrics via `knownMetrics`, if you keep one; this module has no opinion on what
   *  metrics exist. */
  metric: string;
  /** Human-readable description of what's actually being measured and compared. */
  primary: string;
  bands: Band[];
  /** A condition under which this read should be treated as void rather than scored (e.g. "fewer
   *  than 3 draws completed"). Free text; not evaluated here, just carried through. */
  void_if?: string;
}

export class PreReadError extends Error {}

const FENCE = /```preread\s*\n([\s\S]*?)\n```/g;

/** Extract the single ```preread block from a document's text. Exactly one is required: zero
 *  means the run is not pre-registered, and two means nobody can say which claim was frozen. */
export function extractBlock(docText: string): string {
  const found: string[] = [];
  for (const m of docText.matchAll(FENCE)) found.push(m[1]);
  if (found.length === 0) {
    throw new PreReadError(
      "no ```preread block found. A run that cannot say which hypothesis it tests, and what " +
      "number would refute it, does not start.",
    );
  }
  if (found.length > 1) {
    throw new PreReadError(`${found.length} \`\`\`preread blocks found; exactly one is allowed`);
  }
  return found[0];
}

/** Validate a parsed preread object. `knownIds` is your own hypothesis registry's id set; pass
 *  `null` to skip the cross-reference (useful when linting a document standalone, before the
 *  hypothesis is registered anywhere). `knownMetrics` works the same way for `metric`. */
export function validate(
  raw: unknown,
  knownIds: ReadonlySet<string> | null = null,
  knownMetrics: ReadonlySet<string> | null = null,
): PreRead {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PreReadError("preread block must be a JSON object");
  }
  const o = raw as Record<string, unknown>;

  if (typeof o.hypothesis !== "string" || !/^H-[A-Z0-9-]+$/.test(o.hypothesis)) {
    throw new PreReadError(`hypothesis must be an id like "H-C"; got ${JSON.stringify(o.hypothesis)}`);
  }
  if (knownIds && !knownIds.has(o.hypothesis)) {
    throw new PreReadError(
      `unknown hypothesis ${o.hypothesis} — register it in your hypothesis list before a run can ` +
      `claim to test it`,
    );
  }
  if (typeof o.metric !== "string" || !o.metric.trim()) {
    throw new PreReadError(`metric must be a non-empty string; got ${JSON.stringify(o.metric)}`);
  }
  if (knownMetrics && !knownMetrics.has(o.metric)) {
    throw new PreReadError(`unknown metric ${JSON.stringify(o.metric)}; not in your known-metrics set`);
  }
  if (typeof o.primary !== "string" || !o.primary.trim()) {
    throw new PreReadError("primary must be a non-empty description of the primary metric");
  }
  if (o.void_if !== undefined && typeof o.void_if !== "string") {
    throw new PreReadError("void_if must be a string when present");
  }
  if (!Array.isArray(o.bands) || o.bands.length < 2) {
    throw new PreReadError("bands must be an array of at least 2 entries (a read with one band reads nothing)");
  }

  const bands: Band[] = o.bands.map((b, i) => {
    if (b === null || typeof b !== "object" || Array.isArray(b)) {
      throw new PreReadError(`bands[${i}] must be an object`);
    }
    const bb = b as Record<string, unknown>;
    if (!(bb.min === null || typeof bb.min === "number")) {
      throw new PreReadError(`bands[${i}].min must be a number or null (the catch-all)`);
    }
    if (typeof bb.min === "number" && !Number.isFinite(bb.min)) {
      throw new PreReadError(`bands[${i}].min must be finite`);
    }
    if (typeof bb.verdict !== "string") {
      throw new PreReadError(`bands[${i}].verdict must be a string`);
    }
    if (bb.verdict === "confirmed") {
      throw new PreReadError(
        `bands[${i}].verdict is "confirmed", which a pre-registered read may never claim: a local ` +
        `gate can only reject or say "worth confirming", never promote on its own. Only a human ` +
        `reading a real downstream result gets to call something confirmed.`,
      );
    }
    if (!(MACHINE_VERDICTS as readonly string[]).includes(bb.verdict)) {
      throw new PreReadError(
        `bands[${i}].verdict must be one of ${MACHINE_VERDICTS.join(" | ")}; got ${JSON.stringify(bb.verdict)}`,
      );
    }
    if (typeof bb.label !== "string" || !bb.label.trim()) {
      throw new PreReadError(`bands[${i}].label must be a non-empty string — the label is what gets read first`);
    }
    return { min: bb.min as number | null, verdict: bb.verdict as Verdict, label: bb.label };
  });

  // The catch-all must be last and unique: without it a number below every bound matches
  // nothing, which is exactly the gap that produces a decision made after the number is known.
  const nullAt = bands.map((b, i) => (b.min === null ? i : -1)).filter((i) => i >= 0);
  if (nullAt.length !== 1) {
    throw new PreReadError(
      `exactly one band must have "min": null (the catch-all); found ${nullAt.length}. ` +
      `A gap is how a closeout ends up decided after the number is known.`,
    );
  }
  if (nullAt[0] !== bands.length - 1) {
    throw new PreReadError(`the "min": null catch-all must be the LAST band; it is at index ${nullAt[0]}`);
  }

  // Strictly descending bounds: ordered top-down, evaluated top-down.
  const bounded = bands.slice(0, -1) as (Band & { min: number })[];
  for (let i = 1; i < bounded.length; i++) {
    if (!(bounded[i].min < bounded[i - 1].min)) {
      throw new PreReadError(
        `bands must be ordered by strictly DESCENDING min; bands[${i}].min=${bounded[i].min} ` +
        `is not below bands[${i - 1}].min=${bounded[i - 1].min}`,
      );
    }
  }

  return {
    hypothesis: o.hypothesis,
    metric: o.metric,
    primary: o.primary,
    bands,
    ...(o.void_if === undefined ? {} : { void_if: o.void_if }),
  };
}

/** Parse + validate in one step from a document's raw text. */
export function parseDoc(
  docText: string,
  knownIds: ReadonlySet<string> | null = null,
  knownMetrics: ReadonlySet<string> | null = null,
): PreRead {
  const block = extractBlock(docText);
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch (e) {
    throw new PreReadError(`preread block is not valid JSON: ${(e as Error).message}`);
  }
  return validate(raw, knownIds, knownMetrics);
}

/** Match a value against the bands, top-down, `min` INCLUSIVE. The catch-all always matches, so
 *  this never returns null for a validated PreRead. */
export function classify(bands: Band[], value: number): Band {
  for (const b of bands) {
    if (b.min === null) return b;
    if (value >= b.min) return b;
  }
  // Unreachable for a validated PreRead; kept as a loud failure rather than a silent undefined
  // if an unvalidated list is ever passed in directly.
  throw new PreReadError("no band matched and no catch-all was present — the bands were never validated");
}
