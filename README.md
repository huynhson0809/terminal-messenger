# terminal-messenger

A small terminal client for Facebook Messenger. It lists your chats, shows recent messages and lets you reply, by relaying through a Chrome extension that works inside your own already-open Messenger tab.

Nothing logs in to Facebook for you: the terminal app talks only to the extension on this computer, and the extension reads and types in the tab you opened.

## Setup

1. Install dependencies: `npm install` (needs Node.js 20 or newer).
2. Run `npm start`. On first run it prints `Pairing token: ...`; copy that token. It is stored in `~/.terminal-messenger/token` and reused on later runs.
3. In Chrome, open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and choose the `extension/` folder.
4. Click the extension's icon, paste the token into the popup and press Save. The popup shows "connected" and the terminal prints `extension connected`.
5. Open `https://www.facebook.com/messages/` and pin the tab. Put it in its own Chrome window, with Messenger as that window's active tab. Chrome pauses pages in hidden windows (minimized, on another desktop, fully covered), and sending from a hidden window may fail with "couldn't type the message correctly"; if it does, make the window visible (a small corner of the screen or a second monitor is enough). The tab has to stay open. If the Messenger tab was already open before you loaded (or reloaded) the extension, reload the tab: Chrome doesn't add the extension to tabs that were already open.

Lost the token? Print it with `cat ~/.terminal-messenger/token`. To get a new one, delete that file and restart `npm start`, then paste the new token in the popup.

## Commands

- `/list` shows your chats, numbered (`*` marks unread).
- `/open <n>` opens chat number `n` from the last `/list` and shows recent messages.
- Every message in the open conversation is printed with a number: `[12] Name: text`.
- `/react <1-6>` reacts to the newest message from the other person: 1 like, 2 love, 3 haha, 4 wow, 5 sad, 6 angry. `/react <1-6> <message number>` reacts to that message instead. It prints `reacted ...` or `not reacted ...: reason`; it never retries.
- `/reply <message number> <text>` sends `<text>` as a reply to that message (Messenger's "reply" quote).
- `/more` scrolls the chat up in the tab and adds the older messages it finds at the top: the screen is cleared and the whole conversation is printed again, oldest first, newest last, with the older messages above the ones from `/open`. Message numbers shift by the number added, which it tells you. Run it again to go further back; the Messenger tab is scrolled back to the newest message each time. Facebook only keeps the messages in view on the page, so `/react` and `/reply` only work on the newest few messages (about what fits on one screen); for older ones they say so.
- `/help` (or `/?`) prints the list of commands.
- `/clear` clears the terminal screen and its scrollback.

Before acting on a numbered message, the extension checks that the message at that position still starts with the text you saw. If new or older messages moved things around it refuses (`that message isn't where it was ... run /open again`) instead of guessing. A reply to a message that has no text (an image, say) is refused.
- `/back` closes the open conversation.
- `/quit` exits.
- Any other text sends a reply to the open conversation. A line starting with a single `/` is treated as a command.
- `//text` sends a message that starts with a slash (it sends `/text`).
- One message per line. If you paste several lines at once, none of them is sent and the terminal prints `pasted N lines; not sent, send one line at a time`.

After `/open`, the app prints a `-- Name --` header with the name shown in the Facebook tab. Check that it matches the chat you picked. Replies are refused (`still opening ...`) until that header and the messages have arrived.

Each reply is confirmed by name: `sent: "first words…"`, or `not sent: "first words…": reason`. If no confirmation comes back within 20 seconds, or the extension disconnects, you see `no confirmation for "..."; run /open <n> to check before resending`. Do that before typing the message again, so it doesn't go out twice.

New messages ring the terminal bell. A message in the open chat is printed as it arrives; one in another chat is printed as `[new] Name: ...`.

## First-run checklist

1. `/list`: names and previews look right.
2. `/open 1`: recent messages show, with your own as "you".
3. Send "test" to yourself or to a friend who agreed. It should arrive once and the terminal prints `sent: "test"`.
4. Have them message you back. It should print with a bell and only once.

If a step reports an error such as "can't read the page", see Known limits.

## Tests

`npm test`

## Known limits

- The Messenger tab must stay open, and its window must stay at least partly visible to send. Chrome pauses a minimized, off-desktop or fully covered window: sending from it may fail (it fails safe and sends nothing), and new messages may not show up in the terminal until the window is visible again.
- Facebook changes its page layout from time to time. When it does, reading or sending can break until the selectors in the single `SELECTORS` object at the top of `extension/content.js` are updated. Those selectors were not verified against live Facebook when this was written, so expect to adjust them on first use.
- End-to-end encrypted chats only work if they are already unlocked in the browser tab.
- Text only. Images, stickers and videos show as placeholders such as `[image]`. File attachments without an image, video or audio preview may not notify.
- A send is refused unless the chat open in the Facebook tab is the one you typed into. It is also refused if the message box in the tab already holds a draft.
- This is not an official Facebook API and, strictly speaking, is against Facebook's terms, though it only uses your own open browser tab.
- A work network or laptop that logs traffic can still see your Facebook connections.

## Safety design

The app listens on `127.0.0.1:8765` only, and the extension may connect only to that address. Connections need the random pairing token. The extension does not read cookies. Nothing is sent until you press Enter on a line, messages go out at least 1 second apart, and a failed send is not retried.

Know this: the token only proves the extension to the app, not the other way round. The extension sends the token in clear to whatever is listening on `127.0.0.1:8765` and obeys any `list`, `open` or `send` it receives from there. So if another program on this computer takes port 8765 while the app is not running, it could read your chats and send messages as you. Keep the app running whenever a token is saved in the extension, or press "Clear token" in the popup when you're not using it (paste it again later).
