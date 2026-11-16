import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadOrCreateToken, startBridge } from "./bridge.js";
import { createSendQueue } from "./sendQueue.js";
import { createApp } from "./app.js";
import { needsNewToken } from "./token.js";

const tokenPath = join(homedir(), ".terminal-messenger", "token");
const firstRun = needsNewToken(tokenPath);
const token = loadOrCreateToken(tokenPath);
if (firstRun) {
  console.log(`Pairing token: ${token}`);
  console.log("paste this in the extension popup");
}

let app = null;
const bridge = await startBridge({
  token,
  onMessage: (msg) => {
    if (msg?.type === "incoming") process.stdout.write("\u0007");
    try {
      app?.handleExtensionMessage(msg);
    } catch (err) {
      console.log(`error: ${err.message}`);
    }
  },
  onStatus: (up) =>
    console.log(up ? "extension connected" : "extension disconnected"),
});

const queue = createSendQueue(async ({ id, text }) => {
  bridge.send({ type: "send", id, text });
});

const rl = createInterface({ input: process.stdin, output: process.stdout });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  rl.close();
  await bridge.close();
  process.exit(0);
}

app = createApp({ bridge, print: (l) => console.log(l), queue, onQuit: shutdown });
console.log("terminal-messenger ready: /list, /open <n>, /back, /quit");

rl.on("line", (line) => {
  app.handleLine(line).catch((err) => console.log(`error: ${err.message}`));
});
rl.on("close", shutdown);
