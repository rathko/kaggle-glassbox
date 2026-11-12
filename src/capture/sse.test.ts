import { test, expect } from "bun:test";
import { assembleSse, sseTypedEvents } from "./sse";

const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

test("content, reasoning, tool-call arguments and usage are reassembled from the deltas", () => {
  const s = [
    ev({ id: "x", model: "m", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "think " } }] }),
    ev({ id: "x", choices: [{ index: 0, delta: { reasoning_content: "more", content: "Hel" } }] }),
    ev({ id: "x", choices: [{ index: 0, delta: { content: "lo" } }] }),
    ev({ id: "x", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "run", arguments: '{"cmd":' } }] } }] }),
    ev({ id: "x", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, finish_reason: "tool_calls" }] }),
    ev({ id: "x", choices: [], usage: { prompt_tokens: 5, completion_tokens: 7 } }),
    "data: [DONE]\n\n",
  ].join("");
  const r = assembleSse(s);
  expect(r.choices[0].message.content).toBe("Hello");
  expect(r.choices[0].message.reasoning_content).toBe("think more");
  expect(r.choices[0].message.tool_calls[0]).toEqual({ id: "c1", type: "function", function: { name: "run", arguments: '{"cmd":"ls"}' } });
  expect(JSON.parse(r.choices[0].message.tool_calls[0].function.arguments)).toEqual({ cmd: "ls" });
  expect(r.choices[0].finish_reason).toBe("tool_calls");
  expect(r.usage.completion_tokens).toBe(7);
  expect(r.streamed).toBe(true);
});

test("no data events gives null; a malformed event marks the whole capture invalid", () => {
  expect(assembleSse(": keep-alive\n\n")).toBeNull();
  const r = assembleSse("data: {oops\n\n" + ev({ choices: [{ index: 0, delta: { content: "a" } }] }));
  expect(r.stream_invalid).toBe(true);
  expect(r.malformed_events).toEqual(["{oops"]);
  expect(assembleSse(ev({ choices: [{ index: 0, delta: { content: "a" } }] }) + "data: [DONE]\n\n").stream_invalid).toBeUndefined();
});

test("one event's data may span several data: lines (joined with newlines), and event:/id: fields are ignored", () => {
  const s = 'event: chunk\nid: 1\ndata: {"choices":[{"index":0,\ndata: "delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n';
  expect(assembleSse(s).choices[0].message.content).toBe("x");
});

test("a stream cut off before [DONE] and before any finish_reason is invalid; a finish_reason alone is enough", () => {
  const cut = assembleSse(ev({ choices: [{ index: 0, delta: { content: "partial" } }] }));
  expect(cut.stream_invalid).toBe(true);
  expect(cut.invalid_reasons).toEqual(["no [DONE] and no finish_reason"]);
  const finished = assembleSse(ev({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }] }));
  expect(finished.stream_invalid).toBeUndefined();
});

test("a JSON error event mid-stream marks the capture invalid and is not merged into the answer", () => {
  const r = assembleSse(ev({ choices: [{ index: 0, delta: { content: "partial" } }] }) + ev({ error: { message: "cut off" } }) + "data: [DONE]\n\n");
  expect(r.stream_invalid).toBe(true);
  expect(r.invalid_reasons).toEqual(["error event"]);
  expect(r.error_events[0]).toContain("cut off");
  expect(r.choices[0].message.content).toBe("partial");
});

test("a named `event: error` marks the stream invalid even when its data has no error field", () => {
  const r = assembleSse(ev({ choices: [{ index: 0, delta: { content: "partial" }, finish_reason: "stop" }] }) + 'event: error\ndata: {"message":"overloaded"}\n\n' + "data: [DONE]\n\n");
  expect(r.stream_invalid).toBe(true);
  expect(r.invalid_reasons).toEqual(["error event"]);
  expect(r.error_events[0]).toContain("overloaded");
  expect(sseTypedEvents('event: ping\ndata: x\n\ndata: y\n\n')).toEqual([{ event: "ping", data: "x" }, { event: "message", data: "y" }]);
});

