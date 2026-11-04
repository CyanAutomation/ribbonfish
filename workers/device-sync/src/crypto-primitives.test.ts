import test from "node:test";
import assert from "node:assert/strict";
import { randomToken, sha256Hex, sha256HexBytes } from "./crypto-primitives.ts";

// Secret and digest handling: ../../../README.md#security-principles.
test("SHA-256 helpers hash UTF-8 text and raw bytes", async () => {
  const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  assert.equal(await sha256Hex("abc"), expected);
  assert.equal(await sha256HexBytes(new TextEncoder().encode("abc")), expected);
  assert.equal(await sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("random tokens encode 32 Web Crypto bytes as lowercase hex", (t) => {
  t.mock.method(globalThis.crypto, "getRandomValues", (bytes: Uint8Array) => {
    bytes.fill(0xab);
    return bytes;
  });
  assert.equal(randomToken(), "ab".repeat(32));
});
