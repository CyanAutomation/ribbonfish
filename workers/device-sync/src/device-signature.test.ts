import test from "node:test";
import assert from "node:assert/strict";
import { encodeBase64Url, decodeBase64Url, verifyDeviceSignature, equalSha256Digests } from "./device-signature.ts";
import { sha256HexBytes } from "./crypto-primitives.ts";

test("base64url and token comparison handle malformed inputs", () => {
  const bytes = new Uint8Array([0, 251, 255]);
  assert.equal(encodeBase64Url(bytes), "APv_");
  assert.deepEqual(decodeBase64Url("APv_"), bytes);
  assert.deepEqual(decodeBase64Url("!"), new Uint8Array());
});

test("SHA-256 digest comparison rejects malformed values and compares fixed-length hashes", () => {
  const hash = "a".repeat(64);
  assert.equal(equalSha256Digests(hash, hash), true);
  assert.equal(equalSha256Digests(hash, "a".repeat(63) + "b"), false);
  for (const invalid of [null, 42, "a".repeat(63), "a".repeat(65), "z".repeat(64), "A".repeat(64)]) {
    assert.equal(equalSha256Digests(hash, invalid), false);
  }
  assert.equal(equalSha256Digests("invalid", hash), false);
});

test("device signatures bind method, path, query, identity, timestamp, ETag and body", async () => {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  assert.ok("publicKey" in keys);
  const publicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
  const body = new TextEncoder().encode("payload");
  const timestamp = String(Date.now());
  const payload = ["ribbonfish-device-v1", "POST", "/v1/telemetry?x=1", "device-1", timestamp, '"a"', await sha256HexBytes(body)].join("\n");
  const signature = encodeBase64Url(new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(payload))));
  const request = new Request("https://example.test/v1/telemetry?x=1", { method: "POST", headers: { "X-Ribbonfish-Timestamp": timestamp, "X-Ribbonfish-Signature": signature, "If-None-Match": '"a"' } });
  assert.equal(await verifyDeviceSignature(request, "device-1", publicKey, body), true);
  assert.equal(await verifyDeviceSignature(request, "device-2", publicKey, body), false);
  assert.equal(await verifyDeviceSignature(request, "device-1", publicKey, new Uint8Array()), false);
  const expired = new Request(request, { headers: { "X-Ribbonfish-Timestamp": String(Date.now() - 600_000), "X-Ribbonfish-Signature": signature } });
  assert.equal(await verifyDeviceSignature(expired, "device-1", publicKey, body), false);
});
