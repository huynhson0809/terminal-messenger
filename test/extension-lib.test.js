import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// extension/lib.js is a plain script (it also runs as a Chrome content script
// and inside the service worker); extension/package.json marks it CommonJS so
// its guarded `module.exports` is visible here.
const require = createRequire(import.meta.url);
const lib = require("../extension/lib.js");

const LAYOUT = "can't read the page, Facebook layout may have changed";

// ---- threadIdFromPath -------------------------------------------------------

test("threadIdFromPath: facebook /messages/t/<id>/", () => {
  assert.equal(lib.threadIdFromPath("/messages/t/123456789/"), "123456789");
  assert.equal(lib.threadIdFromPath("/messages/t/123456789"), "123456789");
});

test("threadIdFromPath: facebook e2ee thread", () => {
  assert.equal(lib.threadIdFromPath("/messages/e2ee/t/987654321/"), "987654321");
});

test("threadIdFromPath: messenger.com paths", () => {
  assert.equal(lib.threadIdFromPath("/t/42/"), "42");
  assert.equal(lib.threadIdFromPath("/e2ee/t/43"), "43");
});

test("threadIdFromPath: full URLs on the two Messenger hosts, query and hash ignored", () => {
  assert.equal(lib.threadIdFromPath("https://www.facebook.com/messages/t/77/?x=1#y"), "77");
  assert.equal(lib.threadIdFromPath("https://www.messenger.com/e2ee/t/78/"), "78");
});

test("threadIdFromPath: rejects foreign hosts and non-thread paths", () => {
  assert.equal(lib.threadIdFromPath("https://evil.example/messages/t/77/"), null);
  assert.equal(lib.threadIdFromPath("/messages/"), null);
  assert.equal(lib.threadIdFromPath("/messages/t/"), null);
  assert.equal(lib.threadIdFromPath("/messages/t/12/info"), null);
  assert.equal(lib.threadIdFromPath("/foo/messages/t/12/"), null);
  assert.equal(lib.threadIdFromPath("/messages/t/a b/"), null);
  assert.equal(lib.threadIdFromPath(""), null);
  assert.equal(lib.threadIdFromPath(null), null);
  assert.equal(lib.threadIdFromPath(42), null);
});

// ---- cleanText ----------------------------------------------------------------

test("cleanText collapses whitespace and trims", () => {
  assert.equal(lib.cleanText("  hi\n\tthere  "), "hi there");
});

test("cleanText tolerates non-strings", () => {
  assert.equal(lib.cleanText(null), "");
  assert.equal(lib.cleanText(undefined), "");
  assert.equal(lib.cleanText(12), "12");
});

test("cleanText truncates to max with an ellipsis, never exceeding max", () => {
  const out = lib.cleanText("x".repeat(50), 10);
  assert.equal(out.length, 10);
  assert.ok(out.endsWith("…"));
  assert.equal(lib.cleanText("short", 10), "short");
});

test("cleanText default cap is LIMITS.MAX_TEXT_LEN", () => {
  const out = lib.cleanText("y".repeat(lib.LIMITS.MAX_TEXT_LEN + 100));
  assert.equal(out.length, lib.LIMITS.MAX_TEXT_LEN);
});

// ---- canSend (send-safety guard) ----------------------------------------------

test("canSend allows when open thread matches and text is fine; returns trimmed text", () => {
  assert.deepEqual(lib.canSend("/messages/t/55/", "55", "  hello  "), { ok: true, text: "hello" });
});

test("canSend works for e2ee threads", () => {
  assert.deepEqual(lib.canSend("/messages/e2ee/t/55/", "55", "hi"), { ok: true, text: "hi" });
});

test("canSend refuses when a different thread is open", () => {
  const r = lib.canSend("/messages/t/56/", "55", "hello");
  assert.equal(r.ok, false);
  assert.match(r.error, /different conversation/);
});

