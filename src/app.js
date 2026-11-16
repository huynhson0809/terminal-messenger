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

function snippet(text) {
  const t = clean(text);
  return t.length > SNIPPET_LEN ? t.slice(0, SNIPPET_LEN) + "…" : t;
}

// The queue's send function. Checks the connection at send time (not only at
// enqueue time) so a dropped extension is reported instead of a silent no-op.
export function createBridgeSender(bridge) {
  return async ({ id, text, ref }) => {
    if (!bridge.isConnected()) throw new Error("extension not connected");
    bridge.send({ type: "send", id, text, ref });
  };
}

// Pure app logic: no I/O of its own. `bridge` needs {send, isConnected},
// `queue` needs {enqueue(item)}, `print` receives one output line at a time.
export function createApp({
  bridge,
  print,
  queue,
  onQuit = () => {},
  confirmTimeoutMs = CONFIRM_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let chats = [];
  // { id, name, confirmed }: confirmed only once the extension's `messages`
  // reply for this id arrives, so replies can't go out while the tab is
  // still switching chats.
  let open = null;
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
      case "back":
        open = null;
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
        bridge.send({ type: "open", id: chat.id });
        return;
      }
      case "react": {
        if (!open) {
          print("open a conversation first");
          return;
        }
        if (!open.confirmed) {
          print(`still opening ${clean(open.name)}; wait for its messages before reacting`);
          return;
        }
        if (!requireConnection()) return;
        const ref = `r${++refCounter}`;
        const p = { snip: REACTION_LABELS[cmd.n - 1], n: 0, timer: null, kind: "react" };
        pending.set(ref, p);
        bridge.send({ type: "react", id: open.id, n: cmd.n, ref });
        p.timer = setTimer(() => {
          if (settle(ref)) print(noConfirmation(p));
        }, confirmTimeoutMs);
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
        const ref = `s${++refCounter}`;
        const index = chats.findIndex((c) => c.id === open.id);
        const p = { snip: snippet(cmd.text), n: index === -1 ? "<n>" : index + 1, timer: null };
        pending.set(ref, p);
        try {
          await queue.enqueue({ id: open.id, text: cmd.text, ref });
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
        return;
      }
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
        const lines = msg.messages.map((m) => renderMessage(cleanMessage(m)));
        open.confirmed = true;
        // The tab's own pane title, to cross-check against the /list name.
        print(`-- ${clean(msg.title).trim() || "(title unreadable)"} --`);
        for (const l of lines) print(l);
        return;
      }
      case "incoming": {
        const m = cleanMessage(msg.message);
        if (open && msg.id === open.id) print(renderMessage(m));
        else print(`[new] ${renderMessage(m, clean(msg.name) || undefined)}`);
        return;
      }
      case "sent": {
        const p = typeof msg.ref === "string" ? settle(msg.ref) : null;
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