test("a bare `event: error` with no data line still invalidates the stream; a bare keep-alive does not", () => {
  const done = ev({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] });
  const r = assembleSse(done + "event: error\n\n" + "data: [DONE]\n\n");
  expect(r.stream_invalid).toBe(true);
  expect(r.invalid_reasons).toEqual(["error event"]);
  expect(sseTypedEvents("event: error\n\n")).toEqual([{ event: "error", data: "" }]);
  const k = assembleSse(done + "event: ping\n\n" + "data: [DONE]\n\n");
  expect(k.stream_invalid).toBeUndefined();
  expect(k.choices[0].message.content).toBe("ok");
});

test("without [DONE], every choice must have finished: one finished choice does not vouch for an unfinished one", () => {
  const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const cut = ev({ id: "x", choices: [{ index: 0, delta: { content: "par" } }, { index: 1, delta: { content: "whole" }, finish_reason: "stop" }] });
  const r = assembleSse(cut)!;
  expect(r.stream_invalid).toBe(true);
  expect(r.invalid_reasons).toContain("no [DONE] and an unfinished choice");
  const both = ev({ id: "x", choices: [{ index: 0, delta: { content: "a" }, finish_reason: "stop" }, { index: 1, delta: { content: "b" }, finish_reason: "stop" }] });
  expect(assembleSse(both)!.stream_invalid).toBeUndefined();
  const gap = ev({ id: "x", choices: [{ index: 1, delta: { content: "b" }, finish_reason: "stop" }] });
  expect(assembleSse(gap)!.stream_invalid).toBe(true);
});

