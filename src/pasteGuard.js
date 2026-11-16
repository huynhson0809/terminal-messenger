// readline emits one "line" per newline, so a multi-line paste would become
// one message per line to a real person. Lines that arrive within windowMs of
// each other are treated as one paste burst and refused as a whole (the first
// line included), which is why every line waits windowMs before dispatch.
export function burstMessage(n) {
  return `pasted ${n} lines; not sent, send one line at a time`;
}

export function createPasteGuard({
  windowMs = 30,
  onLine,
  onBurst,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let buffer = [];
  let timer = null;

  function flush() {
    timer = null;
    const lines = buffer;
    buffer = [];
    const real = lines.filter((l) => l.trim() !== "");
    if (real.length > 1) onBurst(real.length);
    else if (lines.length > 0) onLine(real[0] ?? "");
  }

  return {
    push(line) {
      buffer.push(String(line));
      if (timer !== null) clearTimer(timer);
      timer = setTimer(flush, windowMs);
    },
  };
}
