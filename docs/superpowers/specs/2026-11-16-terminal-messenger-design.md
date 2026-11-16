# Terminal Messenger: short design

## Intent and why
Read and reply to Facebook Messenger from a terminal, so no Facebook UI is visible on screen during work hours. Replies must be real Messenger messages sent from the user's own account.

## Goals
- See the conversation list and the messages in a chosen conversation.
- Get new messages in the terminal as they arrive (simple bell/line, no fancy notifications).
- Type a reply in the terminal and have it sent for real.
- Safest possible for the Facebook account.

## Non-goals
- Images, voice, reactions, calls, group management, history search. Non-text items show as `[image]`, `[attachment]`, etc.
- Fancy UI. Plain scrolling text and one input line.

## Anti-goals
- Anything that risks an account checkpoint or ban (no password handling, no direct calls to Facebook's internal API, no second login).
- Exposing messages to anything outside this Mac.

## Approaches considered
1. **Chrome extension + terminal app (chosen).** The extension runs inside the user's normal, already-open Messenger tab. Facebook only ever sees the user's real browser session.
2. Remote-controlled Chrome with a separate profile: more setup, needs a second login, same page-layout dependency. Rejected.
3. Unofficial API library: highest ban risk and cannot read encrypted chats. Rejected.

## Design (my calls, for the user to correct)
- **Extension (Chrome, Manifest V3):** a content script on the Messenger page reads the chat list and the open conversation from the page, and sends replies by typing into the real message box and pressing send, one message at a time. It makes no network requests to Facebook of its own.
- **Local bridge:** the terminal app runs a WebSocket server on `127.0.0.1` only, protected by a random token generated on first run and pasted into the extension once. Nothing leaves the machine.
- **Terminal app (Node.js, no UI framework):** commands `/list`, `/open <n>`, `/back`, `/quit`; typing any other line sends it as a reply to the open conversation; new incoming messages print as they arrive with a terminal bell.
- **Safety rules:** sends only on an explicit Enter in the terminal, a minimum delay of about 1 second between sends, no bulk or automatic replies, no password or cookie ever read or stored.
- **Where the tab lives:** a pinned Messenger tab in a separate Chrome window, minimized or on another desktop. It must stay open.

## Known limits
- Depends on Facebook's page layout; a Facebook update can break reading or sending until the selectors are fixed.
- Encrypted chats work only if they are already unlocked in the browser tab.
- Still against Facebook's terms in the strict sense, but it is the least detectable option since it is the user's own browser.

## Left to the builder
- Exact selectors and how to detect new messages in the page.
- Message format between extension and terminal.
- Project layout and tests (the bridge and command parsing can be tested without Facebook).