test("canSend refuses when no thread is open", () => {
  const r = lib.canSend("/messages/", "55", "hello");
  assert.equal(r.ok, false);
  assert.match(r.error, /open/);
});

test("canSend refuses bad ids", () => {
  for (const id of [undefined, null, "", 55, "a b", "../x"]) {
    const r = lib.canSend("/messages/t/55/", id, "hello");
    assert.equal(r.ok, false, `id ${String(id)}`);
  }
});

test("canSend refuses empty or whitespace-only text", () => {
  for (const text of ["", "   ", "\n\t", undefined, null, 5]) {
    const r = lib.canSend("/messages/t/55/", "55", text);
    assert.equal(r.ok, false, `text ${JSON.stringify(text)}`);
  }
});

test("canSend refuses over-long text instead of truncating it", () => {
  const max = lib.LIMITS.MAX_SEND_LEN;
  assert.equal(max, 4000);
  assert.equal(lib.canSend("/messages/t/55/", "55", "a".repeat(max)).ok, true);
  const r = lib.canSend("/messages/t/55/", "55", "a".repeat(max + 1));
  assert.equal(r.ok, false);
  assert.match(r.error, /too long/);
});

test("canSend refuses multi-line text (Enter inside would send early)", () => {
  const r = lib.canSend("/messages/t/55/", "55", "line1\nline2");
  assert.equal(r.ok, false);
});

// ---- composer helpers ----------------------------------------------------------

test("composerIsEmpty ignores whitespace and zero-width chars", () => {
  assert.equal(lib.composerIsEmpty(""), true);
  assert.equal(lib.composerIsEmpty(" \n​﻿ "), true);
  assert.equal(lib.composerIsEmpty(null), true);
  assert.equal(lib.composerIsEmpty("a"), false);
});

test("composerMatches compares whitespace-normalized text", () => {
  assert.equal(lib.composerMatches("hello  world\n", "hello world"), true);
  assert.equal(lib.composerMatches("​hello", "hello"), true);
  assert.equal(lib.composerMatches("hello", "hello!"), false);
  assert.equal(lib.composerMatches("", "hello"), false);
});

// ---- message shapes -------------------------------------------------------------

test("buildChat normalizes fields and requires a valid id", () => {
  assert.deepEqual(
    lib.buildChat({ id: "9", name: " Alice \n", preview: "hi", unread: 1 }),
    { id: "9", name: "Alice", preview: "hi", unread: true },
  );
  assert.equal(lib.buildChat({ id: null, name: "x" }), null);
  assert.equal(lib.buildChat({ id: "a b", name: "x" }), null);
});

test("buildChat caps name and preview length", () => {
  const c = lib.buildChat({ id: "9", name: "n".repeat(1000), preview: "p".repeat(1000) });
  assert.equal(c.name.length, lib.LIMITS.MAX_NAME_LEN);
  assert.equal(c.preview.length, lib.LIMITS.MAX_PREVIEW_LEN);
});

test("buildChat falls back to a placeholder name", () => {
  assert.equal(lib.buildChat({ id: "9", name: "" }).name, "(unnamed)");
});

test("attributeSenders: outgoing is 'you', headings carry over, fallback name", () => {
  const rows = [
    { outgoing: false, sender: null, text: "first" },
    { outgoing: false, sender: "Bob", text: "hey" },
    { outgoing: false, sender: null, text: "still bob" },
    { outgoing: true, sender: null, text: "mine" },
    { outgoing: false, sender: null, text: "after mine" },
  ];
  assert.deepEqual(lib.attributeSenders(rows, "Alice"), [
    { from: "Alice", text: "first" },
    { from: "Bob", text: "hey" },
    { from: "Bob", text: "still bob" },
    { from: "you", text: "mine" },
    { from: "Bob", text: "after mine" },
  ]);
});

