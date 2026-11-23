import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, createBridgeSender } from "../src/app.js";

const NOT_CONNECTED = "extension not connected, open the Messenger tab";

function fakeTimers() {
  const list = [];
  return {
    list,
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      list.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.live = false;
    },
    live: () => list.filter((t) => t.live),
    fireAll: () => {
      for (const t of list.filter((x) => x.live)) {
        t.live = false;
        t.fn();
      }
    },
  };
}

function setup({ connected = true, queueFails = false } = {}) {
  const sent = [];
  const lines = [];
  const state = { connected };
  const timers = fakeTimers();
  const bridge = {
    send: (m) => sent.push(m),
    isConnected: () => state.connected,
  };
  const queue = {
    enqueue: async (item) => {
      if (queueFails) throw new Error("boom");
      bridge.send({ type: "send", id: item.id, text: item.text, ref: item.ref });
    },
  };
  const app = createApp({
    bridge,
    print: (l) => lines.push(l),
    queue,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { app, sent, lines, state, timers };
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

// /open n and the extension's `messages` reply that confirms it.
async function openChat(ctx, n = 1) {
  await ctx.app.handleLine(`/open ${n}`);
  const chat = CHATS[n - 1];
  ctx.app.handleExtensionMessage({ type: "messages", id: chat.id, title: chat.name, messages: [] });
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

test("text with open conversation goes through queue, with a ref", async () => {
  const c = setup();
  await withChats(c);
  await openChat(c);
  await c.app.handleLine("hello there");
  assert.equal(c.sent.length, 1);
  assert.equal(typeof c.sent[0].ref, "string");
  assert.deepEqual(c.sent, [{ type: "send", id: "a1", text: "hello there", ref: c.sent[0].ref }]);
});

test("// sends text starting with a slash", async () => {
  const c = setup();
  await withChats(c);
  await openChat(c);
  await c.app.handleLine("//x");
  assert.equal(c.sent.length, 1);
  assert.equal(c.sent[0].text, "/x");
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
  await openChat(c);
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
    title: "Alice",
  });
  assert.deepEqual(c.lines, ["-- Alice --", "[1] Alice: one", "[2] me: two"]);
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
  assert.deepEqual(c.lines, ["[1] Alice: ping"]);
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
  await openChat(c);
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
    type: "messages", id: "a1", title: EVIL, messages: [{ from: EVIL, text: EVIL, ts: 1 }],
  });
  assertClean(c.lines);
  assert.equal(c.lines.length, 2);
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

// ---- final-review fix wave ---------------------------------------------------------

test("C1: replies are refused until the extension confirms the open with messages", async () => {
  const c = setup();
  await withChats(c);
  await c.app.handleLine("/open 2");
  c.sent.length = 0;
  c.lines.length = 0;
  await c.app.handleLine("hello");
  assert.deepEqual(c.sent, []);
  assert.equal(c.lines.length, 1);
  assert.match(c.lines[0], /^still opening/);
  // A messages reply for some other chat does not confirm it.
  c.app.handleExtensionMessage({ type: "messages", id: "a1", title: "Alice", messages: [] });
  await c.app.handleLine("hello");
  assert.deepEqual(c.sent, []);
  c.app.handleExtensionMessage({ type: "messages", id: "b2", title: "Bob", messages: [] });
  await c.app.handleLine("hello");
  assert.equal(c.sent.length, 1);
  assert.equal(c.sent[0].id, "b2");
});

test("C1: a new /open un-confirms until its own messages arrive", async () => {
  const c = setup();
  await withChats(c);
  await openChat(c, 1);
  await c.app.handleLine("/open 2");
  c.sent.length = 0;
  await c.app.handleLine("hello");
  assert.deepEqual(c.sent, []);
});

test("C1: messages header shows the chat pane title, with a fallback", async () => {
  const c = setup();
  await withChats(c);
  await c.app.handleLine("/open 1");
  c.lines.length = 0;
  c.app.handleExtensionMessage({ type: "messages", id: "a1", title: "Someone Else", messages: [] });
  assert.deepEqual(c.lines, ["-- Someone Else --"]);
  c.lines.length = 0;
  c.app.handleExtensionMessage({ type: "messages", id: "a1", messages: [] });
  assert.deepEqual(c.lines, ["-- (title unreadable) --"]);
});

test("I1: sent with the matching ref names the message", async () => {
  const c = setup();
  await withChats(c);
  await openChat(c);
  await c.app.handleLine("hello there");
  c.app.handleExtensionMessage({ type: "sent", id: "a1", ref: c.sent[0].ref });
  assert.deepEqual(c.lines, ['sent: "hello there"']);
  assert.equal(c.timers.live().length, 0);
});

test("I1: error with the matching ref is reported as not sent", async () => {
  const c = setup();
  await withChats(c);
  await openChat(c);
  await c.app.handleLine("hello");
  c.app.handleExtensionMessage({ type: "error", message: "tab gone", ref: c.sent[0].ref });
  assert.deepEqual(c.lines, ['not sent: "hello": tab gone']);
});

test("I1: an unconfirmed error says to check with /open before resending", async () => {
  const c = setup();
  await withChats(c);
  await openChat(c, 2);
  await c.app.handleLine("hello");
  c.app.handleExtensionMessage({ type: "error", message: "x", unconfirmed: true, ref: c.sent[0].ref });
  assert.deepEqual(c.lines, ['no confirmation for "hello"; run /open 2 to check before resending']);
});

test("I1: snippets are cut at 30 characters", async () => {
  const c = setup();
  await withChats(c);
  await openChat(c);
  const long = "abcdefghijklmnopqrstuvwxyz0123456789";
  await c.app.handleLine(long);
  c.app.handleExtensionMessage({ type: "sent", id: "a1", ref: c.sent[0].ref });
  assert.deepEqual(c.lines, ['sent: "abcdefghijklmnopqrstuvwxyz0123…"']);
});

test("I1: no reply within the timeout prints a no-confirmation line once", async () => {
  const c = setup();
  await withChats(c);
  await openChat(c);
  await c.app.handleLine("hello");
  assert.equal(c.timers.live().length, 1);
  assert.equal(c.timers.live()[0].ms, 20000);
  c.timers.fireAll();
  assert.deepEqual(c.lines, ['no confirmation for "hello"; run /open 1 to check before resending']);
  // A late reply is still shown, but not as a pending send.
  c.lines.length = 0;
  c.app.handleExtensionMessage({ type: "sent", id: "a1", ref: c.sent[0].ref });
  assert.deepEqual(c.lines, ["sent"]);
});

test("I1: extension disconnect reports every pending send as unconfirmed", async () => {
  const c = setup();
  await withChats(c);
  await openChat(c);
  await c.app.handleLine("one");
  await c.app.handleLine("two");
  c.app.handleStatus(false);
  assert.deepEqual(c.lines, [
    'no confirmation for "one"; run /open 1 to check before resending',
    'no confirmation for "two"; run /open 1 to check before resending',
  ]);
  assert.equal(c.timers.live().length, 0);
  c.lines.length = 0;
  c.app.handleStatus(false);
  assert.deepEqual(c.lines, []);
});

test("I1: a failed enqueue names the message and leaves nothing pending", async () => {
  const c = setup({ queueFails: true });
  await withChats(c);
  await openChat(c);
  await c.app.handleLine("hello");
  assert.deepEqual(c.lines, ['send failed: "hello": boom']);
  assert.equal(c.timers.live().length, 0);
});

test("I1: createBridgeSender throws when the extension is not connected at send time", async () => {
  const sent = [];
  const bridge = { isConnected: () => false, send: (m) => sent.push(m) };
  const send = createBridgeSender(bridge);
  await assert.rejects(send({ id: "a1", text: "hi", ref: "s1" }), /not connected/);
  assert.deepEqual(sent, []);
  bridge.isConnected = () => true;
  await send({ id: "a1", text: "hi", ref: "s1" });
  assert.deepEqual(sent, [{ type: "send", id: "a1", text: "hi", ref: "s1" }]);
});

test("bidi control characters are stripped from remote text", () => {
  const c = setup();
  c.app.handleExtensionMessage({ type: "error", message: "a\u202eb\u2066c\u2069d\u202a" });
  assert.equal(c.lines.length, 1);
  assert.doesNotMatch(c.lines[0], /[\u202a-\u202e\u2066-\u2069]/);
});

// ---- /react ---------------------------------------------------------------

test("/react with no open conversation is refused and sends nothing", async () => {
  const ctx = setup();
  await withChats(ctx);
  await ctx.app.handleLine("/react 1");
  assert.deepEqual(ctx.sent, []);
  assert.match(ctx.lines[0], /open a conversation first/);
});

test("/react while the conversation is still opening is refused", async () => {
  const ctx = setup();
  await withChats(ctx);
  await ctx.app.handleLine("/open 1");
  ctx.sent.length = 0;
  await ctx.app.handleLine("/react 1");
  assert.deepEqual(ctx.sent, []);
  assert.match(ctx.lines.at(-1), /still opening/);
});

test("/react with the extension disconnected prints the notice and sends nothing", async () => {
  const ctx = setup();
  await withChats(ctx);
  await openChat(ctx);
  ctx.state.connected = false;
  await ctx.app.handleLine("/react 2");
  assert.deepEqual(ctx.sent, []);
  assert.deepEqual(ctx.lines, [NOT_CONNECTED]);
});

test("/react n sends one react command for the open chat and reports reacted", async () => {
  const ctx = setup();
  await withChats(ctx);
  await openChat(ctx, 2);
  await ctx.app.handleLine("/react 3");
  assert.equal(ctx.sent.length, 1);
  const cmd = ctx.sent[0];
  assert.equal(cmd.type, "react");
  assert.equal(cmd.id, "b2");
  assert.equal(cmd.n, 3);
  assert.match(cmd.ref, /^r\d+$/);
  ctx.app.handleExtensionMessage({ type: "reacted", id: "b2", ref: cmd.ref });
  assert.match(ctx.lines.at(-1), /^reacted .*haha/);
  assert.equal(ctx.timers.live().length, 0);
});

test("a failed reaction is reported as not reacted, not as not sent", async () => {
  const ctx = setup();
  await withChats(ctx);
  await openChat(ctx);
  await ctx.app.handleLine("/react 1");
  const { ref } = ctx.sent[0];
  ctx.app.handleExtensionMessage({ type: "error", message: "the reaction picker didn't open; not reacted", ref });
  assert.match(ctx.lines.at(-1), /^not reacted .*like: the reaction picker didn't open/);
});

test("a reaction with no reply is reported as unconfirmed after the timeout", async () => {
  const ctx = setup();
  await withChats(ctx);
  await openChat(ctx);
  await ctx.app.handleLine("/react 5");
  ctx.timers.fireAll();
  assert.match(ctx.lines.at(-1), /no confirmation for reaction .*sad/);
});

// ---- message numbers, /more, /reply, /react <n> <msg#>, /clear -----------------

const THREAD = [
  { from: "Alice", text: "first message", ts: 1 },
  { from: "me", text: "second", ts: 2 },
  { from: "Alice", text: "third one here", ts: 3 },
];

async function openWithMessages(ctx) {
  await ctx.app.handleLine("/open 1");
  ctx.app.handleExtensionMessage({ type: "messages", id: "a1", title: "Alice", messages: THREAD });
  ctx.sent.length = 0;
  ctx.lines.length = 0;
}

test("/clear calls onClear and sends nothing", async () => {
  let cleared = 0;
  const sent = [];
  const app = createApp({
    bridge: { send: (m) => sent.push(m), isConnected: () => true },
    print: () => {},
    queue: { enqueue: async () => {} },
    onClear: () => cleared++,
  });
  await app.handleLine("/clear");
  assert.equal(cleared, 1);
  assert.deepEqual(sent, []);
});

test("/react 2 N targets the Nth printed message by position from the newest and its text", async () => {
  const ctx = setup();
  await withChats(ctx);
  await openWithMessages(ctx);
  await ctx.app.handleLine("/react 2 1");
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].type, "react");
  assert.equal(ctx.sent[0].n, 2);
  assert.deepEqual(ctx.sent[0].target, { fromEnd: 2, text: "first message" });
  await ctx.app.handleLine("/react 1 3");
  assert.deepEqual(ctx.sent[1].target, { fromEnd: 0, text: "third one here" });
});

test("/react with a message number that does not exist sends nothing", async () => {
  const ctx = setup();
  await withChats(ctx);
  await openWithMessages(ctx);
  await ctx.app.handleLine("/react 1 9");
  assert.deepEqual(ctx.sent, []);
  assert.match(ctx.lines.at(-1), /no message 9/);
});

test("/reply N text goes through the queue with its target and a ref", async () => {
  const ctx = setup();
  await withChats(ctx);
  await openWithMessages(ctx);
  await ctx.app.handleLine("/reply 1 sounds good");
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].type, "send"); // the test queue sends a plain send; target is on the queued item
});

