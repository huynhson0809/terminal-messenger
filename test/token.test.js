import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsNewToken } from "../src/token.js";

const dir = mkdtempSync(join(tmpdir(), "tm-token-"));

test("missing file needs a new token", () => {
  assert.equal(needsNewToken(join(dir, "nope")), true);
});
test("valid token file does not", () => {
  const p = join(dir, "ok");
  writeFileSync(p, "a".repeat(64) + "\n");
  assert.equal(needsNewToken(p), false);
});
test("invalid token file needs a new token", () => {
  for (const [n, c] of [["short", "abc"], ["upper", "A".repeat(64)], ["empty", ""]]) {
    const p = join(dir, n);
    writeFileSync(p, c);
    assert.equal(needsNewToken(p), true, n);
  }
});