test("attributeSenders drops rows with no text but keeps their sender heading", () => {
  const rows = [
    { outgoing: false, sender: "Carol", text: "  " },
    { outgoing: false, sender: null, text: "text after photo" },
  ];
  assert.deepEqual(lib.attributeSenders(rows, "Group"), [{ from: "Carol", text: "text after photo" }]);
});

test("attributeSenders uses 'them' when nothing else is known", () => {
  assert.deepEqual(lib.attributeSenders([{ outgoing: false, sender: null, text: "x" }], ""), [
    { from: "them", text: "x" },
  ]);
});

test("buildMessage normalizes and truncates", () => {
  const m = lib.buildMessage({ from: " Bob ", text: "z".repeat(10000), ts: 5 });
  assert.equal(m.from, "Bob");
  assert.equal(m.text.length, lib.LIMITS.MAX_TEXT_LEN);
  assert.equal(m.ts, 5);
  assert.equal(lib.buildMessage({ from: "a", text: "b" }).ts, null);
});

test("buildMessages keeps only the last 30", () => {
  const msgs = Array.from({ length: 45 }, (_, i) => ({ from: "a", text: `m${i}` }));
  const out = lib.buildMessages("7", msgs);
  assert.equal(out.type, "messages");
  assert.equal(out.id, "7");
  assert.equal(out.messages.length, 30);
  assert.equal(out.messages[0].text, "m15");
  assert.equal(out.messages[29].text, "m44");
});

test("errorMsg and LAYOUT_ERROR", () => {
  assert.equal(lib.LAYOUT_ERROR, LAYOUT);
  assert.deepEqual(lib.errorMsg("x"), { type: "error", message: "x" });
});

// ---- new-message detection ---------------------------------------------------------

const m = (from, text) => ({ from, text });

test("newMessagesSince returns messages appended after the known tail", () => {
  const prev = [m("a", "1"), m("b", "2")];
  const cur = [m("a", "1"), m("b", "2"), m("a", "3"), m("a", "4")];
  assert.deepEqual(lib.newMessagesSince(prev, cur), [m("a", "3"), m("a", "4")]);
});

test("newMessagesSince returns nothing when unchanged or when older history loads above", () => {
  const prev = [m("a", "1"), m("b", "2")];
  assert.deepEqual(lib.newMessagesSince(prev, prev), []);
  assert.deepEqual(lib.newMessagesSince(prev, [m("z", "0"), ...prev]), []);
});

test("newMessagesSince handles a repeated message text", () => {
  const prev = [m("a", "hi"), m("b", "ok")];
  const cur = [m("a", "hi"), m("b", "ok"), m("b", "ok")];
  assert.deepEqual(lib.newMessagesSince(prev, cur), [m("b", "ok")]);
});

test("newMessagesSince with a window that scrolled (oldest dropped off the top)", () => {
  const prev = [m("a", "1"), m("b", "2"), m("a", "3")];
  const cur = [m("b", "2"), m("a", "3"), m("b", "4")];
  assert.deepEqual(lib.newMessagesSince(prev, cur), [m("b", "4")]);
});

test("newMessagesSince with no overlap reports nothing (resync, never spam)", () => {
  assert.deepEqual(lib.newMessagesSince([m("a", "1")], [m("x", "9"), m("y", "8")]), []);
});

test("newMessagesSince from an empty baseline reports nothing", () => {
  assert.deepEqual(lib.newMessagesSince([], [m("x", "9")]), []);
});

test("incomingOnly filters out the user's own messages", () => {
  assert.deepEqual(lib.incomingOnly([m("you", "a"), m("Bob", "b")]), [m("Bob", "b")]);
});

test("diffUnreadChats: first scan is a baseline and emits nothing", () => {
  const r = lib.diffUnreadChats(null, [{ id: "1", name: "A", preview: "p", unread: true }], "9");
  assert.deepEqual(r.events, []);
  assert.ok(r.next instanceof Map);
});