test("createBridgeSender turns a queued item with a target into a reply command", async () => {
  const sent = [];
  const send = createBridgeSender({ send: (m) => sent.push(m), isConnected: () => true });
  await send({ id: "a1", text: "hi", ref: "s1", target: { fromEnd: 1, text: "yo" } });
  await send({ id: "a1", text: "hi", ref: "s2" });
  assert.deepEqual(sent, [
    { type: "reply", id: "a1", text: "hi", target: { fromEnd: 1, text: "yo" }, ref: "s1" },
    { type: "send", id: "a1", text: "hi", ref: "s2" },
  ]);
});

test("/reply to a message number that does not exist sends nothing", async () => {
  const ctx = setup();
  await withChats(ctx);
  await openWithMessages(ctx);
  await ctx.app.handleLine("/reply 7 hi");
  assert.deepEqual(ctx.sent, []);
  assert.match(ctx.lines.at(-1), /no message 7/);
});

test("/more needs an open, confirmed, connected conversation", async () => {
  const ctx = setup();
  await withChats(ctx);
  await ctx.app.handleLine("/more");
  assert.deepEqual(ctx.sent, []);
  assert.match(ctx.lines.at(-1), /open a conversation first/);
  await openWithMessages(ctx);
  ctx.state.connected = false;
  await ctx.app.handleLine("/more");
  assert.deepEqual(ctx.sent, []);
  ctx.state.connected = true;
  await ctx.app.handleLine("/more");
  assert.deepEqual(ctx.sent, [{ type: "more", id: "a1" }]);
});

