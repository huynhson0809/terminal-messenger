import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

const NOT_CONNECTED = "extension not connected, open the Messenger tab";

function setup({ connected = true, queueFails = false } = {}) {
  const sent = [];
  const lines = [];
  const state = { connected };
  const bridge = {
    send: (m) => sent.push(m),
    isConnected: () => state.connected,
  };
  const queue = {
    enqueue: async (item) => {
      if (queueFails) throw new Error("boom");
      bridge.send({ type: "send", id: item.id, text: item.text });
    },
  };
  const app = createApp({ bridge, print: (l) => lines.push(l), queue });
  return { app, sent, lines, state };
}

const CHATS = [
  { id: "a1", name: "Alice", preview: "hi", unread: false },
  { id: "b2", name: "Bob", preview: "yo", unread: true },
];

async function withChats(ctx) {
  await ctx.app.handleLine("/list");
  ctx.app.handleExtensionMessage({ type: "chats", chats: CHATS });
  ctx.sent.length = 0;
  ctx.lines.length = 0;
}

test("/list sends list request", async () => {
  const c = setup();
  await c.app.handleLine("/list");
  assert.deepEqual(c.sent, [{ type: "list" }]);
});

test("chats message prints numbered chats", () => {
  const c = setup();
  c.app.handleExtensionMessage({ type: "chats", chats: CHATS });
  assert.equal(c.lines.length, 2);
  assert.match(c.lines[0], /1\. Alice/);
  assert.match(c.lines[1], /2\. Bob/);
});

test("/open 2 after list opens second chat", async () => {
  const c = setup();
  await withChats(c);
  await c.app.handleLine("/open 2");
  assert.deepEqual(c.sent, [{ type: "open", id: "b2" }]);
});

test("/open 99 prints error and sends nothing", async () => {
  const c = setup();
  await withChats(c);
  await c.app.handleLine("/open 99");
  assert.deepEqual(c.sent, []);
  assert.equal(c.lines.length, 1);
  assert.match(c.lines[0], /no such conversation|error/i);
});

test("/open with no list loaded prints error", async () => {
  const c = setup();
  await c.app.handleLine("/open 1");
  assert.deepEqual(c.sent, []);
  assert.equal(c.lines.length, 1);
});

test("text with no open conversation is refused", async () => {
  const c = setup();
  await c.app.handleLine("hello");
  assert.deepEqual(c.sent, []);
  assert.deepEqual(c.lines, ["open a conversation first"]);
});

test("text with open conversation goes through queue", async () => {
  const c = setup();
  await withChats(c);
  await c.app.handleLine("/open 1");
  c.sent.length = 0;
  await c.app.handleLine("hello there");
  assert.deepEqual(c.sent, [{ type: "send", id: "a1", text: "hello there" }]);
});

test("// sends text starting with a slash", async () => {
  const c = setup();
  await withChats(c);
  await c.app.handleLine("/open 1");
  c.sent.length = 0;
  await c.app.handleLine("//x");
  assert.deepEqual(c.sent, [{ type: "send", id: "a1", text: "/x" }]);
});

test("unknown command prints error and sends nothing", async () => {
  const c = setup();
  await c.app.handleLine("/bogus");
  assert.deepEqual(c.sent, []);
  assert.match(c.lines[0], /unknown command/);
});

test("empty line does nothing", async () => {
  const c = setup();
  await c.app.handleLine("   ");
  assert.deepEqual(c.sent, []);
  assert.deepEqual(c.lines, []);
});

test("not connected: list, open, and send print notice and send nothing", async () => {
  const c = setup();
  await withChats(c);
  await c.app.handleLine("/open 1");
  c.sent.length = 0;
  c.lines.length = 0;
  c.state.connected = false;
  await c.app.handleLine("/list");
  await c.app.handleLine("/open 2");
  await c.app.handleLine("hello");
  assert.deepEqual(c.sent, []);
  assert.deepEqual(c.lines, [NOT_CONNECTED, NOT_CONNECTED, NOT_CONNECTED]);
});

test("not connected with no open conversation: text still sends nothing", async () => {
  const c = setup({ connected: false });
  await c.app.handleLine("hello");
  assert.deepEqual(c.sent, []);
  assert.equal(c.lines.length, 1);
});

test("/back clears open conversation", async () => {
  const c = setup();
  await withChats(c);
  await c.app.handleLine("/open 1");
  c.sent.length = 0;
  c.lines.length = 0;
  await c.app.handleLine("/back");
  await c.app.handleLine("hello");
  assert.deepEqual(c.sent, []);
  assert.ok(c.lines.includes("open a conversation first"));
});

test("messages for open conversation are printed", async () => {
  const c = setup();
  await withChats(c);
  await c.app.handleLine("/open 1");
  c.lines.length = 0;
  c.app.handleExtensionMessage({
    type: "messages",
    id: "a1",
    messages: [
      { from: "Alice", text: "one", ts: 1 },
      { from: "me", text: "two", ts: 2 },
    ],
  });
  assert.deepEqual(c.lines, ["Alice: one", "me: two"]);
});

