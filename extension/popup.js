// Popup: paste the pairing token, save it, see whether the bridge is up.
// The saved token is never shown back or logged.
const TOKEN_RE = /^[0-9a-f]{64}$/;

const input = document.getElementById("token");
const statusEl = document.getElementById("status");
const noteEl = document.getElementById("note");

async function refreshStatus() {
  let connected = false;
  try {
    const res = await chrome.runtime.sendMessage({ kind: "status" });
    connected = Boolean(res && res.connected);
  } catch {
    connected = false;
  }
  statusEl.textContent = connected ? "connected" : "not connected";
}

async function refreshNote() {
  const { token } = await chrome.storage.local.get("token");
  noteEl.textContent = token ? "A token is saved." : "No token saved yet.";
}

document.getElementById("save").addEventListener("click", async () => {
  const value = input.value.trim().toLowerCase();
  if (value === "") {
    noteEl.textContent = "Paste the token first.";
    return;
  } else if (!TOKEN_RE.test(value)) {
    noteEl.textContent = "That doesn't look like a token (64 hex characters).";
    return;
  } else {
    await chrome.storage.local.set({ token: value });
    noteEl.textContent = "Saved. Connecting…";
  }
  input.value = "";
  setTimeout(refreshStatus, 1000);
});

refreshNote();
refreshStatus();
setInterval(refreshStatus, 1000);
