# Terminal Messenger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read and reply to Facebook Messenger from a terminal through a Chrome extension running in the user's own open Messenger tab.

**Architecture:** A Node.js terminal app runs a WebSocket server on `127.0.0.1`. A Chrome MV3 extension's service worker connects to it with a shared token and relays commands to a content script in the Messenger tab. The content script reads the chat list and open conversation from the page DOM and sends replies by typing into the real composer.

**Tech Stack:** Node.js 20+ (ESM, `node:test`), `ws`, Chrome Manifest V3. No UI framework.

**Spec:** `docs/superpowers/specs/2026-11-16-terminal-messenger-design.md`

## Global Constraints

- Bridge listens on `127.0.0.1` only, never `0.0.0.0`.
- Every WebSocket connection must present the random token generated on first run; wrong or missing token is closed immediately.
- The extension makes no network requests to Facebook of its own; it only reads and types into the page.
- No password, cookie or session data is read, stored or logged.
- Sends happen only after an explicit Enter in the terminal, one at a time, with at least 1000 ms between sends.
- v1 handles text only; non-text items render as `[image]`, `[attachment]`, etc.
- Commands: `/list`, `/open <n>`, `/back`, `/quit`; any other non-empty line is a reply to the open conversation.
- Plain text UI, no UI framework.

## Review Focus

- Reply typed with no conversation open: refused with a clear message, nothing sent.
- `/open 99` or `/open abc` out of range or non-numeric: error message, no crash.
- Messenger tab closed or extension not connected: terminal says so and refuses to send instead of hanging.
- Reply text containing newlines or leading `/` not in the command list (for example `/shrug`): sent as plain text on a single line, command typos like `/opn 1` give a hint rather than being sent.
- Two sends within 1000 ms: the second is delayed, not dropped or sent in parallel.

---

## File Structure

- `package.json`: ESM, `ws` dependency, `npm test` runs `node --test`.
- `src/commands.js`: parse a terminal input line into a command object.
- `src/render.js`: format chat lists and messages as plain text lines.
- `src/bridge.js`: token creation/storage and the authenticated local WebSocket server.
- `src/sendQueue.js`: serialize sends with the minimum gap.
- `src/index.js`: wires the above into the interactive terminal app.
- `extension/manifest.json`, `extension/background.js`, `extension/content.js`, `extension/popup.html`, `extension/popup.js`: the Chrome side.
- `test/*.test.js`: tests for the Node modules.
- `README.md`: setup in five steps.

Wire protocol (JSON over the WebSocket, shared by bridge and extension):
- terminal → extension: `{type:"list"}`, `{type:"open", id:string}`, `{type:"send", id:string, text:string}`
- extension → terminal: `{type:"chats", chats:[{id, name, preview, unread}]}`, `{type:"messages", id, messages:[{from, text, ts}]}`, `{type:"incoming", id, name, message:{from, text, ts}}`, `{type:"sent", id}`, `{type:"error", message}`

### Task 1: Command parsing and rendering

**Files:**
- Create: `package.json`, `src/commands.js`, `src/render.js`
- Test: `test/commands.test.js`, `test/render.test.js`

**Interfaces:**
- Produces: `parseCommand(line: string): {kind:"list"} | {kind:"open", n:number} | {kind:"back"} | {kind:"quit"} | {kind:"send", text:string} | {kind:"error", message:string} | {kind:"empty"}`
- Produces: `renderChats(chats: Chat[]): string[]`, `renderMessage(m: Message, name?: string): string` where `Chat={id,name,preview,unread}`, `Message={from,text,ts}`

- [ ] **Step 1: Write failing tests** in `test/commands.test.js`: `"/list"` → `{kind:"list"}`; `"/open 2"` → `{kind:"open", n:2}`; `"/open abc"` and `"/open"` → `kind:"error"`; `"/opn 1"` → `kind:"error"` whose message contains `"/open"`; `"/shrug"` → `kind:"error"` (unknown command, not sent); `"hello there"` → `{kind:"send", text:"hello there"}`; `"   "` → `{kind:"empty"}`; `"//literal"` → `{kind:"send", text:"/literal"}` (escape for a real leading slash). In `test/render.test.js`: `renderChats` numbers from 1 and marks unread with `*`; `renderMessage` for non-text (`text` empty or `null`) returns `[attachment]`.
- [ ] **Step 2: Run** `node --test` and confirm the tests fail (modules missing).
- [ ] **Step 3: Implement** `parseCommand` in `src/commands.js` and `renderChats`/`renderMessage` in `src/render.js` to satisfy the tests; `package.json` has `"type":"module"`, `"scripts":{"test":"node --test"}`, dependency `ws`.
- [ ] **Step 4: Run** `npm install && npm test`; expected: all pass.
- [ ] **Step 5: Commit** `feat: command parsing and rendering`.