test("diffUnreadChats: emits when a non-open chat becomes unread or its preview changes", () => {
  let st = lib.diffUnreadChats(
    null,
    [
      { id: "1", name: "A", preview: "old", unread: false },
      { id: "2", name: "B", preview: "x", unread: true },
    ],
    "9",
  ).next;
  const r = lib.diffUnreadChats(
    st,
    [
      { id: "1", name: "A", preview: "new msg", unread: true },
      { id: "2", name: "B", preview: "x", unread: true },
    ],
    "9",
  );
  assert.equal(r.events.length, 1);
  const e = r.events[0];
  assert.equal(e.type, "incoming");
  assert.equal(e.id, "1");
  assert.equal(e.name, "A");
  assert.equal(e.message.from, "A");
  assert.equal(e.message.text, "new msg");
  assert.equal(typeof e.message.ts, "number");
  st = r.next;
  // Same state again: nothing new.
  assert.deepEqual(
    lib.diffUnreadChats(st, [{ id: "1", name: "A", preview: "new msg", unread: true }], "9").events,
    [],
  );
});

test("diffUnreadChats: never emits for the open chat or read chats", () => {
  const st = lib.diffUnreadChats(null, [], "9").next;
  const r = lib.diffUnreadChats(
    st,
    [
      { id: "9", name: "Open", preview: "hi", unread: true },
      { id: "3", name: "C", preview: "hi", unread: false },
    ],
    "9",
  );
  assert.deepEqual(r.events, []);
});

// ---- command validation (terminal -> extension) ------------------------------------

test("validateCommand accepts the three commands", () => {
  assert.deepEqual(lib.validateCommand({ type: "list" }), { ok: true, cmd: { type: "list" } });
  assert.deepEqual(lib.validateCommand({ type: "open", id: "5" }), {
    ok: true,
    cmd: { type: "open", id: "5" },
  });
  assert.deepEqual(lib.validateCommand({ type: "send", id: "5", text: "hi", extra: 1 }), {
    ok: true,
    cmd: { type: "send", id: "5", text: "hi" },
  });
});

test("validateCommand rejects unknown types and bad fields", () => {
  for (const bad of [
    null,
    "list",
    {},
    { type: "eval" },
    { type: "open" },
    { type: "open", id: 5 },
    { type: "open", id: "a/b" },
    { type: "send", id: "5" },
    { type: "send", id: "5", text: 3 },
    { type: "send", id: "5", text: "x".repeat(lib.LIMITS.MAX_SEND_LEN + 1) },
  ]) {
    assert.equal(lib.validateCommand(bad).ok, false, JSON.stringify(bad));
  }
});

test("validateCommand silently ignores ping/pong-type noise as not-ok", () => {
  assert.equal(lib.validateCommand({ type: "ping" }).ok, false);
});

// ---- relay filter (content script -> terminal) --------------------------------------

test("isRelayable allows only protocol reply types", () => {
  for (const type of ["chats", "messages", "incoming", "sent", "error"]) {
    assert.equal(lib.isRelayable({ type }), true, type);
  }
  for (const bad of [null, {}, { type: "hello" }, { type: "list" }, "chats"]) {
    assert.equal(lib.isRelayable(bad), false, JSON.stringify(bad));
  }
});

// ---- tab choice ------------------------------------------------------------------

test("pickMessengerTab prefers pinned, then most recently accessed", () => {
  const tabs = [
    { id: 1, pinned: false, lastAccessed: 50 },
    { id: 2, pinned: true, lastAccessed: 10 },
    { id: 3, pinned: true, lastAccessed: 20 },
  ];
  assert.equal(lib.pickMessengerTab(tabs).id, 3);
  assert.equal(lib.pickMessengerTab([{ id: 1, lastAccessed: 1 }, { id: 2, lastAccessed: 2 }]).id, 2);
  assert.equal(lib.pickMessengerTab([]), null);
  assert.equal(lib.pickMessengerTab(undefined), null);
});

