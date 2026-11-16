import { test } from "node:test";
import assert from "node:assert/strict";
import { createPasteGuard } from "../src/pasteGuard.js";

function setup() {
  const timers = [];
  const lines = [];
  const bursts = [];
  const guard = createPasteGuard({
    windowMs: 30,
    onLine: (l) => lines.push(l),
    onBurst: (n) => bursts.push(n),
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.live = false;
    },
  });
  const fire = () => {
    for (const t of timers.filter((x) => x.live)) {
      t.live = false;
      t.fn();
    }
  };
  return { guard, lines, bursts, timers, fire };
}

test("a single typed line is dispatched after the short window", () => {
  const s = setup();
  s.guard.push("hello");
  assert.deepEqual(s.lines, []);
  assert.equal(s.timers.at(-1).ms, 30);
  s.fire();
  assert.deepEqual(s.lines, ["hello"]);
  assert.deepEqual(s.bursts, []);
});

test("lines arriving within the window are a paste: the whole burst is refused, first line included", () => {
  const s = setup();
  s.guard.push("line one");
  s.guard.push("line two");
  s.guard.push("line three");
  s.fire();
  assert.deepEqual(s.lines, []);
  assert.deepEqual(s.bursts, [3]);
});

test("each new line restarts the window (only one live timer)", () => {
  const s = setup();
  s.guard.push("a");
  s.guard.push("b");
  assert.equal(s.timers.filter((t) => t.live).length, 1);
});

test("separate typed lines (window elapsed in between) each go through", () => {
  const s = setup();
  s.guard.push("first");
  s.fire();
  s.guard.push("second");
  s.fire();
  assert.deepEqual(s.lines, ["first", "second"]);
});

test("blank lines in a burst don't count: one real line plus trailing newline still sends", () => {
  const s = setup();
  s.guard.push("hello");
  s.guard.push("");
  s.guard.push("   ");
  s.fire();
  assert.deepEqual(s.lines, ["hello"]);
  assert.deepEqual(s.bursts, []);
});

test("a burst of only blank lines does nothing", () => {
  const s = setup();
  s.guard.push("");
  s.guard.push("");
  s.fire();
  assert.deepEqual(s.lines, [""]);
  assert.deepEqual(s.bursts, []);
});

test("burstMessage wording", async () => {
  const { burstMessage } = await import("../src/pasteGuard.js");
  assert.equal(burstMessage(4), "pasted 4 lines; not sent, send one line at a time");
});