test("a data payload that is valid JSON but not an object (null, a number, an array, a string) marks the stream invalid, never throws", () => {
  const nested = ['{"choices":{}}', '{"choices":[null]}', '{"choices":[{"index":-1}]}', '{"choices":[{"index":0,"delta":{"tool_calls":[null]}}]}', '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":"x"}]}}]}'];
  for (const payload of ["null", "42", "[1,2]", '"text"', ...nested]) {
    const text = `data: ${payload}\n\n` + ev({ choices: [{ index: 0, delta: { content: "a" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n";
    let r: any;
    expect(() => { r = assembleSse(text); }).not.toThrow();
    expect({ payload, invalid: r.stream_invalid }).toEqual({ payload, invalid: true });
    if (!nested.includes(payload)) expect(r.malformed_events).toContain(payload);
    expect(r.malformed_events.length).toBeGreaterThan(0);
  }
});

test("a choice whose delta is not an object, or carries non-string content, marks the stream invalid", () => {
  for (const delta of [42, "x", [1], { content: 5 }, { role: 1 }, { tool_calls: {} }]) {
    const body = `data: ${JSON.stringify({ id: "a", choices: [{ index: 0, delta, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    expect((assembleSse(body) as any).stream_invalid).toBe(true);
  }
});

test("the stream ends at the first [DONE]: later data is not assembled and marks the capture invalid", () => {
  const body = ev({ id: "a", choices: [{ index: 0, delta: { content: "A" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n" + ev({ id: "a", choices: [{ index: 0, delta: { content: "B" } }] });
  const r = assembleSse(body) as any;
  expect(r.choices[0].message.content).toBe("A");
  expect(r.stream_invalid).toBe(true);
  expect(r.invalid_reasons).toContain("data after [DONE]");
  const clean = assembleSse(ev({ id: "a", choices: [{ index: 0, delta: { content: "A" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n") as any;
  expect(clean.stream_invalid).toBeUndefined();
});

test("a tool-call delta field of the wrong type marks the stream invalid instead of being coerced to a string", () => {
  for (const tc of [{ index: 0, function: { name: 123 } }, { index: 0, function: { name: "x", arguments: { path: "x" } } }, { index: 0, id: 7, function: { name: "x" } },
    { index: 0, type: {}, function: { name: "x" } }, { index: 0, function: "x" }, { index: 0, function: ["x"] }]) {
    const r = assembleSse(ev({ id: "a", choices: [{ index: 0, delta: { tool_calls: [tc] }, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n") as any;
    expect(r.stream_invalid).toBe(true);
    expect(JSON.stringify(r.choices[0].message.tool_calls ?? [])).not.toContain("[object Object]");
  }
});

test("a gap in the choice indexes is invalid even when the stream ends with [DONE]", () => {
  const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const r: any = assembleSse(ev({ choices: [{ index: 1, delta: { role: "assistant", content: "x" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
  expect(r.stream_invalid).toBe(true);
  expect(r.invalid_reasons).toContain("missing choice index");
  const ok: any = assembleSse(ev({ choices: [{ index: 0, delta: { role: "assistant", content: "x" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
  expect(ok.stream_invalid).toBeUndefined();
});

test("a finish_reason that is not null or a string is malformed and cannot vouch for a cut-off stream", () => {
  const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  for (const fr of [true, 1, {}, ""]) {
    const r: any = assembleSse(ev({ choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: fr }] }));
    expect(r.stream_invalid).toBe(true);
    expect(r.invalid_reasons).toContain("malformed event");
  }
  const ok: any = assembleSse(ev({ choices: [{ index: 0, delta: { role: "assistant", content: "whole" }, finish_reason: "stop" }] }));
  expect(ok.stream_invalid).toBeUndefined();
});

test("a gap in the tool-call indexes marks the stream invalid", () => {
  const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const r: any = assembleSse(ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n");
  expect(r.stream_invalid).toBe(true);
  expect(r.invalid_reasons).toContain("missing tool-call index");
});

test("several choices in one event must each carry a distinct, bounded index", () => {
  // two unindexed answers in one event would otherwise be glued into choice 0 as "AB"
  const glued = assembleSse(ev({ choices: [{ delta: { content: "A" }, finish_reason: "stop" }, { delta: { content: "B" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
  expect(glued.stream_invalid).toBe(true);
  expect(glued.invalid_reasons).toContain("malformed event");
  expect(glued.choices.map((c: any) => c.message.content)).not.toContain("AB");
  const dup = assembleSse(ev({ choices: [{ index: 0, delta: { content: "A" }, finish_reason: "stop" }, { index: 0, delta: { content: "B" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
  expect(dup.stream_invalid).toBe(true);
  for (const index of [1024, 1e9, -1, 0.5])
    expect(assembleSse(ev({ choices: [{ index, delta: { content: "A" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n").stream_invalid).toBe(true);
  expect(assembleSse(ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 5000, function: { name: "x", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n").stream_invalid).toBe(true);
  // indexed choices in one event are fine, and a lone unindexed choice is choice 0 as before
  const ok = assembleSse(ev({ choices: [{ index: 0, delta: { content: "A" }, finish_reason: "stop" }, { index: 1, delta: { content: "B" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
  expect(ok.stream_invalid).toBeUndefined();
  expect(ok.choices.map((c: any) => c.message.content)).toEqual(["A", "B"]);
  const lone = assembleSse(ev({ choices: [{ delta: { content: "A" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
  expect(lone.stream_invalid).toBeUndefined();
  expect(lone.choices[0].message.content).toBe("A");
});

test("two unindexed answers in separate events are not glued into one: content after a finish_reason is invalid", () => {
  const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const text = ev({ choices: [{ delta: { content: "A" }, finish_reason: "stop" }] }) + ev({ choices: [{ delta: { content: "B" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n";
  const r = assembleSse(text);
  expect(r.stream_invalid).toBe(true);
  expect(r.invalid_reasons).toContain("delta after finish_reason");
  expect(r.choices[0].message.content).toBe("A");
  // a usage-only or empty-delta chunk after the finish is normal and stays valid
  const ok = ev({ choices: [{ index: 0, delta: { content: "A" }, finish_reason: null }] }) + ev({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
    + ev({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + "data: [DONE]\n\n";
  expect(assembleSse(ok).stream_invalid).toBeUndefined();
});

test("with n > 1 requested, every streamed choice must carry its index", () => {
  const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const unindexed = ev({ choices: [{ delta: { content: "A" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n";
  expect(assembleSse(unindexed, { n: 2 }).stream_invalid).toBe(true);
  expect(assembleSse(unindexed).stream_invalid).toBeUndefined();
  const indexed = ev({ choices: [{ index: 0, delta: { content: "A" }, finish_reason: "stop" }] }) + ev({ choices: [{ index: 1, delta: { content: "B" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n";
  const r = assembleSse(indexed, { n: 2 });
  expect(r.stream_invalid).toBeUndefined();
  expect(r.choices.map((c: any) => c.message.content)).toEqual(["A", "B"]);
});
