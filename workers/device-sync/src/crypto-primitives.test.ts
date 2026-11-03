import test from "node:test";
import assert from "node:assert/strict";
import { randomToken, sha256Hex, sha256HexBytes } from "./crypto-primitives.ts";

test("SHA-256 helpers hash UTF-8 text and raw bytes", async () => {
  const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  assert.equal(await sha256Hex("abc"), expected);
  assert.equal(await sha256HexBytes(new TextEncoder().encode("abc")), expected);
  assert.equal(await sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("random tokens are 32 bytes encoded as lowercase hex", () => {
  const tokens = new Set(Array.from({ length: 16 }, randomToken));
  assert.equal(tokens.size, 16);
  for (const token of tokens) assert.match(token, /^[0-9a-f]{64}$/);
});
