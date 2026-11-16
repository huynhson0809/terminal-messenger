// Pure helpers shared by content.js, background.js and the node:test suite.
//
// This is a plain script, not an ES module: Chrome content scripts cannot use
// `import`, so the manifest lists lib.js before content.js (both share the
// content script's isolated world) and background.js pulls it in with
// importScripts(). Everything is attached to one namespace, `TMLib`. For
// node:test, extension/package.json marks this folder CommonJS so the guarded
// `module.exports` below makes it require()-able.
//
// Nothing in here touches the DOM, the network, cookies or storage.
(function (root) {
  "use strict";

  const LIMITS = Object.freeze({
    MAX_SEND_LEN: 4000, // longest reply we will type into the composer
    MAX_TEXT_LEN: 4000, // longest message text we forward to the terminal
    MAX_NAME_LEN: 200,
    MAX_PREVIEW_LEN: 300,
    MAX_MESSAGES: 30,
    SEND_CONFIRM_TIMEOUT_MS: 5000,
    MIN_SEND_GAP_MS: 1000, // between Enter presses, start to start
    MIN_MEDIA_PX: 48, // smaller images are avatars / read receipts, not messages
  });

  const MEDIA_PLACEHOLDERS = Object.freeze({
    image: "[image]",
    video: "[video]",
    audio: "[audio]",
    file: "[attachment]",
  });

  const LAYOUT_ERROR = "can't read the page, Facebook layout may have changed";

  // Thread ids are numeric today; older messenger.com links used usernames.
  const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
  const ALLOWED_HOSTS = ["www.facebook.com", "www.messenger.com"];
  // /messages/t/<id>/, /messages/e2ee/t/<id>/ (facebook.com)
  // /t/<id>/, /e2ee/t/<id>/ (messenger.com)
  const THREAD_PATH_RE = /^\/(?:messages\/)?(?:e2ee\/)?t\/([^/]+)\/?$/;
  const ZERO_WIDTH_RE = /[​-‍⁠﻿]/g;

  const REF_RE = /^[A-Za-z0-9_-]{1,40}$/;

  function isValidRef(ref) {
    return typeof ref === "string" && REF_RE.test(ref);
  }

  function isValidId(id) {
    return typeof id === "string" && ID_RE.test(id);
  }

  function threadIdFromPath(hrefOrPath) {
    if (typeof hrefOrPath !== "string" || hrefOrPath === "") return null;
    let path = hrefOrPath;
    const abs = /^https?:\/\/([^/?#]+)(.*)$/i.exec(path);
    if (abs) {
      if (!ALLOWED_HOSTS.includes(abs[1].toLowerCase())) return null;
      path = abs[2] || "/";
    }
    path = path.split(/[?#]/)[0];
    const m = THREAD_PATH_RE.exec(path);
    if (!m || !isValidId(m[1])) return null;
    return m[1];
  }

  function cleanText(value, max = LIMITS.MAX_TEXT_LEN) {
    if (value === null || value === undefined) return "";
    const s = String(value).replace(ZERO_WIDTH_RE, "").replace(/\s+/g, " ").trim();
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + "…";
  }

  // Send-safety guard. Called with location.pathname right before typing and
  // again right before pressing Enter. Refuses rather than repairs.
  function canSend(currentPath, requestedId, text) {
    if (!isValidId(requestedId)) return { ok: false, error: "invalid conversation id; not sent" };
    if (typeof text !== "string") return { ok: false, error: "empty message; not sent" };
    const openId = threadIdFromPath(currentPath);
    if (openId === null) {
      return { ok: false, error: "no conversation is open in the Messenger tab; not sent" };
    }
    if (openId !== requestedId) {
      return { ok: false, error: "a different conversation is open in the Messenger tab; not sent" };
    }
    const trimmed = text.trim();
    if (trimmed === "") return { ok: false, error: "empty message; not sent" };
    if (/[\r\n]/.test(trimmed)) {
      return { ok: false, error: "multi-line messages are not supported; not sent" };
    }
    if (trimmed.length > LIMITS.MAX_SEND_LEN) {
      return { ok: false, error: `message too long (max ${LIMITS.MAX_SEND_LEN} characters); not sent` };
    }
    return { ok: true, text: trimmed };
  }

  function normalizeComposer(text) {
    return String(text ?? "").replace(ZERO_WIDTH_RE, "").replace(/\s+/g, " ").trim();
  }

  function composerIsEmpty(text) {
    return normalizeComposer(text) === "";
  }

  function composerMatches(composerText, text) {
    const want = normalizeComposer(text);
    return want !== "" && normalizeComposer(composerText) === want;
  }

  function buildChat(raw) {
    if (!raw || !isValidId(raw.id)) return null;
    return {
      id: raw.id,
      name: cleanText(raw.name, LIMITS.MAX_NAME_LEN) || "(unnamed)",
      preview: cleanText(raw.preview, LIMITS.MAX_PREVIEW_LEN),
      unread: Boolean(raw.unread),
    };
  }

  function buildMessage(raw) {
    return {
      from: cleanText(raw && raw.from, LIMITS.MAX_NAME_LEN),
      text: cleanText(raw && raw.text, LIMITS.MAX_TEXT_LEN),
      ts: raw && typeof raw.ts === "number" ? raw.ts : null,
    };
  }

  function mediaPlaceholder(kind) {
    return Object.prototype.hasOwnProperty.call(MEDIA_PLACEHOLDERS, kind) ? MEDIA_PLACEHOLDERS[kind] : "";
  }

  // Rendered size check that tells a photo/sticker/video apart from a sender
  // avatar (~28-32 px) or a "Seen" receipt (~14-16 px) in the same row.
  function isMessageMediaSize(width, height) {
    return width >= LIMITS.MIN_MEDIA_PX && height >= LIMITS.MIN_MEDIA_PX;
  }

  // rows: [{outgoing, sender, text, media}] in page order; media is a kind
  // ("image", "video", "audio", "file") or null. A row with no text but with
  // media becomes a placeholder; a row with neither (dividers, spacers) is
  // dropped. A sender heading only appears on the first message of a run, so
  // it carries over to later rows.
  function attributeSenders(rows, fallbackName) {
    const out = [];
    let lastSender = cleanText(fallbackName, LIMITS.MAX_NAME_LEN) || "them";
    for (const r of rows || []) {
      if (!r) continue;
      const sender = cleanText(r.sender, LIMITS.MAX_NAME_LEN);
      if (!r.outgoing && sender) lastSender = sender;
      const text = cleanText(r.text) || mediaPlaceholder(r.media);
      if (!text) continue;
      out.push({ from: r.outgoing ? "you" : lastSender, text });
    }
    return out;
  }

  // title: the chat pane's own heading, so the terminal can show it and the
  // user can cross-check it against the name they picked from /list.
  function buildMessages(id, messages, title) {
    const list = (messages || []).slice(-LIMITS.MAX_MESSAGES).map(buildMessage);
    const out = { type: "messages", id, messages: list };
    if (title !== undefined) out.title = cleanText(title, LIMITS.MAX_NAME_LEN);
    return out;
  }

  // A reply belongs to a terminal send via its `ref`.
  function withRef(msg, ref) {
    return typeof ref === "string" ? { ...msg, ref } : msg;
  }

  // Number of distinct thread ids among the hrefs. A chat-row container with
  // more than one is ambiguous (it wraps several rows).
  function countThreadIds(hrefs) {
    const ids = new Set();
    for (const h of hrefs || []) {
      const id = threadIdFromPath(h);
      if (id) ids.add(id);
    }
    return ids.size;
  }

  function errorMsg(message) {
    return { type: "error", message: String(message) };
  }

  function sameMessage(a, b) {
    return a.from === b.from && a.text === b.text;
  }

  // Messages present in `cur` after the longest suffix of `prev` that still
  // appears in `cur`. When nothing overlaps we report nothing (resync) rather
  // than flooding the terminal with re-rendered history.
  function newMessagesSince(prev, cur) {
    if (!prev || !cur || prev.length === 0) return [];
    for (let len = Math.min(prev.length, cur.length); len >= 1; len--) {
      const suffix = prev.slice(prev.length - len);
      for (let j = cur.length - len; j >= 0; j--) {
        let match = true;
        for (let k = 0; k < len; k++) {
          if (!sameMessage(cur[j + k], suffix[k])) {
            match = false;
            break;
          }
        }
        if (match) return cur.slice(j + len);
      }
    }
    return [];
  }

  function incomingOnly(messages) {
    return (messages || []).filter((x) => x.from !== "you");
  }

  // prev: Map(id -> preview-if-unread | null) or null for the first scan.
  function diffUnreadChats(prev, chats, openId, now = Date.now) {
    const next = new Map(prev || []);
    const events = [];
    for (const c of chats || []) {
      if (!c) continue;
      const state = c.unread ? c.preview : null;
      if (prev && c.unread && c.id !== openId && prev.get(c.id) !== state) {
        events.push({
          type: "incoming",
          id: c.id,
          name: c.name,
          message: buildMessage({ from: c.name, text: c.preview, ts: now() }),
        });
      }
      next.set(c.id, state);
    }
    return { events, next };
  }

  function validateCommand(msg) {
    if (!msg || typeof msg !== "object") return { ok: false, error: "bad command" };
    switch (msg.type) {
      case "list":
        return { ok: true, cmd: { type: "list" } };
      case "open":
        if (!isValidId(msg.id)) return { ok: false, error: "invalid conversation id" };
        return { ok: true, cmd: { type: "open", id: msg.id } };
      case "send":
        if (!isValidId(msg.id)) return { ok: false, error: "invalid conversation id" };
        if (typeof msg.text !== "string") return { ok: false, error: "message text missing" };
        if (msg.text.length > LIMITS.MAX_SEND_LEN) {
          return { ok: false, error: `message too long (max ${LIMITS.MAX_SEND_LEN} characters)` };
        }
        if (msg.ref !== undefined && !isValidRef(msg.ref)) return { ok: false, error: "invalid ref" };
        return {
          ok: true,
          cmd: msg.ref === undefined
            ? { type: "send", id: msg.id, text: msg.text }
            : { type: "send", id: msg.id, text: msg.text, ref: msg.ref },
        };
      default:
        return { ok: false, error: "unknown command" };
    }
  }

  const RELAY_TYPES = ["chats", "messages", "incoming", "sent", "error"];

  function isRelayable(msg) {
    return Boolean(msg) && typeof msg === "object" && RELAY_TYPES.includes(msg.type);
  }

  function pickMessengerTab(tabs) {
    if (!Array.isArray(tabs) || tabs.length === 0) return null;
    const sorted = tabs.slice().sort((a, b) => {
      const p = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
      if (p !== 0) return p;
      return (b.lastAccessed || 0) - (a.lastAccessed || 0);
    });
    return sorted[0];
  }

  // Resolves true as soon as predicate() holds, false after timeoutMs.
  // Re-checks on every notification from subscribe(cb) (the content script
  // passes a MutationObserver), so it does not depend on polling timers,
  // which Chrome throttles to about once a minute in hidden tabs.
  function waitFor(predicate, opts) {
    const { timeoutMs, subscribe, setTimer = setTimeout, clearTimer = clearTimeout } = opts;
    return new Promise((resolve) => {
      let done = false;
      let unsubscribe = null;
      let timer = null;
      const holds = () => {
        try {
          return Boolean(predicate());
        } catch {
          return false;
        }
      };
      const finish = (value) => {
        if (done) return;
        done = true;
        if (unsubscribe) unsubscribe();
        if (timer !== null) clearTimer(timer);
        resolve(value);
      };
      if (holds()) {
        finish(true);
        return;
      }
      const unsub = subscribe(() => {
        if (!done && holds()) finish(true);
      });
      if (done) {
        unsub();
        return;
      }
      unsubscribe = unsub;
      timer = setTimer(() => finish(holds()), timeoutMs);
    });
  }

  // Texts this extension just sent. If the page's "you sent" marker is missed,
  // our own message could look incoming; each remembered send cancels one echo.
  function createRecentSent({ ttlMs = 60000, now = Date.now } = {}) {
    let items = [];
    const prune = () => {
      const t = now();
      items = items.filter((x) => t - x.at <= ttlMs);
    };
    return {
      add(text) {
        prune();
        items.push({ text: cleanText(text), at: now() });
        if (items.length > 20) items.shift();
      },
      take(text) {
        prune();
        const key = cleanText(text);
        const i = items.findIndex((x) => x.text === key);
        if (i === -1) return false;
        items.splice(i, 1);
        return true;
      },
    };
  }

  // Resolves true once quietMs pass with no notification from subscribe(cb),
  // or false if that never happens within maxMs. Used after opening a chat
  // so the thread has finished rendering before it is read.
  function waitForQuiet(opts) {
    const { quietMs, maxMs, subscribe, setTimer = setTimeout, clearTimer = clearTimeout } = opts;
    return new Promise((resolve) => {
      let done = false;
      let quietTimer = null;
      let unsubscribe = null;
      const finish = (value) => {
        if (done) return;
        done = true;
        if (quietTimer !== null) clearTimer(quietTimer);
        clearTimer(maxTimer);
        if (unsubscribe) unsubscribe();
        resolve(value);
      };
      const restart = () => {
        if (done) return;
        if (quietTimer !== null) clearTimer(quietTimer);
        quietTimer = setTimer(() => finish(true), quietMs);
      };
      const maxTimer = setTimer(() => finish(false), maxMs);
      restart();
      unsubscribe = subscribe(restart);
    });
  }

  const SEND_ERRORS = Object.freeze({
    loading: "conversation still loading; not sent",
    notEmpty: "the message box in the Messenger tab is not empty; not sent",
    changed: "the message box in the Messenger tab changed; not sent",
    focus: "couldn't focus the message box; not sent",
    typing: "couldn't type the message correctly; not sent (the text may still be in the message box)",
    lostFocus: "the message box lost focus; not sent (the text is still in the box)",
    noSendButton: "couldn't find the send button; not sent (the text is still in the message box)",
    unconfirmed: "send not confirmed after 5 s; not retrying, run /open <n> to check before resending",
  });

  // The whole send-safety sequence, written against a small page adapter so
  // it can be tested without a browser. content.js supplies the real one.
  //   page: pathname(), isSettled(id), findComposers(), textOf(box),
  //         focus(box), isFocused(box), isAttached(box), insertText(box, text),
  //         pressEnter(box), waitFor(predicate, timeoutMs) -> Promise<boolean>;
//         optional beforeTyping(box), findSendButton(box) -> element|null, clickSend(el)
  //   gate: waitTurn(), markSent()   (createSendGate)
  // Every refusal happens before Enter. Enter is pressed at most once.
  async function performSend({
    id,
    text: rawText,
    page,
    gate,
    typeTimeoutMs = 1500,
    confirmTimeoutMs = LIMITS.SEND_CONFIRM_TIMEOUT_MS,
  }) {
    const err = (message) => errorMsg(message);
    // Thread, settle window, a single empty composer. Returns the box or an error.
    const check = (expectedBox) => {
      const g = canSend(page.pathname(), id, rawText);
      if (!g.ok) return { error: g.error };
      if (!page.isSettled(id)) return { error: SEND_ERRORS.loading };
      const boxes = page.findComposers();
      if (boxes.length !== 1) return { error: LAYOUT_ERROR };
      const box = boxes[0];
      if (expectedBox && box !== expectedBox) return { error: SEND_ERRORS.changed };
      if (!composerIsEmpty(page.textOf(box))) {
        return { error: expectedBox ? SEND_ERRORS.changed : SEND_ERRORS.notEmpty };
      }
      return { box, text: g.text };
    };

    // 1. Before anything: right thread, loaded, one empty composer.
    const initial = check(null);
    if (initial.error) return err(initial.error);

    // 2. Keep >= 1 s between Enter presses, then re-check: the page may have
    //    changed while we waited.
    await gate.waitTurn();
    const second = check(initial.box);
    if (second.error) return err(second.error);
    const box = second.box;
    const text = second.text;

    // 3. Type into the real composer and verify exactly that text landed.
    page.focus(box);
    if (!page.isFocused(box)) return err(SEND_ERRORS.focus);
    if (page.beforeTyping) page.beforeTyping(box);
    const inserted = page.insertText(box, text);
    const typed = await page.waitFor(() => composerMatches(page.textOf(box), text), typeTimeoutMs);
    if (!typed) {
      // Diagnostics only (lengths and flags, never the text itself).
      const info = typeof page.describe === "function" ? ` [debug: insert=${inserted} ${page.describe(box)}]` : "";
      return err(SEND_ERRORS.typing + info);
    }

    // With a send button (page.findSendButton), it must have changed from its
    // empty-box look to its has-text look; wait for that before the last check.
    if (page.findSendButton) {
      await page.waitFor(() => page.findSendButton(box) !== null, typeTimeoutMs);
    }

    // 4. Last re-check right before the send (no await after this point).
    const g = canSend(page.pathname(), id, text);
    if (!g.ok) return err(`${g.error} (the text is still in the message box)`);
    if (!page.isSettled(id)) return err(`${SEND_ERRORS.loading} (the text is still in the message box)`);
    const boxes = page.findComposers();
    if (boxes.length !== 1 || boxes[0] !== box || !page.isAttached(box) || !page.isFocused(box)) {
      return err(SEND_ERRORS.lostFocus);
    }

    // 5. One send: the send button if the page adapter has one, else one
    //    Enter. Then wait for this chat's box to clear. Never retry.
    const sendButton = page.findSendButton ? page.findSendButton(box) : null;
    if (page.findSendButton && !sendButton) return err(SEND_ERRORS.noSendButton);
    gate.markSent(); // start-to-start gap: recorded as the send is made
    if (sendButton) page.clickSend(sendButton);
    else page.pressEnter(box);
    const cleared = await page.waitFor(() => {
      if (threadIdFromPath(page.pathname()) !== id) return false;
      const now = page.findComposers();
      return now.length === 1 && composerIsEmpty(page.textOf(now[0]));
    }, confirmTimeoutMs);
    if (!cleared) return { ...err(SEND_ERRORS.unconfirmed), unconfirmed: true };
    return { type: "sent", id };
  }

  // Milliseconds to wait so that at least minGapMs separates two Enter presses.
  function sendGapWait(lastSendAt, now, minGapMs = LIMITS.MIN_SEND_GAP_MS) {
    if (typeof lastSendAt !== "number") return 0;
    return Math.max(0, lastSendAt + minGapMs - now);
  }

  // Enforces the gap where the typing happens: waitTurn() before typing,
  // markSent() at the moment Enter is pressed (also when confirmation later
  // times out, because the Enter was still pressed).
  function createSendGate({
    minGapMs = LIMITS.MIN_SEND_GAP_MS,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    let lastSendAt = null;
    return {
      async waitTurn() {
        const wait = sendGapWait(lastSendAt, now(), minGapMs);
        if (wait > 0) await sleep(wait);
      },
      markSent() {
        lastSendAt = now();
      },
    };
  }

  function createSerialRunner() {
    let tail = Promise.resolve();
    return function run(fn) {
      const result = tail.then(() => fn());
      tail = result.catch(() => {});
      return result;
    };
  }

  const lib = Object.freeze({
    LIMITS,
    LAYOUT_ERROR,
    isValidId,
    threadIdFromPath,
    cleanText,
    canSend,
    composerIsEmpty,
    composerMatches,
    buildChat,
    buildMessage,
    attributeSenders,
    buildMessages,
    errorMsg,
    newMessagesSince,
    incomingOnly,
    diffUnreadChats,
    validateCommand,
    isRelayable,
    pickMessengerTab,
    waitFor,
    createSerialRunner,
    withRef,
    countThreadIds,
    waitForQuiet,
    performSend,
    isValidRef,
    sendGapWait,
    createSendGate,
    mediaPlaceholder,
    isMessageMediaSize,
    createRecentSent,
  });

  root.TMLib = lib;
  if (typeof module === "object" && module && module.exports) module.exports = lib;
})(typeof globalThis !== "undefined" ? globalThis : self);
