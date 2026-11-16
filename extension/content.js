// Content script for the Messenger tab. Reads the visible page and, only on
// an explicit `send` command from the terminal, types into the real message
// box. It makes no network requests, never reads cookies, tokens,
// localStorage or sessionStorage, and only clicks a chat row when the
// terminal asks to `open` that chat.
//
// lib.js is loaded first (see manifest content_scripts) and provides TMLib.
(function () {
  "use strict";

  // ==========================================================================
  // SELECTORS: every assumption about Facebook's page structure lives here.
  // THIS IS THE ONLY PLACE TO FIX AFTER A FACEBOOK UI UPDATE.
  // Stable hooks (role, aria-label, href patterns, dir) are preferred over
  // Facebook's generated class names, which change on every deploy.
  // ==========================================================================
  const SELECTORS = {
    // Sidebar that holds the conversation list (first match wins).
    // Facebook localizes aria-labels ("Chats" is "Đoạn chat" in Vietnamese), so
    // match by role only: the chat list is the page's one role=grid.
    chatList: ['[role="navigation"] [role="grid"]', '[role="grid"]'],
    // A conversation link inside the list: href is /messages/t/<id>/ or
    // /messages/e2ee/t/<id>/ (messenger.com: /t/<id>/, /e2ee/t/<id>/).
    chatRowLink: 'a[href*="/t/"]',
    // Ancestor of the link that holds the whole row (name, preview, badges).
    chatRowContainer: '[role="row"], [role="listitem"], [role="gridcell"]',
    // Text pieces in a row, in order: name first, then the preview line.
    chatRowText: 'span[dir="auto"]',
    // Unread markers in a row (either one counts).
    chatRowUnread: '[aria-label*="unread" i], [aria-label="Mark as read"], [aria-label*="chưa đọc" i]',
    chatRowUnreadText: /^(unread message|tin nhắn chưa đọc):?$/i,

    // The open conversation.
    thread: '[role="main"]',
    // Seen on the live page: messages are role=article rows inside one role=log.
    messageList: [
      '[role="main"] [role="log"]',
      '[role="main"] [aria-label^="Messages in conversation"]',
      '[role="main"] [role="grid"]',
    ],
    messageRow: '[role="article"]',
    // Message body text inside a row.
    messageText: 'div[dir="auto"]',
    // Screen-reader heading on a row: the sender's name, or "You sent" (English
    // only; own messages are also detected by position, see isOwnByPosition).
    senderHeading: 'h4, h5, h6, [role="heading"]',
    outgoingHeading: /^you sent$/i,
    // Conversation title (used as the sender name in 1:1 chats).
    threadTitle: ['[role="main"] h1', '[role="main"] h2'],

    // The message box (Lexical contenteditable).
    composer: '[role="main"] [role="textbox"][contenteditable="true"]',

    // Non-text message content inside a message row, checked in this order.
    // Only elements rendered at least LIMITS.MIN_MEDIA_PX on both sides count,
    // which rules out sender avatars and "Seen" receipts in the same row.
    messageMedia: [
      ["video", "video"],
      ["audio", "audio"],
      ["img", "image"],
      ['[role="img"]', "image"],
    ],
  };
  // ==========================================================================

  if (globalThis.__terminalMessengerLoaded) return;
  globalThis.__terminalMessengerLoaded = true;

  const lib = globalThis.TMLib;
  const { LAYOUT_ERROR } = lib;
  const OPEN_TIMEOUT_MS = 10000;
  const OPEN_QUIET_MS = 300;
  const OPEN_QUIET_MAX_MS = 3000;
  const TYPE_TIMEOUT_MS = 4000; // a hidden page runs timers about once a second
  const SETTLE_AFTER_THREAD_CHANGE_MS = 2500;
  const SCAN_THROTTLE_MS = 500;
  const MAX_EVENTS_PER_SCAN = 5;

  class LayoutError extends Error {}

  // Incoming-detection state (see the bottom of this file).
  const recentSent = lib.createRecentSent({ ttlMs: 60000 });
  const sendGate = lib.createSendGate();
  let baseline = { threadId: null, messages: [], settleUntil: 0 };
  let unreadState = null;
  let lastScan = 0;
  let scanTimer = null;

  // ---- DOM helpers -------------------------------------------------------

  function first(selectors, root = document) {
    for (const s of [].concat(selectors)) {
      const el = root.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function textOf(el) {
    return el ? lib.cleanText(el.textContent) : "";
  }

  // Innermost matches only, so nested dir="auto" wrappers don't repeat text.
  function innermost(root, selector) {
    const all = Array.from(root.querySelectorAll(selector));
    return all.filter((el) => !all.some((o) => o !== el && el.contains(o)));
  }

  function domChanges(cb, target = document.documentElement) {
    const obs = new MutationObserver(cb);
    obs.observe(target, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    return () => obs.disconnect();
  }

  function waitForDom(predicate, timeoutMs) {
    return lib.waitFor(predicate, { timeoutMs, subscribe: domChanges });
  }

  function currentThreadId() {
    return lib.threadIdFromPath(location.pathname);
  }

  // ---- reading the chat list ---------------------------------------------

  function readChatRows() {
    const list = first(SELECTORS.chatList);
    if (!list) throw new LayoutError();
    const seen = new Set();
    const rows = [];
    for (const link of list.querySelectorAll(SELECTORS.chatRowLink)) {
      const id = lib.threadIdFromPath(link.getAttribute("href") || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      // If the "row" container wraps more than one chat (selector too broad),
      // fall back to the link itself rather than borrowing another row's name.
      let row = link.closest(SELECTORS.chatRowContainer) || link;
      if (row !== link) {
        const hrefs = Array.from(row.querySelectorAll(SELECTORS.chatRowLink), (a) => a.getAttribute("href") || "");
        if (lib.countThreadIds(hrefs) > 1) row = link;
      }
      const texts = [];
      let unread = Boolean(row.querySelector(SELECTORS.chatRowUnread));
      for (const span of innermost(row, SELECTORS.chatRowText)) {
        const t = textOf(span);
        if (!t) continue;
        if (SELECTORS.chatRowUnreadText.test(t)) {
          unread = true;
          continue;
        }
        if (!texts.includes(t)) texts.push(t);
      }
      const chat = lib.buildChat({ id, name: texts[0], preview: texts[1] || "", unread });
      if (chat) rows.push({ chat, link });
    }
    if (rows.length === 0) throw new LayoutError();
    return rows;
  }

  function readChats() {
    return readChatRows().map((r) => r.chat);
  }

  // ---- reading the open thread -------------------------------------------

  function threadName(threadId) {
    try {
      const hit = readChats().find((c) => c.id === threadId);
      if (hit) return hit.name;
    } catch {
      // list not readable; fall through
    }
    return textOf(first(SELECTORS.threadTitle));
  }

  function mediaKind(row) {
    for (const [selector, kind] of SELECTORS.messageMedia) {
      for (const el of row.querySelectorAll(selector)) {
        const box = el.getBoundingClientRect();
        if (lib.isMessageMediaSize(box.width, box.height)) return kind;
      }
    }
    return null;
  }

  // Language-independent: your own messages sit against the right edge of the
  // message list, other people's against the left (after their avatar).
  function isOwnByPosition(row, list, heading) {
    const el = innermost(row, SELECTORS.messageText).find((t) => {
      const x = textOf(t);
      return x && x !== heading;
    });
    if (!el) return false;
    const box = el.getBoundingClientRect();
    const bounds = list.getBoundingClientRect();
    if (!box.width || !bounds.width) return false;
    return bounds.right - box.right < box.left - bounds.left;
  }

  // The pane's own heading, only when it matches the list name: Facebook has
  // several landmark headings in the pane whose text varies by language.
  function paneTitle(name) {
    const main = first(SELECTORS.thread);
    if (!main || !name) return "";
    for (const h of main.querySelectorAll("h1, h2, h3")) {
      if (textOf(h) === name) return name;
    }
    return "";
  }

  function readThreadMessages(fallbackName) {
    const list = first(SELECTORS.messageList);
    if (!list) throw new LayoutError();
    const rows = [];
    for (const row of list.querySelectorAll(SELECTORS.messageRow)) {
      const heading = textOf(row.querySelector(SELECTORS.senderHeading));
      const outgoing = SELECTORS.outgoingHeading.test(heading) || isOwnByPosition(row, list, heading);
      const text = innermost(row, SELECTORS.messageText)
        .map(textOf)
        .filter((t) => t && t !== heading)
        .join(" ");
      rows.push({ outgoing, sender: outgoing ? null : heading || null, text, media: text ? null : mediaKind(row) });
    }
    return lib.attributeSenders(rows, fallbackName);
  }

  // ---- commands ------------------------------------------------------------

  async function handleList() {
    return { type: "chats", chats: readChats() };
  }

  // Identifies what the message list currently shows, so /open can tell the
  // new chat's content apart from the previous chat's still-rendered list.
  function listSignature(list) {
    if (!list) return null;
    const rows = list.querySelectorAll(SELECTORS.messageRow);
    const last = rows.length ? textOf(rows[rows.length - 1]) : "";
    return `${rows.length}|${last}`;
  }

  async function handleOpen(id) {
    const alreadyOpen = currentThreadId() === id;
    const prevList = first(SELECTORS.messageList);
    const prevSig = listSignature(prevList);
    if (!alreadyOpen) {
      const row = readChatRows().find((r) => r.chat.id === id);
      if (!row) return lib.errorMsg("conversation not found in the Messenger tab's list, run /list again");
      // The one click this extension ever makes: the chat row the terminal asked to open.
      row.link.click();
    }
    // The URL alone is not enough: the previous chat's list is still on the
    // page for a moment. Require a different list element or changed content.
    const ready = await waitForDom(() => {
      if (currentThreadId() !== id) return false;
      const list = first(SELECTORS.messageList);
      if (!list) return false;
      if (alreadyOpen || prevList === null) return true;
      return list !== prevList || listSignature(list) !== prevSig;
    }, OPEN_TIMEOUT_MS);
    if (!ready) {
      return currentThreadId() === id
        ? lib.errorMsg("conversation didn't finish loading; try /open again")
        : lib.errorMsg("couldn't open that conversation");
    }
    // Then let it finish rendering: ~300 ms with no changes in the list.
    const list = first(SELECTORS.messageList);
    await lib.waitForQuiet({
      quietMs: OPEN_QUIET_MS,
      maxMs: OPEN_QUIET_MAX_MS,
      subscribe: (cb) => domChanges(cb, list || document.documentElement),
    });
    if (currentThreadId() !== id) return lib.errorMsg("couldn't open that conversation");
    const name = threadName(id);
    const messages = readThreadMessages(name);
    resetBaseline(id, messages);
    // The pane's own title (not the list name), so a mismatch is visible.
    return lib.buildMessages(id, messages, paneTitle(name));
  }

  function composerFocused(composer) {
    const a = document.activeElement;
    return a === composer || composer.contains(a);
  }

  function pressEnter(el) {
    const init = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    // keydown is what submits; keyup only completes the pair. No keypress,
    // so no second handler can fire a duplicate send.
    el.dispatchEvent(new KeyboardEvent("keydown", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  // Real-page adapter for lib.performSend, which holds the whole send-safety
  // sequence (and is unit-tested against a fake of this adapter).
  const page = {
    pathname: () => location.pathname,
    isSettled: (id) => baseline.threadId === id && Date.now() >= baseline.settleUntil,
    findComposers: () => Array.from(document.querySelectorAll(SELECTORS.composer)),
    textOf: (box) => box.textContent,
    focus: (box) => box.focus(),
    isFocused: composerFocused,
    isAttached: (box) => box.isConnected,
    // focus() alone doesn't always put the caret inside the box (the caret may
    // still be wherever the last click was), and execCommand types at the
    // caret. So place it at the end of the box explicitly first.
    insertText: (box, text) => {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(box);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      return document.execCommand("insertText", false, text);
    },
    describe: (box) => {
      const sel = window.getSelection();
      const caretInBox = Boolean(sel && sel.anchorNode && box.contains(sel.anchorNode));
      return `visible=${document.visibilityState} hasFocus=${document.hasFocus()} connected=${box.isConnected} caretInBox=${caretInBox} shim=${document.documentElement.getAttribute("data-tm-shim")} len=${box.textContent.length}`;
    },
    pressEnter,
    waitFor: waitForDom,
  };

  // page-shim.js (page world) makes the page see a focused, visible document
  // for the length of a send; Facebook's message box ignores typing otherwise,
  // which is always the case when you are working in the terminal.
  function setFocusShim(on) {
    document.dispatchEvent(new Event(on ? "tm-shim-on" : "tm-shim-off"));
  }

  async function handleSend(id, text) {
    setFocusShim(true);
    try {
      const reply = await lib.performSend({ id, text, page, gate: sendGate, typeTimeoutMs: TYPE_TIMEOUT_MS });
      if (reply.type === "sent") recentSent.add(text);
      return reply;
    } finally {
      setFocusShim(false);
    }
  }

  async function handleCommand(cmd) {
    return lib.withRef(await runCommand(cmd), cmd.ref);
  }

  async function runCommand(cmd) {
    try {
      switch (cmd.type) {
        case "list":
          return await handleList();
        case "open":
          return await handleOpen(cmd.id);
        case "send":
          return await handleSend(cmd.id, cmd.text);
        default:
          return lib.errorMsg("unknown command");
      }
    } catch (err) {
      if (err instanceof LayoutError) return lib.errorMsg(LAYOUT_ERROR);
      return lib.errorMsg("unexpected error in the Messenger tab");
    }
  }

  // One command at a time, so two sends can never overlap.
  const runSerial = lib.createSerialRunner();

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !msg || msg.kind !== "command") return false;
    const v = lib.validateCommand(msg.cmd);
    if (!v.ok) {
      sendResponse(lib.withRef(lib.errorMsg(v.error), lib.isValidRef(msg.cmd && msg.cmd.ref) ? msg.cmd.ref : undefined));
      return false;
    }
    runSerial(() => handleCommand(v.cmd)).then(sendResponse, () =>
      sendResponse(lib.errorMsg("unexpected error in the Messenger tab")),
    );
    return true; // async response
  });

  // ---- incoming detection (read-only, never clicks) -----------------------

  function resetBaseline(threadId, messages) {
    baseline = { threadId, messages, settleUntil: Date.now() + SETTLE_AFTER_THREAD_CHANGE_MS };
  }

  function emit(event) {
    try {
      chrome.runtime.sendMessage({ kind: "event", event }).catch(() => {});
    } catch {
      // extension reloaded; this content script is orphaned
    }
  }

  function scanThread() {
    const tid = currentThreadId();
    if (tid === null) {
      if (baseline.threadId !== null) resetBaseline(null, []);
      return;
    }
    let name;
    let messages;
    try {
      name = threadName(tid);
      messages = readThreadMessages(name);
    } catch {
      return; // unreadable right now; keep the old baseline
    }
    if (tid !== baseline.threadId) {
      resetBaseline(tid, messages);
      return;
    }
    const fresh = lib.incomingOnly(lib.newMessagesSince(baseline.messages, messages));
    const settling = Date.now() < baseline.settleUntil;
    baseline.messages = messages;
    if (settling) return; // thread still rendering after a switch
    for (const m of fresh.slice(-MAX_EVENTS_PER_SCAN)) {
      if (recentSent.take(m.text)) continue;
      emit({ type: "incoming", id: tid, name: name || m.from, message: lib.buildMessage({ ...m, ts: Date.now() }) });
    }
  }

  function scanChatList() {
    let chats;
    try {
      chats = readChats();
    } catch {
      return;
    }
    const r = lib.diffUnreadChats(unreadState, chats, currentThreadId());
    unreadState = r.next;
    for (const e of r.events.slice(0, MAX_EVENTS_PER_SCAN)) emit(e);
  }

  function scan() {
    lastScan = Date.now();
    scanTimer = null;
    scanThread();
    scanChatList();
  }

  function scheduleScan() {
    if (scanTimer !== null) return;
    const wait = Math.max(0, lastScan + SCAN_THROTTLE_MS - Date.now());
    scanTimer = setTimeout(scan, wait);
  }

  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  scheduleScan();
})();
