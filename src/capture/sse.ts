// sse: rebuild one chat-completions response object from an OpenAI-style server-sent-event stream, so a
// streamed exchange is captured in the same shape as a non-streamed one (choices[i].message with content,
// reasoning, tool_calls; finish_reason; usage). Pure, no I/O.

/** Splits a server-sent-event stream into its events: the event name (`event:` field, "message" when absent)
 *  and the data payload. Events end at a blank line; the "data:" lines of one event are joined with newlines
 *  (the SSE rule); id:, retry: and comment lines are ignored. An event that names itself (`event: error`) is
 *  emitted even with no data line: a browser would drop it, but a bare named error still tells us the server
 *  failed, so it must not vanish from the capture. */
export function sseTypedEvents(text: string): { event: string; data: string }[] {
  const out: { event: string; data: string }[] = [];
  let data: string[] = [], event = "message", named = false;
  const flush = () => { if (data.length || named) out.push({ event, data: data.join("\n") }); data = []; event = "message"; named = false; };
  for (const line of text.split(/\r?\n/)) {
    if (line === "") { flush(); continue; }
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    else if (line.startsWith("event:")) { event = line.slice(6).trim() || "message"; named = true; }
  }
  flush();
  return out;
}

/** The data payloads only (see sseTypedEvents); a named event with no data line carries none. */
export function sseEvents(text: string): string[] {
  return sseTypedEvents(text).filter((e) => e.data !== "" || e.event === "message").map((e) => e.data);
}

/** `opts.n`: the number of choices the request asked for (the request's `n`), when known. With n > 1 every streamed
 *  choice must carry its index, since an unindexed one cannot be told apart from choice 0. */
