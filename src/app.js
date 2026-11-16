import { parseCommand } from "./commands.js";
import { renderChats, renderMessage } from "./render.js";

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
    switch (msg.type) {
      case "chats":
        chats = Array.isArray(msg.chats) ? msg.chats : [];
        for (const l of renderChats(chats)) print(l);
        return;
      case "messages":
        if (!open || msg.id !== open.id) return;
        for (const m of msg.messages ?? []) print(renderMessage(m));
        return;
      case "incoming":
        if (open && msg.id === open.id) print(renderMessage(msg.message));
        else print(`[new] ${renderMessage(msg.message, msg.name)}`);
        return;
      case "sent":
        print("sent");
        return;
      case "error":
        print(`error: ${msg.message}`);
        return;
    }
  }

  return { handleLine, handleExtensionMessage };
}
