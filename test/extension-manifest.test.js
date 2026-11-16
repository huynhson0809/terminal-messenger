import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const extDir = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
const manifest = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8"));

const MESSENGER = ["https://www.facebook.com/messages/*", "https://www.messenger.com/*"];

test("manifest is MV3", () => {
  assert.equal(manifest.manifest_version, 3);
});

test("host permissions are only the two Messenger patterns", () => {
  const hosts = manifest.host_permissions ?? [];
  assert.ok(hosts.length > 0);
  for (const h of hosts) assert.ok(MESSENGER.includes(h), `unexpected host permission ${h}`);
  assert.ok(!hosts.some((h) => h.startsWith("ws://") || h.startsWith("wss://")));
});

test("no dangerous or broad permissions anywhere", () => {
  const all = [
    ...(manifest.permissions ?? []),
    ...(manifest.optional_permissions ?? []),
    ...(manifest.host_permissions ?? []),
    ...(manifest.optional_host_permissions ?? []),
  ];
  for (const bad of [
    "cookies",
    "webRequest",
    "webRequestBlocking",
    "declarativeNetRequest",
    "<all_urls>",
    "debugger",
    "scripting",
    "history",
  ]) {
    assert.ok(!all.includes(bad), `forbidden permission ${bad}`);
  }
  assert.ok(!all.some((p) => p.includes("*://*/") || p === "*://*/*"));
  assert.deepEqual(manifest.permissions, ["storage"]);
});

test("content scripts run only on Messenger pages and load lib.js before content.js", () => {
  assert.equal(manifest.content_scripts.length, 1);
  const cs = manifest.content_scripts[0];
  for (const m of cs.matches) assert.ok(MESSENGER.includes(m), `unexpected match ${m}`);
  assert.deepEqual(cs.js, ["lib.js", "content.js"]);
});

test("extension pages may only connect to the local bridge", () => {
  const csp = manifest.content_security_policy?.extension_pages ?? "";
  const connect = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith("connect-src"));
  assert.equal(connect, "connect-src ws://127.0.0.1:8765");
});

test("service worker, popup and every referenced file exist", () => {
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal(manifest.action.default_popup, "popup.html");
  for (const f of ["background.js", "popup.html", "popup.js", ...manifest.content_scripts[0].js]) {
    assert.ok(existsSync(join(extDir, f)), `missing ${f}`);
  }
});
