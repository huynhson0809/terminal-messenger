// Serializes sends: one at a time, with at least minGapMs between send starts.
// A failed send rejects only its own enqueue promise; later items still run.
export function createSendQueue(
  sendFn,
  minGapMs = 1000,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  let tail = Promise.resolve();
  let lastStart = null;

  async function run(item) {
    if (lastStart !== null) {
      const wait = lastStart + minGapMs - now();
      if (wait > 0) await sleep(wait);
    }
    lastStart = now();
    return sendFn(item);
  }

  function enqueue(item) {
    const result = tail.then(() => run(item));
    tail = result.catch(() => {});
    return result;
  }

  return { enqueue };
}