test("older messages are printed at the front with shifted numbers; no older says so", async () => {
  const ctx = setup();
  await withChats(ctx);
  await openWithMessages(ctx);
  const older = [
    { from: "Alice", text: "oldest", ts: 0 },
    { from: "Alice", text: "older", ts: 0 },
  ];
  ctx.app.handleExtensionMessage({ type: "messages", id: "a1", older: true, messages: [...older, ...THREAD] });
  assert.deepEqual(ctx.lines, [
    "-- Alice --",
    "[1] Alice: oldest",
    "[2] Alice: older",
    "[3] Alice: first message",
    "[4] me: second",
    "[5] Alice: third one here",
    "(2 older messages added at the top; message numbers shifted by 2)",
  ]);
  // numbering follows the new list: message 3 is now the old first one
  ctx.sent.length = 0;
  await ctx.app.handleLine("/react 1 3");
  assert.deepEqual(ctx.sent[0].target, { fromEnd: 2, text: "first message" });
  ctx.lines.length = 0;
  ctx.app.handleExtensionMessage({ type: "messages", id: "a1", older: true, messages: [...older, ...THREAD] });
  assert.deepEqual(ctx.lines, ["no older messages"]);
});

test("a confirmed send is added to the thread so message numbers stay aligned", async () => {
  const ctx = setup();
  await withChats(ctx);
  await openWithMessages(ctx);
  await ctx.app.handleLine("brand new reply");
  const ref = ctx.sent[0].ref;
  ctx.app.handleExtensionMessage({ type: "sent", id: "a1", ref });
  ctx.sent.length = 0;
  await ctx.app.handleLine("/react 1 4");
  assert.deepEqual(ctx.sent[0].target, { fromEnd: 0, text: "brand new reply" });
});

