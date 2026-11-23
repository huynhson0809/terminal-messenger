import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadOrCreateToken, startBridge } from "./bridge.js";
import { createSendQueue } from "./sendQueue.js";
import { createApp, createBridgeSender } from "./app.js";
import { loadImage } from "./image.js";
import { burstMessage, createPasteGuard } from "./pasteGuard.js";
import { needsNewToken } from "./token.js";

const tokenPath = join(homedir(), ".terminal-messenger", "token");
const firstRun = needsNewToken(tokenPath);
const token = loadOrCreateToken(tokenPath);
if (firstRun) {
  console.log(`Pairing token: ${token}`);
  console.log("paste this in the extension popup");
}

let app = null;
let bridge;
try {
  bridge = await startBridge({
    token,
    onMessage: (msg) => {
      if (msg?.type === "incoming") process.stdout.write("\u0007");
      try {
        app?.handleExtensionMessage(msg);
      } catch (err) {
        console.log(`error: ${err.message}`);
      }
    },
    onStatus: (up) => {
      console.log(up ? "extension connected" : "extension disconnected");
      app?.handleStatus(up);
    },
  });
} catch (err) {
  if (err?.code === "EADDRINUSE") {
    console.error("port 8765 is in use (another terminal-messenger, or something else?)");
    process.exit(1);
  }
  throw err;
}

const queue = createSendQueue(createBridgeSender(bridge));

const rl = createInterface({ input: process.stdin, output: process.stdout });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  rl.close();
  await bridge.close();
  process.exit(0);
}

app = createApp({
  bridge,
  print: (l) => console.log(l),
  queue,
  onQuit: shutdown,
  // Clear the screen and the scrollback.
  onClear: () => process.stdout.write("\x1b[2J\x1b[3J\x1b[H"),
  // Redraw the visible screen (for /more); the scrollback is left alone.
  // Bold unread chats in /list, on a real terminal unless NO_COLOR is set.
  loadImage,
  boldUnread: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
  onRedraw: () => process.stdout.write("\x1b[2J\x1b[H"),
});
console.log("terminal-messenger ready: type /help for the commands");

// A multi-line paste arrives as several lines within milliseconds; refuse
// the whole burst instead of sending one message per line.
const pasteGuard = createPasteGuard({
  onLine: (line) => {
    app.handleLine(line).catch((err) => console.log(`error: ${err.message}`));
  },
  onBurst: (n) => console.log(burstMessage(n)),
});
rl.on("line", (line) => pasteGuard.push(line));
rl.on("close", shutdown);