### Task 2: Send queue

**Files:**
- Create: `src/sendQueue.js`
- Test: `test/sendQueue.test.js`

**Interfaces:**
- Produces: `createSendQueue(sendFn: (item) => Promise<void>, minGapMs = 1000, now = Date.now, sleep = (ms) => Promise<void>): { enqueue(item): Promise<void> }`

- [ ] **Step 1: Write failing tests**: with injected fake `now`/`sleep`, two enqueues back to back call `sendFn` in order and the second waits so that gap between starts is ≥ 1000 ms; if `sendFn` rejects, that enqueue rejects but the next item still runs; items never run concurrently.
- [ ] **Step 2: Run** `node --test test/sendQueue.test.js`; expect FAIL.
- [ ] **Step 3: Implement** `createSendQueue` in `src/sendQueue.js` as a promise chain that sleeps the remaining gap before each send.
- [ ] **Step 4: Run** the test; expect PASS.
- [ ] **Step 5: Commit** `feat: serialized send queue`.

### Task 3: Local authenticated bridge

**Files:**
- Create: `src/bridge.js`
- Test: `test/bridge.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `loadOrCreateToken(path: string): string` (32 random bytes hex, file mode 0600, reused if present); `startBridge({token, port = 8765, onMessage: (msg) => void, onStatus: (connected: boolean) => void}): Promise<{send(msg): void, isConnected(): boolean, close(): Promise<void>}>`

- [ ] **Step 1: Write failing tests**: `loadOrCreateToken` creates a 64-char hex file at mode 0600 in a temp dir and returns the same value on a second call; with `port: 0`, a client using the right token (sent as the first message `{type:"hello", token}`) triggers `onStatus(true)` and its later messages reach `onMessage`; a client with a wrong token or a non-JSON first message is closed and `onStatus` never fires; `send` after the client disconnects does not throw and `isConnected()` is false; server binds to `127.0.0.1` (assert the address from `server.address()`); only one extension connection is accepted at a time (a second authenticated client replaces the first).
- [ ] **Step 2: Run** `node --test test/bridge.test.js`; expect FAIL.
- [ ] **Step 3: Implement** both functions in `src/bridge.js` using `ws` and `node:crypto`; compare tokens with `crypto.timingSafeEqual`. The returned object should expose the real bound port (for `port: 0` in tests).
- [ ] **Step 4: Run** the test; expect PASS.
- [ ] **Step 5: Commit** `feat: authenticated localhost bridge`.

### Task 4: Terminal app

**Files:**
- Create: `src/index.js`
- Modify: `package.json` (add `"bin"`/`"start"`: `node src/index.js`)
- Test: `test/app.test.js`

**Interfaces:**
- Consumes: `parseCommand`, `renderChats`, `renderMessage`, `createSendQueue`, `loadOrCreateToken`, `startBridge` with the signatures above.
- Produces: `createApp({bridge, print: (line) => void, queue}): { handleLine(line: string): Promise<void>, handleExtensionMessage(msg): void }` (exported so it is testable without a TTY). `src/index.js` runs the real wiring: token at `~/.terminal-messenger/token`, prints the token and "paste this in the extension popup" on first run, reads lines with `node:readline`, rings the bell (`\u0007`) on `incoming`.

- [ ] **Step 1: Write failing tests** with a fake bridge and a recording `print`: `/list` sends `{type:"list"}`; a `chats` message prints numbered chats; `/open 2` after a list sends `{type:"open", id:<second chat id>}`; `/open 99` prints an error and sends nothing; text with no open conversation prints "open a conversation first" and sends nothing; text with an open conversation goes through the queue and sends `{type:"send", id, text}`; with `bridge.isConnected()` false every command that needs the extension prints "extension not connected, open the Messenger tab" and sends nothing; an `incoming` message for the open conversation prints as a message line, and for another conversation prints a one-line `[new] <name>: <text>` notice; `/back` clears the open conversation; an `error` message from the extension is printed.
- [ ] **Step 2: Run** `node --test test/app.test.js`; expect FAIL.
- [ ] **Step 3: Implement** `createApp` and the real entry wiring in `src/index.js`; `/quit` closes the bridge and exits.
- [ ] **Step 4: Run** `npm test`; expect all pass.
- [ ] **Step 5: Commit** `feat: terminal app`.

### Task 5: Chrome extension

**Files:**
- Create: `extension/manifest.json`, `extension/background.js`, `extension/content.js`, `extension/popup.html`, `extension/popup.js`

**Interfaces:**
- Consumes: the wire protocol in File Structure.
- Produces: an unpacked MV3 extension. Permissions: `storage`, host permission only for the Messenger pages (`https://www.facebook.com/messages/*`, `https://www.messenger.com/*`) plus `ws://127.0.0.1:8765/*`. No other hosts.

