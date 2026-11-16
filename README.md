# terminal-messenger

**Read and reply to Facebook Messenger from your terminal.**

[English](README.md) · [Tiếng Việt](README.vi.md)

`terminal-messenger` is a small Node.js terminal app plus a Chrome extension. The extension works inside a Messenger tab that you opened and logged into yourself, and relays it to the terminal on the same computer. You list chats, read messages, reply, react and load older messages by typing, without looking at the Facebook UI.

> **Not affiliated with Meta or Facebook.** This is an unofficial tool. It is not an official Messenger API and, strictly speaking, goes against Facebook's terms of service. See [Disclaimer](#disclaimer).

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Usage](#usage)
- [Safety and privacy](#safety-and-privacy)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Disclaimer](#disclaimer)
- [License](#license)

## Features

- List your chats and open one (`/list`, `/open`).
- Read recent messages, each with a number so you can refer to it.
- Reply by typing a line, or quote-reply to a specific message (`/reply`).
- React to the latest message from the other person, or to any recent message (`/react`).
- Load older messages on demand; the whole conversation is redrawn oldest first (`/more`).
- New messages arrive live and ring the terminal bell.
- Built-in help (`/help`) and a screen wiper (`/clear`).
- Not tied to English: the chat list, message list, buttons and reactions are found by page structure, position and emoji rather than by their (translated) text. Tested with a Vietnamese Facebook interface.

## How it works

```
 you type            ┌──────────────┐  127.0.0.1:8765   ┌───────────────────┐   ┌────────────────┐
 in the terminal ──▶ │ terminal app │ ◀───────────────▶ │ Chrome extension  │──▶│ your Messenger │
 (Node.js)           │ (this repo)  │   WebSocket,      │ (extension/)      │   │ tab (logged in │
                     └──────────────┘   token-protected └───────────────────┘   │ by you)        │
                                                                                 └────────────────┘
```

1. The terminal app listens only on `127.0.0.1` and accepts one connection, which must present a random pairing token.
2. The extension connects to it from its service worker and relays commands to a content script running in your Messenger tab.
3. The content script reads the page, and for a reply it types into the real message box and clicks the real send button, exactly like you would.

Nothing logs in to Facebook for you, no password or cookie is read, and the extension makes no requests of its own to Facebook.

## Requirements

- macOS, Linux or Windows with **Node.js 20 or newer**
- **Google Chrome** (or another Chromium browser) 116 or newer
- A Facebook account that you are already logged into in that browser

## Quick start

1. **Install** the dependencies:
   ```sh
   git clone https://github.com/huynhson0809/terminal-messenger.git
   cd terminal-messenger
   npm install
   ```
2. **Start the app.**
   ```sh
   npm start
   ```
   On first run it prints a pairing token (`Pairing token: ...`). It is stored in `~/.terminal-messenger/token` and reused later.
3. **Load the extension.** In Chrome open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose the `extension/` folder.
4. **Pair it.** Click the extension's icon, paste the token into the popup and press **Save**. The popup shows *connected* and the terminal prints `extension connected`.
5. **Open Messenger.** Go to `https://www.facebook.com/messages/` and make that tab the active tab of its own Chrome window. If the tab was already open before you loaded the extension, reload it (F5): Chrome does not add an extension to tabs that were open before it.

Keep that window **visible on screen**, even if it is small or in a corner (a second monitor also works). Chrome pauses pages in minimized or fully covered windows and sending from them can fail. See [Limitations](#limitations).

Then, in the terminal:

```
> /list
  1. Alice - see you at 5
● 2. Study group - Bob: did anyone start?
> /open 1
-- Alice --
[1] Alice: see you at 5?
[2] you: sure, usual place
> sounds good
sent: "sounds good"
```

Try it on a chat with yourself or a friend who agreed before using it for real.

## Usage

Every line you type is either a command (starts with `/`) or a message.

| Command | What it does |
|---|---|
| `/list` | Show your chats, numbered. Unread chats start with `●` and are shown in bold. |
| `/open <n>` | Open chat number `n` and print its recent messages. Each message has a `[number]`. |
| *any text* | Send it as a message in the open chat. |
| `//text` | Send a message that starts with a slash (sends `/text`). |
| `/reply <msg#> <text>` | Quote-reply to message `[msg#]`. |
| `/react <1-6> [msg#]` | React to the newest message from the other person, or to message `[msg#]`. `1` like, `2` love, `3` haha, `4` wow, `5` sad, `6` angry. |
| `/more` | Load older messages and redraw the chat: older messages at the top, the newest last. Run it again to go further back. |
| `/back` | Close the open chat. |
| `/clear` | Clear the screen and its scrollback. |
| `/help` (or `/?`) | Print the command list. |
| `/quit` | Exit. |

### Things worth knowing

- After `/open`, check that the `-- Name --` header matches the chat you picked. Replies are refused (`still opening ...`) until the header and the messages have arrived.
- Each message is confirmed by name: `sent: "first words…"`, or `not sent: "first words…": reason`. If you see `no confirmation for "..."`, run `/open <n>` to check whether it went out **before** typing it again, so it is not sent twice.
- Before acting on a numbered message (`/react`, `/reply`), the extension checks that the message at that position still starts with the text you saw. If new or older messages moved things around it refuses instead of guessing; run `/open` again.
- `/react` and `/reply` only reach the newest few messages (about one screen). Facebook keeps only the messages in view on the page.
- Paste one line at a time. A paste of several lines is refused so a stray clipboard never goes out as many messages.
- A new message rings the bell. In the open chat it is printed as it arrives; in another chat it appears as `[new] Name: ...`.

## Safety and privacy

- **Local only.** The app listens on `127.0.0.1:8765`; the extension is allowed to connect only to that address (enforced by its content security policy). Nothing is sent to any server of mine or anyone else's.
- **Token-protected.** A connection must present the 256-bit random pairing token as its first message. The token file is created with mode `0600`.
- **No credentials.** No password, cookie or session token is read, stored or logged. The extension's permissions are `storage` and access to `facebook.com/messages` and `messenger.com` only.
- **Deliberate sending.** Nothing is sent until you press Enter on a line. Messages go out at least one second apart, and a send is never retried automatically.
- **Wrong-chat protection.** A send is refused unless the chat open in the Facebook tab is the one you typed into, and it is refused if the message box already holds a draft. Typed text is verified against what you entered before the send button is clicked.
- **Untrusted text is neutralised.** Messages from other people are stripped of terminal control characters before they are printed.

One caveat: the token proves the extension to the app, not the other way round. If another program on the same computer takes port 8765 while the app is not running, it could read your chats and send as you. Keep the app running whenever a token is saved in the extension, or press **Clear token** in the popup when you are not using it.

Recover or replace the token: `cat ~/.terminal-messenger/token`, or delete that file and restart `npm start`, then paste the new token in the popup.

## Limitations

- **The Messenger window must stay open and visible** (even a small corner). Chrome pauses minimized, off-desktop or fully covered windows. Sending from one may fail (it fails safe and sends nothing), and new messages may not appear until it is visible again.
- **Facebook changes its page often.** When it does, reading or sending can break until the selectors in the `SELECTORS` object at the top of [`extension/content.js`](extension/content.js) are updated. They are the only place to fix. Issues and pull requests welcome.
- End-to-end encrypted chats only work if they are already unlocked in the browser tab.
- Text only. Images, stickers and videos show as placeholders such as `[image]`; file attachments with no image, video or audio preview may not notify.
- `/react` and `/reply` work on the newest few messages only.
- Your employer's or school's network and device may still log your connections to Facebook.

## Troubleshooting

| You see | What it means and what to do |
|---|---|
| `extension not connected, open the Messenger tab` | The extension is not connected. Check that the app is running, the extension is loaded, the token in the popup matches, and the popup says *connected*. |
| `Messenger tab not ready, reload it` | The tab was open before the extension. Reload it (F5). |
| `can't read the page, Facebook layout may have changed` | Facebook changed its page. Update the selectors in `extension/content.js` (see [Development](#development)). |
| `conversation still loading; not sent` | You replied right after `/open`. Wait about 3 seconds and try again. |
| `the message box in the Messenger tab is not empty; not sent` | A draft is sitting in the message box. Clear it in the tab. |
| `couldn't type the message correctly; not sent` | The text did not land in the message box. Make sure the window is visible and try again. The `[debug: ...]` part helps when reporting an issue. |
| `couldn't find the send button; not sent` | The send button was not recognised. Clear the draft in the tab and report the issue. |
| `no confirmation for "..."` | The app did not hear back. Run `/open <n>` to check whether the message went out before sending it again. |
| `that message isn't where it was ... run /open again` | New or older messages shifted the numbering. Run `/open` again. |
| `that message is further back than the Messenger tab keeps on screen` | `/react` and `/reply` only reach the newest few messages. |
| `port 8765 is in use` | Another copy of the app (or another program) is using the port. |

## Development

```sh
npm test      # run the whole test suite (node:test, no extra dependencies)
```

Project layout:

```
src/          terminal app: commands, rendering, local bridge, send queue
extension/    Chrome extension (Manifest V3): service worker, content script, page shim, popup
test/         tests for both sides
docs/         the original design and implementation plan
```

- Protocol between the two sides: JSON over a local WebSocket. Terminal to extension: `list`, `open`, `send`, `reply`, `react`, `more`. Extension to terminal: `chats`, `messages`, `incoming`, `sent`, `reacted`, `error`.
- Everything that depends on Facebook's page lives in `SELECTORS` at the top of `extension/content.js`. Prefer stable hooks (roles, `aria` structure, emoji) over generated class names, and avoid matching on text, which Facebook translates.
- The extension's pure logic is in `extension/lib.js` and is unit-tested; the send-safety sequence (`performSend`) is tested against a fake page.

## Disclaimer

This project is provided as is, without warranty. It is **not** affiliated with, endorsed by or connected to Meta Platforms, Inc. "Facebook" and "Messenger" are trademarks of their owner. Automating a Facebook account goes against Facebook's terms of service and may lead to restrictions on your account. You use it at your own risk and are responsible for complying with the terms and rules that apply to you, including those of your employer or school.

## License

[MIT](LICENSE)
