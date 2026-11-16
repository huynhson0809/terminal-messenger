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

test("/react takes a number from 1 to 6 and an optional message number", () => {
  assert.deepEqual(parseCommand("/react 1"), { kind: "react", n: 1 });
  assert.deepEqual(parseCommand("/react 6"), { kind: "react", n: 6 });
  assert.deepEqual(parseCommand("/react 2 15"), { kind: "react", n: 2, msg: 15 });
  for (const bad of ["/react", "/react 0", "/react 7", "/react abc", "/react 1 0", "/react 1 x", "/react 1 2 3", "/react 10"]) {
    const r = parseCommand(bad);
    assert.equal(r.kind, "error", bad);
    assert.match(r.message, /usage: \/react/);
  }
});

test("/reply needs a message number and text", () => {
  assert.deepEqual(parseCommand("/reply 3 hello  there"), { kind: "reply", msg: 3, text: "hello  there" });
  for (const bad of ["/reply", "/reply 3", "/reply 0 hi", "/reply x hi", "/reply hi"]) {
    const r = parseCommand(bad);
    assert.equal(r.kind, "error", bad);
    assert.match(r.message, /usage: \/reply/);
  }
});

test("/clear and /more", () => {
  assert.deepEqual(parseCommand("/clear"), { kind: "clear" });
  assert.deepEqual(parseCommand("/more"), { kind: "more" });
});