- [ ] **Step 1: Write `manifest.json`** (MV3, service worker `background.js`, content script on the two Messenger URL patterns, action popup) with the permissions above and nothing broader.
- [ ] **Step 2: Implement `popup.html`/`popup.js`**: one field to paste the token, saved to `chrome.storage.local`, plus a status line showing "connected" or "not connected" to the terminal.
- [ ] **Step 3: Implement `background.js`**: the service worker opens the WebSocket to `ws://127.0.0.1:8765`, sends `{type:"hello", token}`, reconnects every 5 s while the token exists, forwards terminal commands to the Messenger tab's content script via `chrome.tabs.sendMessage`, and forwards content-script replies and `incoming` events back to the socket. If no Messenger tab is open, reply `{type:"error", message:"no Messenger tab open"}`. Keep the worker alive with a 20 s ping while the socket is open.
- [ ] **Step 4: Implement `content.js`**: all page selectors live in one `SELECTORS` object at the top of the file with a comment that this is the only place to fix after a Facebook UI update. Handle `list` (read chat rows from the sidebar), `open` (click the row, wait for the thread, return the last 30 text messages), `send` (focus the composer, insert the text with `document.execCommand("insertText")`, dispatch Enter, wait until the composer clears, then reply `sent`; on failure reply an `error`), and a `MutationObserver` on the thread that emits `incoming` for new messages not sent by the user. Never read cookies, tokens or `localStorage`. If a selector finds nothing, return `{type:"error", message:"can't read the page, Facebook layout may have changed"}` rather than guessing.
- [ ] **Step 5: Manual verify**: load unpacked at `chrome://extensions`, paste the token, open `facebook.com/messages` in a pinned tab, run the app, and confirm in order: `/list` shows your real chats; `/open 1` shows recent messages; send "test" to a chat of your own (a friend who agreed, or yourself) and confirm it arrives; receive a message and confirm it prints with a bell. Selectors will need adjusting against the live page; do that in `SELECTORS` only.
- [ ] **Step 6: Commit** `feat: chrome extension`.

### Task 6: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write** five setup steps (install Node deps, run `npm start` and copy the token, load the unpacked extension, paste the token, open and pin the Messenger tab in a separate window), the command list, and the known limits from the spec (tab must stay open, layout updates can break reading, encrypted chats must be unlocked in the browser).
- [ ] **Step 2: Commit** `docs: setup instructions`.

## Self-review notes

- Spec coverage: list/read/reply (Tasks 1, 4, 5), new-message notice with bell (Tasks 4, 5), local token-protected bridge (Task 3), send delay and explicit Enter (Tasks 2, 4), text-only with placeholders (Task 1), known limits (Task 6).
- Task 4 depends on Task 1-3 signatures exactly as listed in each Interfaces block; protocol message names are fixed in File Structure and used identically in Tasks 4 and 5.
- Task 5 cannot be unit tested without Facebook; its checks are the manual steps, and it fails closed with an explicit error when selectors stop matching.
