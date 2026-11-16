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
    chatList: [
      '[role="navigation"] [role="grid"][aria-label="Chats"]',
      '[role="grid"][aria-label="Chats"]',
      '[role="navigation"][aria-label="Chats"]',
      '[aria-label="Chats"]',
    ],
    // A conversation link inside the list: href is /messages/t/<id>/ or
    // /messages/e2ee/t/<id>/ (messenger.com: /t/<id>/, /e2ee/t/<id>/).
    chatRowLink: 'a[href*="/t/"]',
    // Ancestor of the link that holds the whole row (name, preview, badges).
    chatRowContainer: '[role="row"], [role="listitem"], [role="gridcell"]',
    // Text pieces in a row, in order: name first, then the preview line.
    chatRowText: 'span[dir="auto"]',
    // Unread markers in a row (either one counts).
    chatRowUnread: '[aria-label*="unread" i], [aria-label="Mark as read"]',
    chatRowUnreadText: /^unread message:?$/i,

    // The open conversation.
    thread: '[role="main"]',
    messageList: [
      '[role="main"] [aria-label^="Messages in conversation"]',
      '[role="main"] [role="grid"]',
    ],
    messageRow: '[role="row"]',
    // Message body text inside a row.
    messageText: 'div[dir="auto"]',
    // Screen-reader heading on a row: the sender's name, or "You sent".
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
  const { LIMITS, LAYOUT_ERROR } = lib;
  const OPEN_TIMEOUT_MS = 10000;
  const TYPE_TIMEOUT_MS = 1500;
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

  function domChanges(cb) {
    const obs = new MutationObserver(cb);
    obs.observe(document.documentElement, {
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
      const row = link.closest(SELECTORS.chatRowContainer) || link;
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

  function readThreadMessages(fallbackName) {
    const list = first(SELECTORS.messageList);
    if (!list) throw new LayoutError();
    const rows = [];
    for (const row of list.querySelectorAll(SELECTORS.messageRow)) {
      const heading = textOf(row.querySelector(SELECTORS.senderHeading));
      const outgoing = SELECTORS.outgoingHeading.test(heading);
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

  async function handleOpen(id) {
    if (currentThreadId() !== id) {
      const row = readChatRows().find((r) => r.chat.id === id);
      if (!row) return lib.errorMsg("conversation not found in the Messenger tab's list, run /list again");
      // The one click this extension ever makes: the chat row the terminal asked to open.
      row.link.click();
    }
    const ready = await waitForDom(
      () => currentThreadId() === id && first(SELECTORS.messageList) !== null,
      OPEN_TIMEOUT_MS,
    );
    if (!ready) {
      return currentThreadId() === id ? lib.errorMsg(LAYOUT_ERROR) : lib.errorMsg("couldn't open that conversation");
    }
    // Give the thread a moment to render its rows (resolves early once text shows).
    await waitForDom(() => readThreadMessages("").length > 0, 1500);
    const name = threadName(id);
    const messages = readThreadMessages(name);
    resetBaseline(id, messages);
    return lib.buildMessages(id, messages);
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

  async function handleSend(id, rawText) {
    // 1. Guard: the open thread must be the requested one, text must be sane.
    const guard = lib.canSend(location.pathname, id, rawText);
    if (!guard.ok) return lib.errorMsg(guard.error);
    const text = guard.text;

    const composer = document.querySelector(SELECTORS.composer);
    if (!composer) return lib.errorMsg(LAYOUT_ERROR);
    // Never mix our text into something the user is typing in the tab.
    if (!lib.composerIsEmpty(composer.textContent)) {
      return lib.errorMsg("the message box in the Messenger tab is not empty; not sent");
    }

    // 2. Keep at least 1 s between Enter presses, even when this send was
    //    queued behind a slow open/confirm. Then re-check everything: the
    //    page may have changed while we waited.
    await sendGate.waitTurn();
    const afterWait = lib.canSend(location.pathname, id, text);
    if (!afterWait.ok) return lib.errorMsg(afterWait.error);
    if (!composer.isConnected || !lib.composerIsEmpty(composer.textContent)) {
      return lib.errorMsg("the message box in the Messenger tab changed; not sent");
    }

    // 3. Type it into the real composer.
    composer.focus();
    if (!composerFocused(composer)) return lib.errorMsg("couldn't focus the message box; not sent");
    document.execCommand("insertText", false, text);
    const typed = await waitForDom(() => lib.composerMatches(composer.textContent, text), TYPE_TIMEOUT_MS);
    if (!typed) {
      return lib.errorMsg(
        "couldn't type the message correctly; not sent (check the Messenger tab, the text may be in the box)",
      );
    }

    // 4. Re-check right before Enter: still the same thread, still focused.
    const again = lib.canSend(location.pathname, id, text);
    if (!again.ok) return lib.errorMsg(`${again.error} (the text is still in the message box)`);
    if (!composer.isConnected || !composerFocused(composer)) {
      return lib.errorMsg("the message box lost focus; not sent (the text is still in the box)");
    }

    // 5. Press Enter once and wait for the box to clear. Never retry.
    sendGate.markSent(); // start-to-start: recorded as Enter is pressed
    pressEnter(composer);
    const cleared = await waitForDom(() => {
      const box = document.querySelector(SELECTORS.composer);
      return box !== null && lib.composerIsEmpty(box.textContent);
    }, LIMITS.SEND_CONFIRM_TIMEOUT_MS);
    if (!cleared) {
      return lib.errorMsg("send not confirmed after 5 s; not retrying, check the Messenger tab");
    }
    recentSent.add(text);
    return { type: "sent", id };
  }

  async function handleCommand(cmd) {
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
      sendResponse(lib.errorMsg(v.error));
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
