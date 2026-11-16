# terminal-messenger

A small terminal client for Facebook Messenger. It lists your chats, shows recent messages and lets you reply, by relaying through a Chrome extension that works inside your own already-open Messenger tab.

Nothing logs in to Facebook for you: the terminal app talks only to the extension on this computer, and the extension reads and types in the tab you opened.

## Setup

1. Install dependencies: `npm install` (needs Node.js).
2. Run `npm start`. On first run it prints `Pairing token: ...`; copy that token. It is stored in `~/.terminal-messenger/token` and reused on later runs.
3. In Chrome, open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and choose the `extension/` folder.
4. Click the extension's icon, paste the token into the popup and press Save. The popup shows "connected" and the terminal prints `extension connected`.
5. Open `https://www.facebook.com/messages/` and pin the tab. Put it in a separate Chrome window that you minimize or move to another desktop. The tab has to stay open.

## Commands

- `/list` shows your chats, numbered (`*` marks unread).
- `/open <n>` opens chat number `n` from the last `/list` and shows recent messages.
- `/back` closes the open conversation.
- `/quit` exits.
- Any other text sends a reply to the open conversation. A line starting with a single `/` is treated as a command.
- `//text` sends a message that starts with a slash (it sends `/text`).

New messages ring the terminal bell. A message in the open chat is printed as it arrives; one in another chat is printed as `[new] Name: ...`.

## First-run checklist

1. `/list`: names and previews look right.
2. `/open 1`: recent messages show, with your own as "you".
3. Send "test" to yourself or to a friend who agreed. It should arrive once and the terminal prints `sent`.
4. Have them message you back. It should print with a bell and only once.

If a step reports an error such as "can't read the page", see Known limits.

## Tests

`npm test`

## Known limits

- The Messenger tab must stay open (a minimized window is fine).
- Facebook changes its page layout from time to time. When it does, reading or sending can break until the selectors in the single `SELECTORS` object at the top of `extension/content.js` are updated. Those selectors were not verified against live Facebook when this was written, so expect to adjust them on first use.
- End-to-end encrypted chats only work if they are already unlocked in the browser tab.
- Text only. Images, stickers and videos show as placeholders such as `[image]`. File attachments without an image, video or audio preview may not notify.
- A send is refused unless the chat open in the Facebook tab is the one you typed into. It is also refused if the message box in the tab already holds a draft.
- This is not an official Facebook API and, strictly speaking, is against Facebook's terms, though it only uses your own open browser tab.
- A work network or laptop that logs traffic can still see your Facebook connections.

## Safety design

The app listens on `127.0.0.1:8765` only, and the extension may connect only to that address. Connections need the random pairing token. The extension does not read cookies. Nothing is sent until you press Enter on a line, messages go out at least 1 second apart, and a failed send is not retried.
