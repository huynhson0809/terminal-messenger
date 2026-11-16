// Service worker: holds the WebSocket to the terminal app and relays between
// it and the content script in the Messenger tab.
//
// Privacy: never log the token or any message contents. The only network
// connection this extension makes is to ws://127.0.0.1:8765 (also enforced by
// connect-src in the manifest CSP).
importScripts("lib.js");

const lib = self.TMLib;
const BRIDGE_URL = "ws://127.0.0.1:8765";
const RECONNECT_MS = 5000;
const KEEPALIVE_MS = 20000;
const MESSENGER_URLS = ["https://www.facebook.com/messages/*", "https://www.messenger.com/*"];

let socket = null;
let connected = false;
let keepaliveTimer = null;
let reconnectTimer = null;
let generation = 0; // bumped when the saved token changes

async function readToken() {
  const { token } = await chrome.storage.local.get("token");
  return typeof token === "string" && /^[0-9a-f]{64}$/.test(token) ? token : null;
}

function setConnected(value) {
  connected = value;
}

function stopKeepalive() {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveTimer = null;
}

function closeSocket() {
  stopKeepalive();
  if (socket) {
    const s = socket;
    socket = null;
    s.onopen = s.onmessage = s.onclose = s.onerror = null;
    try {
      s.close();
    } catch {
      // already closed
    }
  }
  setConnected(false);
}

function sendToTerminal(msg) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !connected) return;
  try {
    socket.send(JSON.stringify(msg));
  } catch {
    // dropped mid-send
  }
}

// Called every RECONNECT_MS. Reading storage each tick is an extension API
// call, which also resets the MV3 idle timer, so the worker keeps retrying
// while a token is saved and the terminal app is not running yet.
async function tick() {
  reconnectTimer = null;
  const gen = generation;
  const token = await readToken();
  if (gen !== generation) return; // a newer tick (after a token change) owns the loop
  if (!token) {
    closeSocket();
  } else if (!socket) {
    connect(token);
  }
  scheduleTick();
}

function scheduleTick() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(tick, RECONNECT_MS);
}

function connect(token) {
  let ws;
  try {
    ws = new WebSocket(BRIDGE_URL);
  } catch {
    return;
  }
  socket = ws;
  ws.onopen = () => {
    if (socket !== ws) return;
    // The hello must be the first frame; the bridge drops us otherwise.
    ws.send(JSON.stringify({ type: "hello", token }));
    setConnected(true);
    stopKeepalive();
    // MV3 suspends idle workers; WebSocket traffic every 20 s keeps it alive.
    // The terminal app ignores unknown message types such as ping.
    keepaliveTimer = setInterval(() => sendToTerminal({ type: "ping" }), KEEPALIVE_MS);
  };
  ws.onmessage = (event) => {
    if (socket !== ws) return;
    let msg;
    try {
      msg = JSON.parse(typeof event.data === "string" ? event.data : "");
    } catch {
      return;
    }
    handleCommand(msg);
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    stopKeepalive();
    setConnected(false);
  };
  ws.onerror = () => {
    // onclose follows; nothing to log.
  };
}

async function findMessengerTab() {
  const tabs = await chrome.tabs.query({ url: MESSENGER_URLS });
  return lib.pickMessengerTab(tabs);
}

async function handleCommand(raw) {
  const v = lib.validateCommand(raw);
  if (!v.ok) {
    // Keepalive echoes or anything unexpected: ignore silently unless it
    // looks like an attempted command.
    if (raw && typeof raw === "object" && typeof raw.type === "string" && raw.type !== "ping") {
      sendToTerminal(lib.withRef(lib.errorMsg(v.error), lib.isValidRef(raw.ref) ? raw.ref : undefined));
    }
    return;
  }
  // Every reply to a send carries the send's ref, so the terminal can tell
  // which message it is about.
  const reply = (msg) => sendToTerminal(lib.withRef(msg, v.cmd.ref));
  let tab;
  try {
    tab = await findMessengerTab();
  } catch {
    tab = null;
  }
  if (!tab) {
    reply(lib.errorMsg("no Messenger tab open"));
    return;
  }
  let answer;
  try {
    answer = await chrome.tabs.sendMessage(tab.id, { kind: "command", cmd: v.cmd });
  } catch {
    // For a send this can also mean the tab went away mid-send, so the
    // terminal treats it as unconfirmed rather than "not sent".
    reply({
      ...lib.errorMsg("Messenger tab not ready, reload it (the extension must be loaded before the page)"),
      ...(v.cmd.type === "send" ? { unconfirmed: true } : {}),
    });
    return;
  }
  if (lib.isRelayable(answer)) reply(answer);
  else reply(lib.errorMsg("no reply from the Messenger tab"));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  // Unsolicited events from the content script (new incoming messages).
  if (sender.tab && msg && msg.kind === "event") {
    if (lib.isRelayable(msg.event) && msg.event.type === "incoming") sendToTerminal(msg.event);
    return false;
  }
  // Popup status query.
  if (!sender.tab && msg && msg.kind === "status") {
    sendResponse({ connected });
    return false;
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !("token" in changes)) return;
  // New or removed token: drop the current socket and reconnect right away.
  generation++;
  closeSocket();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  tick();
});

// Registered so Chrome starts the worker at browser start and on install;
// the top-level tick() below does the work.
chrome.runtime.onStartup.addListener(() => {});
chrome.runtime.onInstalled.addListener(() => {});

// Every worker start (install, browser start, popup or content-script
// message) kicks off the connect loop.
tick();