test("incoming for open conversation prints message line", async () => {
  const c = setup();
  await withChats(c);
  await c.app.handleLine("/open 1");
  c.lines.length = 0;
  c.app.handleExtensionMessage({
    type: "incoming",
    id: "a1",
    name: "Alice",
    message: { from: "Alice", text: "ping", ts: 3 },
  });
  assert.deepEqual(c.lines, ["Alice: ping"]);
});

test("incoming for another conversation prints [new] notice", async () => {
  const c = setup();
  await withChats(c);
  await c.app.handleLine("/open 1");
  c.lines.length = 0;
  c.app.handleExtensionMessage({
    type: "incoming",
    id: "b2",
    name: "Bob",
    message: { from: "Bob", text: "psst", ts: 3 },
  });
  assert.deepEqual(c.lines, ["[new] Bob: psst"]);
});

test("incoming with no open conversation prints [new] notice", () => {
  const c = setup();
  c.app.handleExtensionMessage({
    type: "incoming",
    id: "b2",
    name: "Bob",
    message: { from: "Bob", text: "psst", ts: 3 },
  });
  assert.deepEqual(c.lines, ["[new] Bob: psst"]);
});

test("extension error is printed", () => {
  const c = setup();
  c.app.handleExtensionMessage({ type: "error", message: "tab crashed" });
  assert.equal(c.lines.length, 1);
  assert.match(c.lines[0], /tab crashed/);
});

test("sent confirmation is printed", () => {
  const c = setup();
  c.app.handleExtensionMessage({ type: "sent", id: "a1" });
  assert.equal(c.lines.length, 1);
  assert.match(c.lines[0], /sent/i);
});

test("rejected send prints error and does not throw", async () => {
  const c = setup({ queueFails: true });
  await withChats(c);
  await c.app.handleLine("/open 1");
  c.lines.length = 0;
  await c.app.handleLine("hello");
  assert.equal(c.lines.length, 1);
  assert.match(c.lines[0], /send failed.*boom/);
});

test("unknown extension message is ignored", () => {
  const c = setup();
  c.app.handleExtensionMessage({ type: "weird" });
  c.app.handleExtensionMessage(null);
  assert.deepEqual(c.lines, []);
});

const EVIL = "a\u001b[2Jb\u001b]52;c;x\u0007c\nme: forged\rz";
function assertClean(lines) {
  assert.equal(lines.length > 0, true);
  for (const l of lines) assert.doesNotMatch(l, /[\u0000-\u001f\u007f-\u009f]/);
}

test("remote text is stripped of control chars in every field", async () => {
  const c = setup();
  c.app.handleExtensionMessage({
    type: "chats",
    chats: [{ id: "a1", name: EVIL, preview: EVIL, unread: true }],
  });
  assertClean(c.lines);
  assert.equal(c.lines.length, 1);
  c.lines.length = 0;
  await c.app.handleLine("/open 1");
  c.app.handleExtensionMessage({
    type: "messages", id: "a1", messages: [{ from: EVIL, text: EVIL, ts: 1 }],
  });
  assertClean(c.lines);
  assert.equal(c.lines.length, 1);
  c.lines.length = 0;
  c.app.handleExtensionMessage({
    type: "incoming", id: "a1", name: EVIL, message: { from: EVIL, text: EVIL, ts: 1 },
  });
  c.app.handleExtensionMessage({
    type: "incoming", id: "zz", name: EVIL, message: { from: EVIL, text: EVIL, ts: 1 },
  });
  assertClean(c.lines);
  assert.equal(c.lines.length, 2);
  c.lines.length = 0;
  c.app.handleExtensionMessage({ type: "error", message: EVIL });
  assertClean(c.lines);
  assert.equal(c.lines.length, 1);
});

test("malformed payloads print an error and never throw", async () => {
  const c = setup();
  await withChats(c);
  await c.app.handleLine("/open 1");
  c.lines.length = 0;
  const bad = [
    { type: "incoming", id: "a1", name: "A" },
    { type: "incoming", id: "b2", name: "B", message: null },
    { type: "chats", chats: [null] },
    { type: "chats", chats: "nope" },
    { type: "messages", id: "a1", messages: [null] },
    { type: "messages", id: "a1", messages: 5 },
  ];
  for (const m of bad) assert.doesNotThrow(() => c.app.handleExtensionMessage(m));
  assert.equal(c.lines.length, bad.length);
  for (const l of c.lines) assert.match(l, /^error: malformed/);
  c.lines.length = 0;
  for (const m of [null, 5, "x", {}, { type: "nope" }]) {
    assert.doesNotThrow(() => c.app.handleExtensionMessage(m));
  }
  assert.deepEqual(c.lines, []);
});

test("bad chats payload leaves previous chat list intact", async () => {
  const c = setup();
  await withChats(c);
  c.app.handleExtensionMessage({ type: "chats", chats: [null] });
  c.sent.length = 0;
  await c.app.handleLine("/open 2");
  assert.deepEqual(c.sent, [{ type: "open", id: "b2" }]);
});
