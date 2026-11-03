import test from "node:test";
import assert from "node:assert/strict";
import { hasExactKeys, hasOnlyKeys, isRecord } from "./validation.ts";

test("isRecord accepts objects but rejects null, arrays and primitives", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord(Object.create(null)), true);
  for (const value of [null, undefined, [], "object", 1, true]) {
    assert.equal(isRecord(value), false);
  }
});

test("key validators require own keys on non-array objects", () => {
  const inherited = Object.assign(Object.create({ inherited: true }), { own: 1 });
  assert.equal(hasExactKeys(inherited, ["own"]), true);
  assert.equal(hasExactKeys(inherited, ["inherited"]), false);
  assert.equal(hasExactKeys({ own: 1, extra: 2 }, ["own"]), false);
  assert.equal(hasExactKeys({}, []), true);
  assert.equal(hasOnlyKeys({ own: 1 }, ["own", "optional"]), true);
  assert.equal(hasOnlyKeys({ unexpected: 1 }, ["own"]), false);
  for (const value of [null, undefined, [], "object", 1, true]) {
    assert.equal(hasExactKeys(value, []), false);
    assert.equal(hasOnlyKeys(value, []), false);
  }
});
