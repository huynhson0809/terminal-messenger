import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "../src/commands.js";

test("/list", () => {
  assert.deepEqual(parseCommand("/list"), { kind: "list" });
});

test("/open N", () => {
  assert.deepEqual(parseCommand("/open 2"), { kind: "open", n: 2 });
});

test("/open with bad or missing arg is an error", () => {
  assert.equal(parseCommand("/open abc").kind, "error");
  assert.equal(parseCommand("/open").kind, "error");
});

test("typo'd command suggests /open", () => {
  const r = parseCommand("/opn 1");
  assert.equal(r.kind, "error");
  assert.match(r.message, /\/open/);
});

test("unknown command is an error, not sent", () => {
  assert.equal(parseCommand("/shrug").kind, "error");
});

test("plain text is sent", () => {
  assert.deepEqual(parseCommand("hello there"), { kind: "send", text: "hello there" });
});

test("blank is empty", () => {
  assert.deepEqual(parseCommand("   "), { kind: "empty" });
});

test("// escapes a leading slash", () => {
  assert.deepEqual(parseCommand("//literal"), { kind: "send", text: "/literal" });
});

test("/back and /quit", () => {
  assert.deepEqual(parseCommand("/back"), { kind: "back" });
  assert.deepEqual(parseCommand("/quit"), { kind: "quit" });
});
