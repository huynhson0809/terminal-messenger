import { existsSync, readFileSync } from "node:fs";

// True when loadOrCreateToken will have to mint a token (file missing or invalid).
export function needsNewToken(path) {
  if (!existsSync(path)) return true;
  try {
    return !/^[0-9a-f]{64}$/.test(readFileSync(path, "utf8").trim());
  } catch {
    return true;
  }
}
