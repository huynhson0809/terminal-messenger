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

    // Reactions. A message's toolbar (role=toolbar inside its row) only gets
    // its buttons while the mouse is over the message; the first one reacts.
    // The picker's six options are role=menuitemradio holding an emoji <img>.
    messageToolbar: '[role="toolbar"]',
    toolbarButton: '[role="button"]',
    reactionOption: '[role="menuitemradio"]',

    // Buttons around the message box (emoji, send / like...). Their labels are
    // localized, so the send button is found by position (see findSendButton).
    composerButton: '[role="button"], button',

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
  const MORE_MAX_STEPS = 12;

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
        // The name and preview (the first two texts) are bold on unread chats.
        if (texts.length < 2 && lib.isUnreadFontWeight(getComputedStyle(span).fontWeight)) unread = true;
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

  function mediaOf(row) {
    for (const [selector, kind] of SELECTORS.messageMedia) {
      for (const el of row.querySelectorAll(selector)) {
        const box = el.getBoundingClientRect();
        if (lib.isMessageMediaSize(box.width, box.height)) return { el, kind };
      }
    }
    return null;
  }

  function mediaKind(row) {
    const m = mediaOf(row);
    return m ? m.kind : null;
  }

  // Language-independent: your own messages sit against the right edge of the
  // message list, other people's against the left (after their avatar).
  function isOwnByPosition(row, list, heading) {
    const el = innermost(row, SELECTORS.messageText).find((t) => {
      const x = textOf(t);
      return x && x !== heading;
    });
    // A photo or video has no text: use the media itself.
    const target = el || (mediaOf(row) || {}).el;
    if (!target) return false;
    const box = target.getBoundingClientRect();
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

  function rowInfo(row, list) {
    const heading = textOf(row.querySelector(SELECTORS.senderHeading));
    const outgoing = SELECTORS.outgoingHeading.test(heading) || isOwnByPosition(row, list, heading);
    const text = innermost(row, SELECTORS.messageText)
      .map(textOf)
      .filter((t) => t && t !== heading)
      .join(" ");
    return { row, heading, outgoing, text, media: text ? null : mediaKind(row) };
  }

  // What the terminal prints for a row: its text, or a placeholder for media.
  function displayText(info) {
    return lib.cleanText(info.text) || lib.mediaPlaceholder(info.media);
  }

  // The rows that become messages (same rule as attributeSenders), oldest first.
  function keptRows(list) {
    return Array.from(list.querySelectorAll(SELECTORS.messageRow))
      .map((row) => rowInfo(row, list))
      .filter((info) => displayText(info));
  }

  function readThreadMessages(fallbackName) {
    const list = first(SELECTORS.messageList);
    if (!list) throw new LayoutError();
    const rows = [];
    for (const row of list.querySelectorAll(SELECTORS.messageRow)) {
      const info = rowInfo(row, list);
      rows.push({
        outgoing: info.outgoing,
        sender: info.outgoing ? null : info.heading || null,
        text: info.text,
        media: info.media,
      });
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
    moreState = { id: null, offset: 0, oldest: null };
    // The pane's own title (not the list name), so a mismatch is visible.
    return lib.buildMessages(id, messages, paneTitle(name));
  }

  // ---- reacting to the latest message from the other person ---------------

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Newest row that shows something and is not yours.
  function latestIncomingRow(list) {
    const rows = Array.from(list.querySelectorAll(SELECTORS.messageRow));
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      const heading = textOf(row.querySelector(SELECTORS.senderHeading));
      const hasText = innermost(row, SELECTORS.messageText).some((t) => {
        const x = textOf(t);
        return x && x !== heading;
      });
      if (!hasText && !mediaOf(row)) continue; // divider, spacer
      if (SELECTORS.outgoingHeading.test(heading) || isOwnByPosition(row, list, heading)) continue;
      return row;
    }
    return null;
  }

  // The toolbar's buttons are rendered only while the page believes the mouse
  // is over the message, so send it the hover events a real mouse would.
  function hover(el, on) {
    const names = on
      ? ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]
      : ["pointerout", "pointerleave", "mouseout", "mouseleave"];
    for (const type of names) {
      const bubbles = !/enter|leave/.test(type);
      const Ctor = type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, { bubbles, cancelable: true, composed: true, view: window }));
    }
  }

  function reactionOption(emoji) {
    for (const item of document.querySelectorAll(SELECTORS.reactionOption)) {
      const img = item.querySelector("img[alt]");
      if (img && lib.sameEmoji(img.getAttribute("alt"), emoji) && isVisible(item)) return item;
    }
    return null;
  }

  function reactionPickerOpen() {
    return lib.REACTION_EMOJI.some((e) => reactionOption(e) !== null);
  }

  // The message a command names: by its position from the newest and the start
  // of its text (both must agree), or the newest message from the other person.
  function resolveTarget(list, target) {
    if (!target) {
      const row = latestIncomingRow(list);
      return row ? { row } : { error: "no message from the other person to react to" };
    }
    const kept = keptRows(list);
    if (target.fromEnd >= kept.length) {
      return { error: "that message is further back than the Messenger tab keeps on screen (only the newest few messages can be reacted to or replied to)" };
    }
    const info = kept[kept.length - 1 - target.fromEnd];
    if (!info || !lib.textMatchesSnippet(displayText(info), target.text)) {
      return { error: "that message isn't where it was (new messages or older ones loaded); run /open again" };
    }
    return { row: info.row, text: displayText(info) };
  }

  // Message toolbar buttons only exist while the page thinks the mouse is over
  // the message: first is react, second is reply, third is more actions.
  const TOOLBAR_REACT = 0;
  const TOOLBAR_REPLY = 1;

  function toolbarButtonsOf(row) {
    const tb = row.querySelector(SELECTORS.messageToolbar);
    return tb ? Array.from(tb.querySelectorAll(SELECTORS.toolbarButton)) : [];
  }

  async function handleReact(id, n, targetSpec) {
    const emoji = lib.reactionEmoji(n);
    if (!emoji) return lib.errorMsg("invalid reaction number");
    if (currentThreadId() !== id) return lib.errorMsg("a different conversation is open in the Messenger tab; not reacted");
    if (!page.isSettled(id)) return lib.errorMsg("conversation still loading; not reacted");
    const list = first(SELECTORS.messageList);
    if (!list) throw new LayoutError();
    const resolved = resolveTarget(list, targetSpec);
    if (resolved.error) return lib.errorMsg(`${resolved.error}; not reacted`);
    const row = resolved.row;

    const toolbarButtons = () => toolbarButtonsOf(row);
    const target = row.querySelector(SELECTORS.messageText) || row;
    hover(target, true);
    try {
      if (!(await waitForDom(() => toolbarButtons().length >= 3, 2000))) {
        return lib.errorMsg("couldn't reach the message's reaction button; not reacted");
      }
      toolbarButtons()[TOOLBAR_REACT].click();
      if (!(await waitForDom(() => reactionOption(emoji) !== null, 2000))) {
        return lib.errorMsg("the reaction picker didn't open; not reacted");
      }
      // Still the same chat and the same message? Then pick, once, never retry.
      const option = reactionOption(emoji);
      if (currentThreadId() !== id || !row.isConnected || !option) {
        return lib.errorMsg("the conversation changed while reacting; not reacted");
      }
      option.click();
      const closed = await waitForDom(() => !reactionPickerOpen(), 3000);
      if (!closed) return { ...lib.errorMsg("reaction not confirmed; check the message in the Messenger tab"), unconfirmed: true };
      return { type: "reacted", id };
    } finally {
      hover(target, false);
    }
  }

  // Opens the reply box for one message (the toolbar's reply button), then
  // proves it: the quoted message's text must now appear in the area around
  // the message box. Returns null on success or an error message.
  async function prepareReply(id, targetSpec) {
    if (currentThreadId() !== id) return "a different conversation is open in the Messenger tab";
    if (!page.isSettled(id)) return "conversation still loading";
    const list = first(SELECTORS.messageList);
    if (!list) throw new LayoutError();
    const resolved = resolveTarget(list, targetSpec);
    if (resolved.error) return resolved.error;
    const quoted = resolved.text;
    if (/^\[(image|video|audio|attachment)\]$/.test(quoted)) return "can't reply to a message that has no text";
    const row = resolved.row;
    const composers = page.findComposers();
    if (composers.length !== 1) return lib.LAYOUT_ERROR;
    const box = composers[0];
    if (lib.cleanText(box.textContent) !== "") return "the message box in the Messenger tab is not empty";
    const target = row.querySelector(SELECTORS.messageText) || row;
    hover(target, true);
    try {
      if (!(await waitForDom(() => toolbarButtonsOf(row).length >= 3, 2000))) {
        return "couldn't reach the message's reply button";
      }
      toolbarButtonsOf(row)[TOOLBAR_REPLY].click();
    } finally {
      hover(target, false);
    }
    // The quoted text shows up in the composer's own area, which does not
    // contain the message list (so the list's copy of the text can't match).
    const snippet = quoted.slice(0, 20);
    const bannerShown = () => {
      for (let el = box.parentElement; el && !el.contains(list); el = el.parentElement) {
        if (lib.cleanText(el.textContent).toLowerCase().includes(snippet.toLowerCase())) return true;
      }
      return false;
    };
    if (!(await waitForDom(bannerShown, 2500))) return "the reply box didn't open";
    return null;
  }

  async function handleReply(id, text, targetSpec) {
    const problem = await prepareReply(id, targetSpec);
    if (problem) return lib.errorMsg(`${problem}; not sent`);
    const reply = await handleSend(id, text);
    if (reply.type === "error" && !reply.unconfirmed) {
      return { ...reply, message: `${reply.message} (the reply box may still be open in the Messenger tab)` };
    }
    return reply;
  }

  // ---- loading older messages -----------------------------------------------

  // The chat's scrolling box is inside the message list on the live page;
  // look there first, then outward.
  function findScroller(list) {
    const scrolls = (el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 10;
    for (const el of list.querySelectorAll("*")) if (scrolls(el)) return el;
    for (let el = list; el && el !== document.body; el = el.parentElement) if (scrolls(el)) return el;
    return null;
  }

  // Per conversation: how far (px) from the bottom the last /more scrolled, and
  // the text of the oldest message reported so far.
  let moreState = { id: null, offset: 0, oldest: null };

  // Facebook only keeps the messages around the view on the page, so /more
  // scrolls up in small steps until a message older than the oldest one
  // reported so far shows up (or the top is reached and nothing more loads),
  // then reports the messages on screen there. The terminal lines them up
  // with what it already shows.
  async function handleMore(id) {
    if (currentThreadId() !== id) return lib.errorMsg("a different conversation is open in the Messenger tab");
    const list = first(SELECTORS.messageList);
    if (!list) throw new LayoutError();
    const scroller = findScroller(list);
    if (!scroller) return lib.errorMsg("couldn't find the message list to scroll");
    const textsNow = () => keptRows(list).map(displayText);
    if (moreState.id !== id) moreState = { id, offset: 0, oldest: textsNow()[0] ?? null };
    const step = Math.max(80, Math.round(scroller.clientHeight * 0.5)); // well under a screen, so windows overlap
    for (let i = 0; i < MORE_MAX_STEPS; i++) {
      const wantTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - (moreState.offset + step));
      const heightBefore = scroller.scrollHeight;
      scroller.scrollTop = wantTop;
      // At the very top Facebook loads an older page of history: wait for it.
      if (wantTop === 0) await waitForDom(() => scroller.scrollHeight > heightBefore, 4000);
      await lib.waitForQuiet({
        quietMs: OPEN_QUIET_MS,
        maxMs: OPEN_QUIET_MAX_MS,
        subscribe: (cb) => domChanges(cb, list),
      });
      moreState.offset = Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
      const texts = textsNow();
      const idx = moreState.oldest === null ? -1 : texts.indexOf(moreState.oldest);
      if (idx > 0) {
        moreState.oldest = texts[0]; // something older than before is on screen
        break;
      }
      if (idx === -1) {
        moreState.oldest = texts[0] ?? null; // lost track; the terminal will say if it can't line up
        break;
      }
      if (wantTop === 0 && scroller.scrollHeight <= heightBefore) break; // top of history, nothing more
    }
    const name = threadName(id);
    const messages = readThreadMessages(name);
    scroller.scrollTop = scroller.scrollHeight; // back to the newest
    resetBaseline(id, messages);
    return lib.buildMessages(id, messages, paneTitle(name), { limit: lib.LIMITS.MAX_MORE_MESSAGES, older: true });
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
  // The send button: the rightmost button beside the message box. With an
  // empty box that slot is the "send a like" button; once there is text it
  // turns into the "send" button (and its label changes). A synthetic Enter
  // is ignored by Facebook, so we click that button instead, but only if its
  // label really changed after typing, so a like is never sent by mistake.
  let sendSlotLabelBefore = null;

  function composerButtons(box) {
    let el = box;
    for (let i = 0; i < 8 && el; i++, el = el.parentElement) {
      const btns = Array.from(el.querySelectorAll(SELECTORS.composerButton)).filter((b) => !box.contains(b));
      if (btns.length >= 3) return btns;
    }
    return [];
  }

  function sendSlotButton(box) {
    const boxRight = box.getBoundingClientRect().right;
    let best = null;
    let bestLeft = -Infinity;
    for (const b of composerButtons(box)) {
      const r = b.getBoundingClientRect();
      if (r.width > 0 && r.left >= boxRight && r.left > bestLeft) {
        best = b;
        bestLeft = r.left;
      }
    }
    return best;
  }

  const FOCUS_SETTLE_MS = 300;

  const page = {
    settleAfterFocus: () => new Promise((resolve) => setTimeout(resolve, FOCUS_SETTLE_MS)),
    beforeTyping: (box) => {
      const b = sendSlotButton(box);
      sendSlotLabelBefore = b ? b.getAttribute("aria-label") : null;
    },
    findSendButton: (box) => {
      const b = sendSlotButton(box);
      const label = b && b.getAttribute("aria-label");
      if (!b || !label || label === sendSlotLabelBefore) return null;
      return b;
    },
    clickSend: (button) => button.click(),
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
      return `visible=${document.visibilityState} hasFocus=${document.hasFocus()} connected=${box.isConnected} caretInBox=${caretInBox} activeInBox=${box.contains(document.activeElement)} htmlLen=${box.innerHTML.length} shim=${document.documentElement.getAttribute("data-tm-shim")} len=${box.textContent.length}`;
    },
    pressEnter,
    waitFor: waitForDom,
  };

  // page-shim.js (page world) makes document.hasFocus() true for the length of
  // a send; Facebook's message box ignores typing while the document is not
  // focused, which is always the case when you are working in the terminal.
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
        case "react":
          return await handleReact(cmd.id, cmd.n, cmd.target);
        case "reply":
          return await handleReply(cmd.id, cmd.text, cmd.target);
        case "more":
          return await handleMore(cmd.id);
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
