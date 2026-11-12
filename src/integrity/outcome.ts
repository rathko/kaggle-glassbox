// outcome: the one reading of a binary per-task outcome, shared by the sealed score reader and the frontier analysis
// so they can never disagree about which tasks failed. true/1 is solved, false/0 is not; anything else (a string
// "true", 2, null, a missing field) is not an outcome and must be refused, not guessed.

/** true or false for a valid binary outcome, undefined for anything else. */
export function binaryOutcome(v: unknown): boolean | undefined {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  return undefined;
}
