import { test } from "node:test";
import assert from "node:assert/strict";
import { createSendQueue } from "../src/sendQueue.js";

function fakeClock() {
  const c = { t: 10_000 };
  c.now = () => c.t;
  c.sleep = async (ms) => {
    c.t += ms;
  };
  return c;
}

test("sends run in order with >= 1000 ms between starts", async () => {
  const clock = fakeClock();
  const starts = [];
  const sent = [];
  const q = createSendQueue(
    async (item) => {
      starts.push(clock.now());
      sent.push(item);
    },
    1000,
    clock.now,
    clock.sleep,
  );
  await Promise.all([q.enqueue("a"), q.enqueue("b"), q.enqueue("c")]);
  assert.deepEqual(sent, ["a", "b", "c"]);
  assert.ok(starts[1] - starts[0] >= 1000);
  assert.ok(starts[2] - starts[1] >= 1000);
});

test("does not sleep when the gap has already elapsed", async () => {
  const clock = fakeClock();
  const sleeps = [];
  const q = createSendQueue(
    async () => {},
    1000,
    clock.now,
    async (ms) => {
      sleeps.push(ms);
      await clock.sleep(ms);
    },
  );
  await q.enqueue("a");
  clock.t += 5000;
  await q.enqueue("b");
  assert.deepEqual(sleeps, []);
});

test("a failed send rejects its enqueue but later items still run", async () => {
  const clock = fakeClock();
  const sent = [];
  const q = createSendQueue(
    async (item) => {
      if (item === "bad") throw new Error("boom");
      sent.push(item);
    },
    1000,
    clock.now,
    clock.sleep,
  );
  const p1 = q.enqueue("bad");
  const p2 = q.enqueue("good");
  await assert.rejects(p1, /boom/);
  await p2;
  assert.deepEqual(sent, ["good"]);
});

test("sends never run concurrently", async () => {
  const clock = fakeClock();
  let active = 0;
  let maxActive = 0;
  const q = createSendQueue(
    async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setImmediate(r));
      active--;
    },
    1000,
    clock.now,
    clock.sleep,
  );
  await Promise.all([q.enqueue(1), q.enqueue(2), q.enqueue(3)]);
  assert.equal(maxActive, 1);
});
