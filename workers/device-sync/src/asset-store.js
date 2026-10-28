import { ASSET_STAGING_MS, beginAssetWrite, finishAssetWrite } from "./asset-registry.js";

export const MAX_ASSET_BYTES = 32 << 20;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function isPNG(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 45 || bytes.byteLength > MAX_ASSET_BYTES ||
      !PNG_SIGNATURE.every((value, index) => bytes[index] === value) ||
      String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return false;
  const width = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16);
  const height = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20);
  return width > 0 && height > 0 && String.fromCharCode(...bytes.slice(-8, -4)) === "IEND";
}

export async function storePngAsset(input, bucket, {
  maxBytes = MAX_ASSET_BYTES,
  db,
  now = Date.now(),
  stagingMs = ASSET_STAGING_MS,
} = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) {
    throw new Error("PNG asset exceeds the configured size limit.");
  }
  if (!isPNG(bytes)) throw new Error("Asset must be a valid PNG image.");

  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  const size = bytes.byteLength;
  const key = `assets/${sha256}`;
  if (db) await beginAssetWrite(db, sha256, size, now);
  const existing = await bucket.head(key);
  if (!existing || existing.size !== size) {
    await bucket.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
    if (db) await finishAssetWrite(db, sha256, size, now, stagingMs);
    return { sha256, size, created: true };
  }
  if (db) await finishAssetWrite(db, sha256, size, now, stagingMs);
  return { sha256, size, created: false };
}
