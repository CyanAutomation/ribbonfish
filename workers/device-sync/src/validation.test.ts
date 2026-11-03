import test from "node:test";
import assert from "node:assert/strict";
import { isRecord } from "./validation.ts";

test("isRecord accepts objects but rejects null, arrays and primitives", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord(Object.create(null)), true);
  for (const value of [null, undefined, [], "object", 1, true]) {
    assert.equal(isRecord(value), false);
  }
});
