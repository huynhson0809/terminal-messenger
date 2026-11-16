import { parseCommand } from "./commands.js";
import { renderChats, renderMessage } from "./render.js";

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

// Remote text is untrusted: neutralize ESC, newlines, bell and other control chars.
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

const NOT_CONNECTED = "extension not connected, open the Messenger tab";

// Pure app logic: no I/O of its own. `bridge` needs {send, isConnected},
// `queue` needs {enqueue(item)}, `print` receives one output line at a time.
export function createApp({ bridge, print, queue, onQuit = () => {} }) {
  let chats = [];
  let open = null; // { id, name }

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
        open = { id: chat.id, name: chat.name };
        bridge.send({ type: "open", id: chat.id });
        return;
      }
      case "send": {
        if (!open) {
          print("open a conversation first");
          return;
        }
        if (!requireConnection()) return;
        try {
          await queue.enqueue({ id: open.id, text: cmd.text });
        } catch (err) {
          print(`send failed: ${err?.message ?? err}`);
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
        for (const l of lines) print(l);
        return;
      }
      case "incoming": {
        const m = cleanMessage(msg.message);
        if (open && msg.id === open.id) print(renderMessage(m));
        else print(`[new] ${renderMessage(m, clean(msg.name) || undefined)}`);
        return;
      }
      case "sent":
        print("sent");
        return;
      case "error":
        print(`error: ${clean(msg.message)}`);
        return;
    }
  }

  return { handleLine, handleExtensionMessage };
}