// ---- async helpers -------------------------------------------------------------------

// waitFor is event-driven (the content script feeds it DOM mutations) because
// Chrome throttles chained timers in hidden tabs to about once a minute.
function fakeEnv() {
  let cb = null;
  let timer = null;
  return {
    subscribe: (fn) => {
      cb = fn;
      return () => {
        cb = null;
      };
    },
    setTimer: (fn) => {
      timer = fn;
      return 1;
    },
    clearTimer: () => {
      timer = null;
    },
    change: () => cb && cb(),
    fireTimeout: () => timer && timer(),
    subscribed: () => cb !== null,
  };
}

test("waitFor resolves true immediately when the predicate already holds", async () => {
  const env = fakeEnv();
  assert.equal(await lib.waitFor(() => true, { timeoutMs: 5000, ...env }), true);
  assert.equal(env.subscribed(), false);
});

test("waitFor resolves true on the change that makes the predicate hold, and unsubscribes", async () => {
  const env = fakeEnv();
  let ready = false;
  const p = lib.waitFor(() => ready, { timeoutMs: 5000, ...env });
  env.change();
  ready = true;
  env.change();
  assert.equal(await p, true);
  assert.equal(env.subscribed(), false);
});

test("waitFor resolves false on timeout (after a last check) and unsubscribes", async () => {
  const env = fakeEnv();
  const p = lib.waitFor(() => false, { timeoutMs: 5000, ...env });
  env.fireTimeout();
  assert.equal(await p, false);
  assert.equal(env.subscribed(), false);
});

test("waitFor treats a throwing predicate as false", async () => {
  const env = fakeEnv();
  const p = lib.waitFor(() => {
    throw new Error("x");
  }, { timeoutMs: 300, ...env });
  env.change();
  env.fireTimeout();
  assert.equal(await p, false);
});

test("createSerialRunner runs tasks one at a time, in order, and survives failures", async () => {
  const run = lib.createSerialRunner();
  const log = [];
  let active = 0;
  const task = (name, fail) => async () => {
    active++;
    assert.equal(active, 1, "overlap");
    log.push(`start ${name}`);
    await new Promise((r) => setTimeout(r, 5));
    log.push(`end ${name}`);
    active--;
    if (fail) throw new Error(name);
    return name;
  };
  const results = await Promise.allSettled([run(task("a")), run(task("b", true)), run(task("c"))]);
  assert.deepEqual(log, ["start a", "end a", "start b", "end b", "start c", "end c"]);
  assert.equal(results[0].value, "a");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[2].value, "c");
});

test("createRecentSent remembers sent texts for a while (to avoid echoing them as incoming)", () => {
  let t = 0;
  const recent = lib.createRecentSent({ ttlMs: 1000, now: () => t });
  recent.add("hello  there");
  assert.equal(recent.take("hello there"), true);
  // Each remembered send suppresses one echo only.
  assert.equal(recent.take("hello there"), false);
  recent.add("again");
  t = 1001;
  assert.equal(recent.take("again"), false);
});

// ---- fix round 1: send gap enforced where typing happens ---------------------------

test("sendGapWait: no previous send means no wait", () => {
  assert.equal(lib.sendGapWait(null, 5000), 0);
  assert.equal(lib.LIMITS.MIN_SEND_GAP_MS, 1000);
});

test("sendGapWait: waits out the rest of the 1000 ms since the last Enter", () => {
  assert.equal(lib.sendGapWait(10000, 10050), 950);
  assert.equal(lib.sendGapWait(10000, 11000), 0);
  assert.equal(lib.sendGapWait(10000, 12000), 0);
  assert.equal(lib.sendGapWait(10000, 10200, 500), 300);
});

function gateClock(start = 0) {
  let t = start;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
    sleeps,
  };
}

