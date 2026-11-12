// capture-valid: the one definition of a replayable captured exchange, shared by every replay tool. An exchange
// is invalid if the upstream answered with a non-2xx status, the response carries an `error`, it has no
// choices, its request has no messages, or its streamed response was marked invalid by wire-tap
// (src/capture/sse.ts: a malformed event, an error event, or a stream cut off before it finished). A failed or
// partial answer must never be replayed or forced back into a harness as though it were what the model said,
// and it must never be silently dropped either: dropping one exchange shifts every later step number.

/** Why a response's first choice carries no usable token log probabilities (empty = usable). A server that ignores
 *  `logprobs: true` answers without them, and reading that as "the pattern did not occur" would turn a broken
 *  measurement into a confident null: `choices[0].logprobs.content` must be a non-empty array of
 *  { token: string, logprob: finite number <= 0, top_logprobs: array of the same shape }. */
export function logprobProblems(res: any): string[] {
  const content = res?.choices?.[0]?.logprobs?.content;
  if (!Array.isArray(content)) return ["the response has no choices[0].logprobs.content array (does the server honour logprobs: true?)"];
  if (content.length === 0) return ["choices[0].logprobs.content is empty"];
  const out: string[] = [];
  const entry = (x: any) => !!x && typeof x === "object" && typeof x.token === "string" && typeof x.logprob === "number" && Number.isFinite(x.logprob) && x.logprob <= 0;
  for (let i = 0; i < content.length; i++) {
    const t = content[i];
    if (!entry(t)) { out.push(`logprob entry ${i} is not { token: string, logprob: finite number <= 0 }`); continue; }
    const top = t.top_logprobs;
    if (!Array.isArray(top)) { out.push(`logprob entry ${i} has no top_logprobs array`); continue; }
    for (let k = 0; k < top.length; k++) if (!entry(top[k])) { out.push(`logprob entry ${i} top_logprobs[${k}] is malformed`); break; }
  }
  return out;
}

/** Why a response's choices are not a usable model answer (empty = usable). Every choice must carry an assistant
 *  `message` with either text content or a non-empty list of well-formed tool calls (an id, type "function", a
 *  function name and a string of arguments): a bare `choices: [{}]` or `message: {}` would otherwise replay as an
 *  empty assistant turn. Shared with the live replay endpoint. */
export function choiceProblems(choices: unknown): string[] {
  if (!Array.isArray(choices) || choices.length === 0) return ["no choices"];
  const out: string[] = [];
  // choice indexes, when given, must be exactly 0..n-1 (unique, no gap): a missing index is a choice the response
  // never delivered. A server that omits index on every choice is taken in array order.
  const idx = choices.map((c: any) => c?.index);
  if (idx.some((x) => x !== undefined)) {
    const ok = idx.every((x) => Number.isSafeInteger(x) && x >= 0 && x < choices.length) && new Set(idx).size === choices.length;
    if (!ok) out.push(`choice indexes ${JSON.stringify(idx)} are not 0..${choices.length - 1}`);
  }
  choices.forEach((c: any, i) => {
    const m = c?.message;
    if (m == null || typeof m !== "object" || Array.isArray(m)) { out.push(`choice ${i} has no message`); return; }
    if (m.role !== "assistant") out.push(`choice ${i} message role is not assistant`);
    if (m.content !== undefined && m.content !== null && typeof m.content !== "string") out.push(`choice ${i} content is neither text nor null`);
    const calls = m.tool_calls;
    if (calls !== undefined && calls !== null) {
      // a plain for loop: .some() skips array holes, so a sparse list (a call at index 1 only) would look well formed
      let bad = !Array.isArray(calls);
      if (!bad) for (let k = 0; k < calls.length; k++) {
        const t: any = calls[k];
        if (!(k in calls) || t == null || typeof t !== "object" || typeof t.id !== "string" || t.id === "" ||
            t.type !== "function" || typeof t.function?.name !== "string" || t.function.name === "" || typeof t.function.arguments !== "string") { bad = true; break; }
      }
      if (bad) out.push(`choice ${i} has a malformed tool call`);
    }
    // an empty string is not an answer: with no tool calls the message must carry some text
    const hasText = typeof m.content === "string" && m.content !== "", hasCalls = Array.isArray(calls) && calls.length > 0;
    if (!hasText && !hasCalls) out.push(`choice ${i} has neither text content nor tool calls`);
  });
  return out;
}

/** Why one captured exchange cannot be replayed (empty = valid). */
export function captureProblems(s: any): string[] {
  const out: string[] = [];
  const status = s?.status;
  // the status is what proves the upstream answered: absent or not a whole number is unverifiable, not "probably ok"
  if (!Number.isSafeInteger(status)) out.push(`no HTTP status (${JSON.stringify(status)})`);
  else if (status < 200 || status > 299) out.push(`HTTP ${status}`);
  const r = s?.response;
  if (r == null || typeof r !== "object") out.push("no parseable response");
  else {
    if (r.error != null) out.push("error in response");
    out.push(...choiceProblems(r.choices));
    if (r.stream_invalid) out.push(`invalid stream${Array.isArray(r.invalid_reasons) ? ` (${r.invalid_reasons.join(", ")})` : ""}`);
  }
  if (!Array.isArray(s?.request?.messages) || s.request.messages.length === 0) out.push("no request messages");
  return out;
}

export function invalidSeqs(snaps: any[]): number[] {
  return snaps.filter((s) => captureProblems(s).length).map((s) => s.seq);
}

/** Throws, naming every invalid snapshot's seq and why, if any snapshot in `snaps` cannot be replayed, or if the
 *  seq numbers are not positive whole numbers unique within the trajectory (they ARE the step order). The whole
 *  trajectory is refused: filtering out the bad rows would renumber the steps after them. */
export function assertValidCaptures(snaps: any[], where: string): void {
  const seen = new Set<number>();
  const bad = snaps.map((s) => {
    const why = captureProblems(s), q = s?.seq;
    if (typeof q !== "number" || !Number.isSafeInteger(q) || q < 1) why.push("seq is not a positive whole number");
    else if (seen.has(q)) why.push("duplicate seq");
    else seen.add(q);
    return { seq: q, why };
  }).filter((b) => b.why.length);
  if (bad.length) throw new Error(`${where}: ${bad.length} captured exchange(s) cannot be replayed (${bad.slice(0, 10).map((b) => `seq ${b.seq}: ${b.why.join(", ")}`).join("; ")}${bad.length > 10 ? "; ..." : ""}); refusing the whole trajectory`);
}
