import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// The image type from the file's own first bytes (not its name), or null.
export function detectImageMime(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && (buf.subarray(0, 6).toString("latin1") === "GIF87a" || buf.subarray(0, 6).toString("latin1") === "GIF89a")) return "image/gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Read an image the user named in /image. Errors carry a message that is safe
// to print. Only real image files (checked by content) up to MAX_IMAGE_BYTES.
export async function loadImage(path, { read = readFile, status = stat, home = homedir(), cwd = process.cwd() } = {}) {
  const expanded = path === "~" || path.startsWith("~/") ? home + path.slice(1) : path;
  const full = resolve(cwd, expanded);
  let info;
  try {
    info = await status(full);
  } catch {
    throw new Error(`file not found: ${path}`);
  }
  if (!info.isFile()) throw new Error(`not a file: ${path}`);
  if (info.size > MAX_IMAGE_BYTES) throw new Error(`image too large (${formatSize(info.size)}; the limit is ${formatSize(MAX_IMAGE_BYTES)})`);
  const buf = await read(full);
  const mime = detectImageMime(buf);
  if (!mime) throw new Error("not a PNG, JPEG, GIF or WebP image");
  return { name: basename(full), mime, size: buf.length, data: buf.toString("base64") };
}