test("createSendGate: first send goes immediately, marks start-to-start", async () => {
  const c = gateClock(1000);
  const gate = lib.createSendGate({ now: c.now, sleep: c.sleep });
  await gate.waitTurn();
  assert.deepEqual(c.sleeps, []);
  gate.markSent();
  c.advance(1500);
  await gate.waitTurn();
  assert.deepEqual(c.sleeps, []);
});

test("createSendGate: a send queued behind a slow one still waits 1000 ms after the previous Enter", async () => {
  const c = gateClock(0);
  const gate = lib.createSendGate({ now: c.now, sleep: c.sleep });
  const run = lib.createSerialRunner();
  const enters = [];
  const send = () =>
    run(async () => {
      await gate.waitTurn();
      c.advance(20); // typing
      gate.markSent(); // Enter pressed
      enters.push(c.now());
      c.advance(50); // composer clears quickly
    });
  // #1 and #2 arrive back to back while #1 is still in flight.
  await Promise.all([send(), send()]);
  assert.equal(enters.length, 2);
  assert.ok(enters[1] - enters[0] >= 1000, `gap ${enters[1] - enters[0]}`);
});

// ---- fix round 1: non-text messages ------------------------------------------------

test("mediaPlaceholder maps kinds and ignores unknown ones", () => {
  assert.equal(lib.mediaPlaceholder("image"), "[image]");
  assert.equal(lib.mediaPlaceholder("video"), "[video]");
  assert.equal(lib.mediaPlaceholder("audio"), "[audio]");
  assert.equal(lib.mediaPlaceholder("file"), "[attachment]");
  assert.equal(lib.mediaPlaceholder(null), "");
  assert.equal(lib.mediaPlaceholder("weird"), "");
});

test("isMessageMediaSize: avatars and read receipts are too small to be messages", () => {
  assert.equal(lib.isMessageMediaSize(16, 16), false); // "Seen" receipt
  assert.equal(lib.isMessageMediaSize(32, 32), false); // sender avatar
  assert.equal(lib.isMessageMediaSize(200, 150), true); // photo
  assert.equal(lib.isMessageMediaSize(48, 48), true); // small sticker
  assert.equal(lib.isMessageMediaSize(300, 0), false);
});

test("attributeSenders keeps non-text rows that carry media, as a placeholder", () => {
  const rows = [
    { outgoing: false, sender: "Bob", text: "", media: "image" },
    { outgoing: false, sender: null, text: "  ", media: "video" },
    { outgoing: true, sender: null, text: "", media: "image" },
  ];
  assert.deepEqual(lib.attributeSenders(rows, "Bob"), [
    { from: "Bob", text: "[image]" },
    { from: "Bob", text: "[video]" },
    { from: "you", text: "[image]" },
  ]);
});

test("attributeSenders: text wins over media (caption with photo)", () => {
  assert.deepEqual(
    lib.attributeSenders([{ outgoing: false, sender: "Bob", text: "look", media: "image" }], ""),
    [{ from: "Bob", text: "look" }],
  );
});

test("attributeSenders still drops empty rows without media (dividers, spacers)", () => {
  assert.deepEqual(
    lib.attributeSenders(
      [
        { outgoing: false, sender: null, text: "", media: null },
        { outgoing: false, sender: null, text: " \n " },
      ],
      "Bob",
    ),
    [],
  );
});

test("a photo someone sends produces an incoming message; my own photo does not", () => {
  const before = lib.attributeSenders([{ outgoing: false, sender: "Bob", text: "hi" }], "Bob");
  const after = lib.attributeSenders(
    [
      { outgoing: false, sender: "Bob", text: "hi" },
      { outgoing: true, sender: null, text: "", media: "image" },
      { outgoing: false, sender: null, text: "", media: "image" },
    ],
    "Bob",
  );
  assert.deepEqual(lib.incomingOnly(lib.newMessagesSince(before, after)), [{ from: "Bob", text: "[image]" }]);
});

