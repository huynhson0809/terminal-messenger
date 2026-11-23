import { test } from "node:test";
import assert from "node:assert/strict";
import { detectImageMime, formatSize, loadImage, MAX_IMAGE_BYTES } from "../src/image.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = Buffer.from("GIF89a" + "xxxx", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(4)]);

test("detectImageMime looks at the bytes, not the name", () => {
  assert.equal(detectImageMime(PNG), "image/png");
  assert.equal(detectImageMime(JPG), "image/jpeg");
  assert.equal(detectImageMime(GIF), "image/gif");
  assert.equal(detectImageMime(WEBP), "image/webp");
  assert.equal(detectImageMime(Buffer.from("just some text, not an image")), null);
  assert.equal(detectImageMime(Buffer.alloc(0)), null);
});

test("formatSize", () => {
  assert.equal(formatSize(500), "500 B");
  assert.equal(formatSize(2048), "2 KB");
  assert.equal(formatSize(3 * 1024 * 1024), "3.0 MB");
});

function deps({ buf = PNG, isFile = true, size = buf.length, missing = false } = {}) {
  return {
    home: "/home/u",
    cwd: "/work",
    status: async (p) => {
      if (missing) throw new Error("ENOENT");
      deps.lastPath = p;
      return { isFile: () => isFile, size };
    },
    read: async () => buf,
  };
}

test("loadImage returns name, detected type, size and base64 data", async () => {
  const img = await loadImage("pics/cat.png", deps());
  assert.equal(img.name, "cat.png");
  assert.equal(img.mime, "image/png");
  assert.equal(img.size, PNG.length);
  assert.equal(img.data, PNG.toString("base64"));
  assert.equal(deps.lastPath, "/work/pics/cat.png");
});

test("loadImage expands ~ to the home directory", async () => {
  await loadImage("~/Desktop/a.png", deps());
  assert.equal(deps.lastPath, "/home/u/Desktop/a.png");
});

test("loadImage refuses missing files, directories, big files and non-images", async () => {
  await assert.rejects(loadImage("nope.png", deps({ missing: true })), /file not found/);
  await assert.rejects(loadImage("dir", deps({ isFile: false })), /not a file/);
  await assert.rejects(loadImage("big.png", deps({ size: MAX_IMAGE_BYTES + 1 })), /too large/);
  await assert.rejects(loadImage("notes.png", deps({ buf: Buffer.from("secret text") })), /not a PNG, JPEG, GIF or WebP/);
});