test("a /more window that overlaps only the start of what is shown is merged in front of it", async () => {
  const ctx = setup();
  await withChats(ctx);
  await openWithMessages(ctx); // first message, second, third one here
  const chunk = [
    { from: "x", text: "way back", ts: 0 },
    { from: "x", text: "a bit back", ts: 0 },
    { from: "x", text: "first message", ts: 1 }, // same text as thread[0], different attribution
    { from: "x", text: "second", ts: 2 },
  ];
  ctx.app.handleExtensionMessage({ type: "messages", id: "a1", older: true, messages: chunk });
  assert.equal(ctx.lines[0], "-- Alice --");
  assert.deepEqual(ctx.lines.slice(1, 6), [
    "[1] x: way back",
    "[2] x: a bit back",
    "[3] Alice: first message",
    "[4] me: second",
    "[5] Alice: third one here",
  ]);
  assert.match(ctx.lines.at(-1), /2 older messages added at the top/);
});

test("a /more window that overlaps nothing is not merged", async () => {
  const ctx = setup();
  await withChats(ctx);
  await openWithMessages(ctx);
  ctx.app.handleExtensionMessage({
    type: "messages",
    id: "a1",
    older: true,
    messages: [{ from: "x", text: "unrelated", ts: 0 }],
  });
  assert.match(ctx.lines[0], /couldn't line the older messages up/);
  ctx.sent.length = 0;
  await ctx.app.handleLine("/react 1 1");
  assert.deepEqual(ctx.sent[0].target, { fromEnd: 2, text: "first message" }); // thread unchanged
});

test("/more clears the screen before redrawing the whole conversation", async () => {
  let redraws = 0;
  const lines = [];
  const app = createApp({
    bridge: { send: () => {}, isConnected: () => true },
    print: (l) => lines.push(l),
    queue: { enqueue: async () => {} },
    onRedraw: () => redraws++,
  });
  await app.handleLine("/list");
  app.handleExtensionMessage({ type: "chats", chats: CHATS });
  await app.handleLine("/open 1");
  app.handleExtensionMessage({ type: "messages", id: "a1", title: "Alice", messages: THREAD });
  app.handleExtensionMessage({ type: "messages", id: "a1", older: true, messages: [{ from: "A", text: "ancient", ts: 0 }, ...THREAD] });
  assert.equal(redraws, 1);
  // no older messages: no redraw
  app.handleExtensionMessage({ type: "messages", id: "a1", older: true, messages: [{ from: "A", text: "ancient", ts: 0 }, ...THREAD] });
  assert.equal(redraws, 1);
});

test("/help prints every command and sends nothing", async () => {
  const ctx = setup({ connected: false }); // works with no extension connected
  await ctx.app.handleLine("/help");
  assert.deepEqual(ctx.sent, []);
  const text = ctx.lines.join("\n");
  for (const cmd of ["/list", "/open", "/reply", "/react", "/more", "/back", "/clear", "/help", "/quit"]) {
    assert.ok(text.includes(cmd), `help mentions ${cmd}`);
  }
});

// ---- leaving a chat with /list ------------------------------------------------

test("/list leaves the open chat: its new messages become [new] notices", async () => {
  const ctx = setup();
  await withChats(ctx);
  await openChat(ctx, 1);
  ctx.app.handleExtensionMessage({ type: "incoming", id: "a1", name: "Alice", message: { from: "Alice", text: "one", ts: 1 } });
  assert.equal(ctx.lines.at(-1), "[1] Alice: one"); // open: numbered
  await ctx.app.handleLine("/list");
  ctx.lines.length = 0;
  ctx.app.handleExtensionMessage({ type: "incoming", id: "a1", name: "Alice", message: { from: "Alice", text: "two", ts: 2 } });
  assert.deepEqual(ctx.lines, ["[new] Alice: two"]);
});

test("after /list there is no open chat to reply or react in", async () => {
  const ctx = setup();
  await withChats(ctx);
  await openChat(ctx, 1);
  await ctx.app.handleLine("/list");
  ctx.sent.length = 0;
  ctx.lines.length = 0;
  await ctx.app.handleLine("hello");
  await ctx.app.handleLine("/react 1");
  await ctx.app.handleLine("/more");
  assert.deepEqual(ctx.sent, []);
  assert.deepEqual(ctx.lines, ["open a conversation first", "open a conversation first", "open a conversation first"]);
});

test("a [new] notice for a group chat names the chat and the sender", async () => {
  const ctx = setup();
  await withChats(ctx);
  ctx.app.handleExtensionMessage({ type: "incoming", id: "g9", name: "Study group", message: { from: "Bob", text: "did anyone start?", ts: 1 } });
  assert.deepEqual(ctx.lines, ["[new] Study group - Bob: did anyone start?"]);
});

test("/list with the extension disconnected does not leave the open chat", async () => {
  const ctx = setup();
  await withChats(ctx);
  await openChat(ctx, 1);
  ctx.state.connected = false;
  await ctx.app.handleLine("/list");
  ctx.state.connected = true;
  ctx.lines.length = 0;
  ctx.app.handleExtensionMessage({ type: "incoming", id: "a1", name: "Alice", message: { from: "Alice", text: "still here", ts: 1 } });
  assert.equal(ctx.lines[0], "[1] Alice: still here");
});

// ---- /image ---------------------------------------------------------------------

function setupImage({ loadImage } = {}) {
  const sent = [];
  const lines = [];
  const timers = fakeTimers();
  const bridge = { send: (m) => sent.push(m), isConnected: () => true };
  const app = createApp({
    bridge,
    print: (l) => lines.push(l),
    queue: { enqueue: createBridgeSender(bridge) },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    loadImage,
  });
  return { app, sent, lines, timers };
}

const IMG = { name: "cat.png", mime: "image/png", size: 2048, data: "QUJD" };

async function openA1(ctx) {
  await ctx.app.handleLine("/list");
  ctx.app.handleExtensionMessage({ type: "chats", chats: CHATS });
  await ctx.app.handleLine("/open 1");
  ctx.app.handleExtensionMessage({ type: "messages", id: "a1", title: "Alice", messages: THREAD });
  ctx.sent.length = 0;
  ctx.lines.length = 0;
}

test("/image sends the image with its caption and ref to the open chat", async () => {
  const ctx = setupImage({ loadImage: async (p) => (p === "cat.png" ? IMG : assert.fail("wrong path " + p)) });
  await openA1(ctx);
  await ctx.app.handleLine("/image cat.png look");
  assert.equal(ctx.lines[0], "sending image cat.png (2 KB)...");
  assert.equal(ctx.sent.length, 1);
  assert.deepEqual({ ...ctx.sent[0], ref: "x" }, {
    type: "image",
    id: "a1",
    ref: "x",
    name: "cat.png",
    mime: "image/png",
    data: "QUJD",
    caption: "look",
  });
  assert.match(ctx.sent[0].ref, /^s\d+$/);
  ctx.app.handleExtensionMessage({ type: "sent", id: "a1", ref: ctx.sent[0].ref });
  assert.match(ctx.lines.at(-1), /^sent: "\[image\] cat\.png"/);
});

test("a sent image is added to the thread (caption, or [image]) so message numbers stay aligned", async () => {
  const ctx = setupImage({ loadImage: async () => IMG });
  await openA1(ctx);
  await ctx.app.handleLine("/image cat.png");
  ctx.app.handleExtensionMessage({ type: "sent", id: "a1", ref: ctx.sent[0].ref });
  ctx.sent.length = 0;
  await ctx.app.handleLine("/react 1 4");
  assert.deepEqual(ctx.sent[0].target, { fromEnd: 0, text: "[image]" });
});

test("/image with a bad file prints the reason and sends nothing", async () => {
  const ctx = setupImage({
    loadImage: async () => {
      throw new Error("file not found: nope.png");
    },
  });
  await openA1(ctx);
  await ctx.app.handleLine("/image nope.png");
  assert.deepEqual(ctx.sent, []);
  assert.deepEqual(ctx.lines, ["image error: file not found: nope.png"]);
});

test("/image needs an open, confirmed chat", async () => {
  const ctx = setupImage({ loadImage: async () => IMG });
  await ctx.app.handleLine("/image cat.png");
  assert.deepEqual(ctx.sent, []);
  assert.match(ctx.lines.at(-1), /open a conversation first/);
});

test("an image's confirmation waits four times longer than a text's", async () => {
  const ctx = setupImage({ loadImage: async () => IMG });
  await openA1(ctx);
  await ctx.app.handleLine("/image cat.png");
  assert.equal(ctx.timers.live()[0].ms, 20000 * 4);
  ctx.timers.fireAll();
  assert.match(ctx.lines.at(-1), /no confirmation for "\[image\] cat\.png"/);
});

test("an unconfirmed send prints the extension's detail on a second line", async () => {
  const ctx = setup();
  await withChats(ctx);
  await openChat(ctx);
  await ctx.app.handleLine("hello");
  const { ref } = ctx.sent[0];
  ctx.app.handleExtensionMessage({
    type: "error",
    unconfirmed: true,
    ref,
    message: "send not confirmed after 5 s [debug: aria=Press enter disabled=null]",
  });
  assert.match(ctx.lines.at(-2), /^no confirmation for "hello"/);
  assert.equal(ctx.lines.at(-1), "  (send not confirmed after 5 s [debug: aria=Press enter disabled=null])");
});