// ---- final-review fix wave ---------------------------------------------------------

test("validateCommand passes an optional send ref through and rejects a bad one", () => {
  assert.deepEqual(lib.validateCommand({ type: "send", id: "5", text: "hi", ref: "s12" }), {
    ok: true,
    cmd: { type: "send", id: "5", text: "hi", ref: "s12" },
  });
  assert.equal(lib.validateCommand({ type: "send", id: "5", text: "hi", ref: "bad ref!" }).ok, false);
  assert.equal(lib.validateCommand({ type: "send", id: "5", text: "hi", ref: 7 }).ok, false);
});

test("withRef echoes a ref onto a reply only when there is one", () => {
  assert.deepEqual(lib.withRef({ type: "sent", id: "5" }, "s1"), { type: "sent", id: "5", ref: "s1" });
  assert.deepEqual(lib.withRef({ type: "error", message: "x" }, undefined), { type: "error", message: "x" });
});

test("buildMessages includes the pane title when given", () => {
  assert.equal(lib.buildMessages("7", [], "  Bob \n").title, "Bob");
  assert.equal("title" in lib.buildMessages("7", []), false);
});

test("countThreadIds counts distinct thread ids among hrefs (ambiguous row detection)", () => {
  assert.equal(lib.countThreadIds(["/messages/t/1/", "/messages/t/1/?x", "/settings"]), 1);
  assert.equal(lib.countThreadIds(["/messages/t/1/", "/messages/e2ee/t/2/"]), 2);
  assert.equal(lib.countThreadIds([]), 0);
});

test("waitForQuiet resolves true after quietMs with no changes, restarting on each change", async () => {
  const timers = [];
  let cb = null;
  const env = {
    subscribe: (fn) => {
      cb = fn;
      return () => {
        cb = null;
      };
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      t.live = false;
    },
  };
  const p = lib.waitForQuiet({ quietMs: 300, maxMs: 3000, ...env });
  const quiet = () => timers.filter((t) => t.live && t.ms === 300);
  assert.equal(quiet().length, 1);
  cb(); // a mutation restarts the quiet timer
  assert.equal(quiet().length, 1);
  quiet()[0].fn();
  assert.equal(await p, true);
  assert.equal(cb, null);
});

test("waitForQuiet resolves false when the page never goes quiet before maxMs", async () => {
  const timers = [];
  const env = {
    subscribe: () => () => {},
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      t.live = false;
    },
  };
  const p = lib.waitForQuiet({ quietMs: 300, maxMs: 3000, ...env });
  timers.find((t) => t.ms === 3000).fn();
  assert.equal(await p, false);
});

// performSend: the whole send-safety sequence, against a fake page.
function fakePage({ path = "/messages/t/55/", settled = true, composers = 1, clearsOnEnter = true } = {}) {
  const boxes = Array.from({ length: composers }, () => ({ text: "", attached: true }));
  const page = {
    path,
    settled,
    boxes,
    enters: 0,
    inserted: [],
    focused: null,
    onGateWait: null,
    afterEnter: null,
    pathname: () => page.path,
    isSettled: (id) => page.settled && lib.threadIdFromPath(page.path) === id,
    findComposers: () => page.boxes.filter((b) => b.attached),
    textOf: (b) => b.text,
    focus: (b) => {
      page.focused = b;
    },
    isFocused: (b) => page.focused === b,
    isAttached: (b) => b.attached,
    insertText: (b, t) => {
      page.inserted.push(t);
      b.text += t;
    },
    pressEnter: (b) => {
      page.enters++;
      if (page.afterEnter) page.afterEnter(b);
      else if (clearsOnEnter) b.text = "";
    },
    waitFor: async (pred) => Boolean(pred()),
  };
  return page;
}

