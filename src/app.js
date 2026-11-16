import { parseCommand } from "./commands.js";
import { renderChats, renderMessage } from "./render.js";

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

// Remote text is untrusted: neutralize ESC, newlines, bell, other control
// chars and bidi overrides (which can visually reorder a line).
function clean(v) {
  return String(v ?? "").replace(CONTROL_RE, " ");
}

function cleanChat(c) {
  if (!c || typeof c !== "object") throw new Error("bad chat entry");
  return { id: c.id, name: clean(c.name), preview: clean(c.preview), unread: Boolean(c.unread) };
}

function cleanMessage(m) {
  if (!m || typeof m !== "object") throw new Error("bad message entry");
  return { from: clean(m.from), text: clean(m.text), ts: m.ts };
}

// /react <n>: the same numbering the extension uses.
const REACTION_LABELS = ["\u{1F44D} like", "\u2764\uFE0F love", "\u{1F606} haha", "\u{1F62E} wow", "\u{1F622} sad", "\u{1F621} angry"];

const NOT_CONNECTED = "extension not connected, open the Messenger tab";
const CONFIRM_TIMEOUT_MS = 20000;
const SNIPPET_LEN = 30;
const LATEST_DEFAULT = 10;
const TARGET_LEN = 40; // how much of a message's text names it to the extension

function snippet(text) {
  const t = clean(text);
  return t.length > SNIPPET_LEN ? t.slice(0, SNIPPET_LEN) + "…" : t;
}

// The queue's send function. Checks the connection at send time (not only at
// enqueue time) so a dropped extension is reported instead of a silent no-op.
export function createBridgeSender(bridge) {
  return async ({ id, text, ref, target }) => {
    if (!bridge.isConnected()) throw new Error("extension not connected");
    bridge.send(target ? { type: "reply", id, text, target, ref } : { type: "send", id, text, ref });
  };
}

// Largest k such that the last k of `chunk` have the same texts as the first k
// of `thread` (the sender is not compared: the first rows of a window are
// attributed before their sender heading is in view).
function overlap(chunk, thread) {
  for (let k = Math.min(chunk.length, thread.length); k >= 1; k--) {
    let same = true;
    for (let i = 0; i < k && same; i++) same = chunk[chunk.length - k + i].text === thread[i].text;
    if (same) return k;
  }
  return 0;
}

