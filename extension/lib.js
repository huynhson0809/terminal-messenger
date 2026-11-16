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
  });

  const LAYOUT_ERROR = "can't read the page, Facebook layout may have changed";

  // Thread ids are numeric today; older messenger.com links used usernames.
  const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
  const ALLOWED_HOSTS = ["www.facebook.com", "www.messenger.com"];
  // /messages/t/<id>/, /messages/e2ee/t/<id>/ (facebook.com)
  // /t/<id>/, /e2ee/t/<id>/ (messenger.com)
  const THREAD_PATH_RE = /^\/(?:messages\/)?(?:e2ee\/)?t\/([^/]+)\/?$/;
  const ZERO_WIDTH_RE = /[​-‍⁠﻿]/g;

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

  // rows: [{outgoing, sender, text}] in page order. A sender heading only
  // appears on the first message of a run, so it carries over to later rows.
  function attributeSenders(rows, fallbackName) {
    const out = [];
    let lastSender = cleanText(fallbackName, LIMITS.MAX_NAME_LEN) || "them";
    for (const r of rows || []) {
      if (!r) continue;
      const sender = cleanText(r.sender, LIMITS.MAX_NAME_LEN);
      if (!r.outgoing && sender) lastSender = sender;
      const text = cleanText(r.text);
      if (!text) continue;
      out.push({ from: r.outgoing ? "you" : lastSender, text });
    }
    return out;
  }

  function buildMessages(id, messages) {
    const list = (messages || []).slice(-LIMITS.MAX_MESSAGES).map(buildMessage);
    return { type: "messages", id, messages: list };
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
        return { ok: true, cmd: { type: "send", id: msg.id, text: msg.text } };
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
    createRecentSent,
  });

  root.TMLib = lib;
  if (typeof module === "object" && module && module.exports) module.exports = lib;
})(typeof globalThis !== "undefined" ? globalThis : self);
