import { test } from "node:test";
import assert from "node:assert/strict";
import { renderChats, renderMessage } from "../src/render.js";

test("renderChats numbers from 1 and marks unread with a dot", () => {
  const lines = renderChats([
    { id: "a", name: "Alice", preview: "hi", unread: true },
    { id: "b", name: "Bob", preview: "yo", unread: false },
  ]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\u25cf\s*1\b.*Alice.*hi/);
  assert.match(lines[1], /^\s+2\b.*Bob.*yo/);
  assert.ok(!lines[1].includes("\u25cf"));
  assert.ok(!lines.join("").includes("\x1b")); // no escape codes unless asked
});

test("renderChats bolds only the unread rows when asked", () => {
  const lines = renderChats(
    [
      { id: "a", name: "Alice", preview: "hi", unread: true },
      { id: "b", name: "Bob", preview: "yo", unread: false },
    ],
    { bold: true },
  );
  assert.equal(lines[0], "\x1b[1m\u25cf 1. Alice - hi\x1b[0m");
  assert.equal(lines[1], "  2. Bob - yo");
});

test("renderMessage shows text with sender", () => {
  const s = renderMessage({ from: "u1", text: "hello", ts: 0 }, "Alice");
  assert.match(s, /Alice/);
  assert.match(s, /hello/);
});

test("renderMessage falls back to from when no name", () => {
  assert.match(renderMessage({ from: "u1", text: "hello", ts: 0 }), /u1/);
});

test("renderMessage shows [attachment] for empty/null text", () => {
  assert.match(renderMessage({ from: "u1", text: "", ts: 0 }), /\[attachment\]/);
  assert.match(renderMessage({ from: "u1", text: null, ts: 0 }), /\[attachment\]/);
});