// Pure app logic: no I/O of its own. `bridge` needs {send, isConnected},
// `queue` needs {enqueue(item)}, `print` receives one output line at a time.
export function createApp({
  bridge,
  print,
  queue,
  onQuit = () => {},
  onClear = () => {},
  confirmTimeoutMs = CONFIRM_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let chats = [];
  // { id, name, confirmed }: confirmed only once the extension's `messages`
  // reply for this id arrives, so replies can't go out while the tab is
  // still switching chats.
  let open = null;
  // The open chat's messages as printed, oldest first. A message's number in
  // the terminal is its position here (1 = oldest).
  let thread = [];
  // ref -> { snip, n, timer }: sends waiting for `sent` / `error`.
  const pending = new Map();
  let refCounter = 0;

  function noConfirmation(p) {
    if (p.kind === "react") {
      return `no confirmation for reaction ${p.snip}; check the message in the Messenger tab before reacting again`;
    }
    return `no confirmation for "${p.snip}"; run /open ${p.n} to check before resending`;
  }

  function settle(ref) {
    const p = pending.get(ref);
    if (!p) return null;
    pending.delete(ref);
    if (p.timer !== null) clearTimer(p.timer);
    return p;
  }

  function requireConnection() {
    if (bridge.isConnected()) return true;
    print(NOT_CONNECTED);
    return false;
  }

  function numbered(n, m) {
    return `[${n}] ${renderMessage(m)}`;
  }

  // Names a printed message to the extension: position from the newest, plus
  // the start of its text (the extension checks both before acting).
  function targetFor(msgNo) {
    const m = thread[msgNo - 1];
    if (!m) return null;
    return { fromEnd: thread.length - msgNo, text: m.text.slice(0, TARGET_LEN) };
  }

  // Common checks for commands that act on the open conversation.
  function requireOpen(what) {
    if (!open) {
      print("open a conversation first");
      return false;
    }
    if (!open.confirmed) {
      print(`still opening ${clean(open.name)}; wait for its messages before ${what}`);
      return false;
    }
    return requireConnection();
  }

  async function handleLine(line) {
    const cmd = parseCommand(line);
    switch (cmd.kind) {
      case "empty":
        return;
      case "error":
        print(cmd.message);
        return;
      case "quit":
        await onQuit();
        return;
      case "clear":
        onClear();
        return;
      case "back":
        open = null;
        thread = [];
        print("closed conversation");
        return;
      case "list":
        if (!requireConnection()) return;
        bridge.send({ type: "list" });
        return;
      case "open": {
        if (!requireConnection()) return;
        const chat = chats[cmd.n - 1];
        if (!chat) {
          print(`error: no conversation ${cmd.n} (run /list first)`);
          return;
        }
        open = { id: chat.id, name: chat.name, confirmed: false };
        thread = [];
        bridge.send({ type: "open", id: chat.id });
        return;
      }
      case "latest": {
        if (!open || !open.confirmed) {
          print("open a conversation first");
          return;
        }
        const count = Math.min(cmd.count ?? LATEST_DEFAULT, thread.length);
        print(`-- latest ${count} message${count === 1 ? "" : "s"} --`);
        for (let i = thread.length - count; i < thread.length; i++) print(numbered(i + 1, thread[i]));
        return;
      }
      case "more": {
        if (!requireOpen("loading older messages")) return;
        print("loading older messages...");
        bridge.send({ type: "more", id: open.id });
        return;
      }
      case "react": {
        if (!requireOpen("reacting")) return;
        let target;
        if (cmd.msg !== undefined) {
          target = targetFor(cmd.msg);
          if (!target) {
            print(`error: no message ${cmd.msg} (run /open or /more to see message numbers)`);
            return;
          }
        }
        const ref = `r${++refCounter}`;
        const p = { snip: REACTION_LABELS[cmd.n - 1], n: 0, timer: null, kind: "react" };
        pending.set(ref, p);
        bridge.send(target ? { type: "react", id: open.id, n: cmd.n, ref, target } : { type: "react", id: open.id, n: cmd.n, ref });
        p.timer = setTimer(() => {
          if (settle(ref)) print(noConfirmation(p));
        }, confirmTimeoutMs);
        return;
      }
      case "reply": {
        if (!requireOpen("replying")) return;
        const target = targetFor(cmd.msg);
        if (!target) {
          print(`error: no message ${cmd.msg} (run /open or /more to see message numbers)`);
          return;
        }
        await sendText(cmd.text, target);
        return;
      }
      case "send": {
        if (!open) {
          print("open a conversation first");
          return;
        }
        if (!open.confirmed) {
          print(`still opening ${clean(open.name)}; wait for its messages before replying`);
          return;
        }
        if (!requireConnection()) return;
        await sendText(cmd.text, undefined);
        return;
      }
    }
  }

  // One text message (or a reply to `target`) through the queue.
  async function sendText(text, target) {
    const ref = `s${++refCounter}`;
    const index = chats.findIndex((c) => c.id === open.id);
    const p = { snip: snippet(text), n: index === -1 ? "<n>" : index + 1, timer: null, text, chatId: open.id };
    pending.set(ref, p);
    try {
      await queue.enqueue(target ? { id: open.id, text, ref, target } : { id: open.id, text, ref });
    } catch (err) {
      settle(ref);
      print(`send failed: "${p.snip}": ${err?.message ?? err}`);
      return;
    }
    // The reply may already have arrived; only time out a still-pending send.
    if (pending.get(ref) === p) {
      p.timer = setTimer(() => {
        if (settle(ref)) print(noConfirmation(p));
      }, confirmTimeoutMs);
    }
  }

  function handleExtensionMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    try {
      handleTyped(msg);
    } catch {
      print(`error: malformed ${clean(msg.type)} message from extension`);
    }
  }

  function handleTyped(msg) {
    switch (msg.type) {
      case "chats": {
        if (!Array.isArray(msg.chats)) throw new Error("chats not an array");
        const next = msg.chats.map(cleanChat);
        chats = next;
        for (const l of renderChats(chats)) print(l);
        return;
      }
      case "messages": {
        if (!open || msg.id !== open.id) return;
        if (!Array.isArray(msg.messages)) throw new Error("messages not an array");
        const next = msg.messages.map(cleanMessage);
        if (msg.older === true) {
          // Reply to /more: the messages on screen one step further up. Line
          // them up with the start of what is already shown (by text).
          const k = overlap(next, thread);
          if (k === 0) {
            print("couldn't line the older messages up with the ones shown; run /open and try /more again");
            return;
          }
          const older = next.slice(0, next.length - k);
          if (older.length === 0) {
            print("no older messages");
            return;
          }
          thread = older.concat(thread);
          const added = older.length;
          print(`-- ${added} older message${added === 1 ? "" : "s"} (message numbers have shifted by ${added}) --`);
          for (let i = 0; i < added; i++) print(numbered(i + 1, thread[i]));
          return;
        }
        thread = next;
        open.confirmed = true;
        // The tab's own pane title, to cross-check against the /list name.
        print(`-- ${clean(msg.title).trim() || "(title unreadable)"} --`);
        thread.forEach((m, i) => print(numbered(i + 1, m)));
        return;
      }
      case "incoming": {
        const m = cleanMessage(msg.message);
        if (open && msg.id === open.id) {
          thread.push(m);
          print(numbered(thread.length, m));
        } else print(`[new] ${renderMessage(m, clean(msg.name) || undefined)}`);
        return;
      }
      case "sent": {
        const p = typeof msg.ref === "string" ? settle(msg.ref) : null;
        // The sent message is now the newest row in the chat; keep message
        // numbers aligned with the page.
        if (p && p.text !== undefined && open && p.chatId === open.id) thread.push({ from: "you", text: clean(p.text) });
        print(p ? `sent: "${p.snip}"` : "sent");
        return;
      }
      case "reacted": {
        const p = typeof msg.ref === "string" ? settle(msg.ref) : null;
        print(p ? `reacted ${p.snip}` : "reacted");
        return;
      }
      case "error": {
        const p = typeof msg.ref === "string" ? settle(msg.ref) : null;
        if (!p) print(`error: ${clean(msg.message)}`);
        else if (msg.unconfirmed === true) print(noConfirmation(p));
        else if (p.kind === "react") print(`not reacted ${p.snip}: ${clean(msg.message)}`);
        else print(`not sent: "${p.snip}": ${clean(msg.message)}`);
        return;
      }
    }
  }

  // Bridge status. On disconnect, every pending send's fate is unknown.
  function handleStatus(up) {
    if (up) return;
    for (const ref of [...pending.keys()]) {
      const p = settle(ref);
      if (p) print(noConfirmation(p));
    }
  }

  return { handleLine, handleExtensionMessage, handleStatus };
}