export function assembleSse(text: string, opts: { n?: unknown } = {}): any | null {
  const wantMany = typeof opts.n === "number" && opts.n > 1;
  const chunks: any[] = [];
  const malformed: string[] = [], errors: string[] = [], afterDone: string[] = [], afterFinish: string[] = [];
  let done = false;
  for (const { event, data } of sseTypedEvents(text)) {
    // a client stops reading at the first [DONE]; anything the server sends after it was never seen by the agent, so
    // it is not assembled into the answer, and its presence makes the capture invalid (it disagrees with the run)
    if (done) { afterDone.push(data.slice(0, 200)); continue; }
    // a named `event: error` is a failure whatever its data looks like
    if (event === "error") { errors.push(data.slice(0, 200) || "(event: error with no data)"); continue; }
    // any other named event with no data line (a keep-alive `event: ping`) carries nothing to assemble
    if (data === "" && event !== "message") continue;
    if (data.trim() === "[DONE]") { done = true; continue; }
    let c: any;
    try { c = JSON.parse(data); } catch { malformed.push(data.slice(0, 200)); continue; }
    // a chunk is a JSON object; `data: null`, a number, a string or an array is a malformed event, not a crash
    if (!c || typeof c !== "object" || Array.isArray(c)) { malformed.push(data.slice(0, 200)); continue; }
    // a server that fails mid-stream sends a JSON error event; it is not a chunk of the answer
    if (c && typeof c === "object" && c.error != null) { errors.push(JSON.stringify(c.error).slice(0, 200)); continue; }
    chunks.push(c);
  }
  if (!chunks.length && !malformed.length && !errors.length && !afterDone.length) return null;
  const choices: any[] = [];
  let usage: any = null, id: any = null, model: any = null, created: any = null;
  for (const c of chunks) {
    id ??= c.id; model ??= c.model; created ??= c.created;
    if (c.usage) usage = c.usage;
    if (c.choices != null && !Array.isArray(c.choices)) { malformed.push(JSON.stringify(c).slice(0, 200)); continue; }
    // an event carrying several choices must say which is which: without an index each one would land on choice 0
    // and two answers would be glued into one. Indexes are checked before anything is accumulated, and capped, so a
    // stray huge index cannot build a vast sparse array.
    const evChoices: any[] = c.choices ?? [];
    const seenIdx = new Set<number>();
    const badEvent = evChoices.some((ch) => {
      if (!ch || typeof ch !== "object") return false; // reported per choice below
      if (ch.index == null) return evChoices.length > 1 || wantMany;
      if (!validIndex(ch.index) || seenIdx.has(ch.index)) return true;
      seenIdx.add(ch.index);
      return false;
    });
    if (badEvent) { malformed.push(JSON.stringify(c).slice(0, 200)); continue; }
    for (const ch of evChoices) {
      if (!ch || typeof ch !== "object") { malformed.push(JSON.stringify(ch).slice(0, 200)); continue; }
      const i = ch.index ?? 0;
      const acc = (choices[i] ??= { index: i, message: { role: "assistant", content: "" }, finish_reason: null });
      if (ch.delta != null && (typeof ch.delta !== "object" || Array.isArray(ch.delta))) { malformed.push(JSON.stringify(ch).slice(0, 200)); continue; }
      // finish_reason is null or a non-empty string: `true` or a number would otherwise read as "finished" and vouch
      // for a stream that was cut off
      if (ch.finish_reason != null && (typeof ch.finish_reason !== "string" || ch.finish_reason === "")) { malformed.push(JSON.stringify(ch).slice(0, 200)); continue; }
      const d = ch.delta ?? {};
      if ((d.content != null && typeof d.content !== "string") || (d.role != null && typeof d.role !== "string") || (d.tool_calls != null && !Array.isArray(d.tool_calls))
        || (d.reasoning_content != null && typeof d.reasoning_content !== "string") || (d.reasoning != null && typeof d.reasoning !== "string")) { malformed.push(JSON.stringify(ch).slice(0, 200)); continue; }
      // once a choice has finished, nothing more may be added to it: a second unindexed answer ("A" finished, then
      // "B") would otherwise be glued onto the first as "AB" and look like one valid choice
      const adds = (typeof d.content === "string" && d.content !== "") || (Array.isArray(d.tool_calls) && d.tool_calls.length > 0)
        || ["reasoning_content", "reasoning"].some((k) => typeof d[k] === "string" && d[k] !== "");
      if (acc.finish_reason && adds) { afterFinish.push(JSON.stringify(ch).slice(0, 200)); continue; }
      if (d.role) acc.message.role = d.role;
      if (typeof d.content === "string") acc.message.content += d.content;
      for (const k of ["reasoning_content", "reasoning"]) if (typeof d[k] === "string") acc.message[k] = (acc.message[k] ?? "") + d[k];
      for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        if (!tc || typeof tc !== "object" || (tc.index != null && !validIndex(tc.index))) { malformed.push(JSON.stringify(tc).slice(0, 200)); continue; }
        // every present field must already be the string it will be accumulated into: a number name or an object
        // argument would otherwise be coerced ("123", "[object Object]") into a valid-looking call the model never made
        const fn = tc.function;
        const str = (v: unknown) => v == null || typeof v === "string";
        if (!str(tc.id) || !str(tc.type) || (fn != null && (typeof fn !== "object" || Array.isArray(fn) || !str(fn.name) || !str(fn.arguments)))) { malformed.push(JSON.stringify(tc).slice(0, 200)); continue; }
        const calls = (acc.message.tool_calls ??= []);
        const t = (calls[tc.index ?? calls.length] ??= { id: tc.id, type: tc.type ?? "function", function: { name: "", arguments: "" } });
        if (tc.id) t.id = tc.id;
        if (tc.function?.name) t.function.name += tc.function.name;
        if (tc.function?.arguments) t.function.arguments += tc.function.arguments;
      }
      if (typeof ch.finish_reason === "string") acc.finish_reason = ch.finish_reason;
    }
  }
  // A stream is invalid when an event is not JSON, when it carries an error, when the choice indexes have a gap
  // (a choice that never started: [DONE] does not vouch for it), or when it stops without [DONE] while any emitted
  // choice still lacks a finish_reason (cut off): a replay must not treat a partial message as what the model said.
  // One finished choice does not vouch for another (n > 1).
  const out = choices.filter(Boolean);
  const gap = out.length !== choices.length;
  // a tool call that never started (calls at index 0 and 2, none at 1) is a hole the array methods would skip
  const callGap = out.some((c) => { const t = c.message.tool_calls; if (!Array.isArray(t)) return false; for (let k = 0; k < t.length; k++) if (!(k in t)) return true; return false; });
  const truncated = !done && (out.length === 0 || out.some((c) => !c.finish_reason));
  const reasons = [...(malformed.length ? ["malformed event"] : []), ...(errors.length ? ["error event"] : []), ...(afterDone.length ? ["data after [DONE]"] : []),
    ...(gap ? ["missing choice index"] : []), ...(afterFinish.length ? ["delta after finish_reason"] : []), ...(callGap ? ["missing tool-call index"] : []),
    ...(truncated ? [out.some((c) => c.finish_reason) ? "no [DONE] and an unfinished choice" : "no [DONE] and no finish_reason"] : [])];
  return { id, object: "chat.completion", model, created, choices: out, usage, streamed: true,
    ...(reasons.length ? { stream_invalid: true, invalid_reasons: reasons } : {}),
    ...(malformed.length ? { malformed_events: malformed } : {}), ...(errors.length ? { error_events: errors } : {}),
    ...(afterDone.length ? { after_done_events: afterDone } : {}), ...(afterFinish.length ? { after_finish_events: afterFinish } : {}) };
}

/** Largest choice or tool-call index accepted: far above any real response, small enough that a corrupt index
 *  cannot allocate a huge sparse array. */
export const MAX_STREAM_INDEX = 1024;
function validIndex(i: unknown): i is number {
  return Number.isSafeInteger(i) && (i as number) >= 0 && (i as number) < MAX_STREAM_INDEX;
}
