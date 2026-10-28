import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { storePngAsset } from "./asset-store.js";

const png = new Uint8Array(await readFile(new URL("../../../agent/defaults/assets/service-health.png", import.meta.url)));

function bucket() {
  const objects = new Map();
  const writes = [];
  return {
    objects,
    writes,
    async head(key) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.byteLength } : null;
    },
    async put(key, bytes, options) {
      objects.set(key, new Uint8Array(bytes));
      writes.push({ key, options });
    },
  };
}

test("PNG storage is content-addressed and can be shared by uploads and captures", async () => {
  const ASSETS = bucket();
  const first = await storePngAsset(png, ASSETS);
  const second = await storePngAsset(png, ASSETS);

  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.equal(first.size, png.byteLength);
  assert.equal(second.sha256, first.sha256);
  assert.equal(second.size, first.size);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(ASSETS.writes.length, 1);
  assert.equal(ASSETS.writes[0].key, `assets/${first.sha256}`);
  assert.equal(ASSETS.writes[0].options.httpMetadata.contentType, "image/png");
});

test("PNG storage rejects invalid image bytes and oversized content before writing", async () => {
  const ASSETS = bucket();
  await assert.rejects(storePngAsset(new Uint8Array([1, 2, 3]), ASSETS), /valid PNG/i);
  await assert.rejects(storePngAsset(png, ASSETS, { maxBytes: png.byteLength - 1 }), /size limit/i);
  assert.equal(ASSETS.writes.length, 0);
});