function fakeGate(page) {
  const g = {
    waits: 0,
    marks: 0,
    waitTurn: async () => {
      g.waits++;
      if (page.onGateWait) page.onGateWait();
    },
    markSent: () => {
      g.marks++;
    },
  };
  return g;
}

test("performSend happy path: types once, presses Enter exactly once, replies sent", async () => {
  const page = fakePage();
  const gate = fakeGate(page);
  const r = await lib.performSend({ id: "55", text: "  hello ", page, gate });
  assert.deepEqual(r, { type: "sent", id: "55" });
  assert.deepEqual(page.inserted, ["hello"]);
  assert.equal(page.enters, 1);
  assert.equal(gate.waits, 1);
  assert.equal(gate.marks, 1);
});

test("performSend refuses during the settle window, typing nothing", async () => {
  const page = fakePage({ settled: false });
  const r = await lib.performSend({ id: "55", text: "hello", page, gate: fakeGate(page) });
  assert.deepEqual(r, { type: "error", message: "conversation still loading; not sent" });
  assert.deepEqual(page.inserted, []);
  assert.equal(page.enters, 0);
});

test("performSend refuses on URL mismatch, typing nothing", async () => {
  const page = fakePage({ path: "/messages/t/66/" });
  const r = await lib.performSend({ id: "55", text: "hello", page, gate: fakeGate(page) });
  assert.equal(r.type, "error");
  assert.match(r.message, /different conversation/);
  assert.deepEqual(page.inserted, []);
  assert.equal(page.enters, 0);
});

test("performSend refuses when the composer already has text", async () => {
  const page = fakePage();
  page.boxes[0].text = "my draft";
  const r = await lib.performSend({ id: "55", text: "hello", page, gate: fakeGate(page) });
  assert.match(r.message, /not empty/);
  assert.deepEqual(page.inserted, []);
  assert.equal(page.enters, 0);
});

test("performSend refuses with the layout error unless exactly one composer matches", async () => {
  for (const n of [0, 2]) {
    const page = fakePage({ composers: n });
    const r = await lib.performSend({ id: "55", text: "hello", page, gate: fakeGate(page) });
    assert.deepEqual(r, { type: "error", message: lib.LAYOUT_ERROR }, `composers ${n}`);
    assert.deepEqual(page.inserted, []);
  }
});

test("performSend re-checks after the send-gap wait: a chat switch during the wait types nothing", async () => {
  const page = fakePage();
  page.onGateWait = () => {
    page.path = "/messages/t/66/";
  };
  const r = await lib.performSend({ id: "55", text: "hello", page, gate: fakeGate(page) });
  assert.equal(r.type, "error");
  assert.deepEqual(page.inserted, []);
  assert.equal(page.enters, 0);
});

test("performSend does not press Enter if the typed text doesn't match", async () => {
  const page = fakePage();
  page.insertText = (b, t) => {
    b.text = t.slice(0, 2);
  };
  const r = await lib.performSend({ id: "55", text: "hello", page, gate: fakeGate(page) });
  assert.equal(r.type, "error");
  assert.equal(page.enters, 0);
});

test("performSend: unconfirmed send is reported, never retried", async () => {
  const page = fakePage({ clearsOnEnter: false });
  const gate = fakeGate(page);
  const r = await lib.performSend({ id: "55", text: "hello", page, gate });
  assert.equal(r.type, "error");
  assert.equal(r.unconfirmed, true);
  assert.match(r.message, /run \/open <n> to check before resending/);
  assert.equal(page.enters, 1);
  assert.equal(gate.marks, 1);
});

test("performSend: an empty box in a different chat does not count as sent", async () => {
  const page = fakePage();
  page.afterEnter = (b) => {
    page.path = "/messages/t/66/";
    b.text = "";
  };
  const r = await lib.performSend({ id: "55", text: "hello", page, gate: fakeGate(page) });
  assert.equal(r.type, "error");
  assert.equal(r.unconfirmed, true);
  assert.equal(page.enters, 1);
});
