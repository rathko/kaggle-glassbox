import { test, expect } from "bun:test";
import { captureProblems, choiceProblems } from "./capture-valid";

const msg = { role: "assistant", content: "a" };
const snap = (extra: any = {}, choices: any[] = [{ index: 0, message: msg }]) => ({ seq: 1, status: 200, request: { messages: [{ role: "user", content: "q" }] }, response: { choices }, ...extra });

test("the HTTP status must be a whole number in 200..299; absent or mistyped is unverifiable", () => {
  expect(captureProblems(snap())).toEqual([]);
  expect(captureProblems(snap({ status: "500" })).join()).toContain("no HTTP status");
  expect(captureProblems(snap({ status: undefined })).join()).toContain("no HTTP status");
  expect(captureProblems(snap({ status: 200.5 })).join()).toContain("no HTTP status");
  expect(captureProblems(snap({ status: 503 }))).toContain("HTTP 503");
});

test("choice indexes, when given, are exactly 0..n-1", () => {
  expect(choiceProblems([{ index: 0, message: msg }, { index: 1, message: msg }])).toEqual([]);
  expect(choiceProblems([{ message: msg }])).toEqual([]); // a server that omits index entirely
  expect(choiceProblems([{ index: 1, message: msg }]).join()).toContain("choice indexes");
  expect(choiceProblems([{ index: 0, message: msg }, { index: 0, message: msg }]).join()).toContain("choice indexes");
  expect(choiceProblems([{ index: 0, message: msg }, { message: msg }]).join()).toContain("choice indexes");
});

test("an empty answer with no tool calls is not a usable message", () => {
  expect(choiceProblems([{ index: 0, message: { role: "assistant", content: "" } }]).join()).toContain("neither text content nor tool calls");
  const call = { id: "c1", type: "function", function: { name: "f", arguments: "{}" } };
  expect(choiceProblems([{ index: 0, message: { role: "assistant", content: "", tool_calls: [call] } }])).toEqual([]);
});

test("a sparse tool-call list (a hole that .some() would skip) is malformed", () => {
  const call = { id: "c1", type: "function", function: { name: "f", arguments: "{}" } };
  const sparse: any[] = []; sparse[1] = call;
  expect(choiceProblems([{ index: 0, message: { role: "assistant", content: null, tool_calls: sparse } }]).join()).toContain("malformed tool call");
});
