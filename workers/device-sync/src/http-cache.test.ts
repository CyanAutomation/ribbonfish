import test from "node:test";
import assert from "node:assert/strict";
import { matchesETag } from "./http-cache.ts";

test("conditional ETags match exact values and the wildcard in comma-separated lists", () => {
  assert.equal(matchesETag(null, '"v1"'), false);
  assert.equal(matchesETag('"v2", "v1"', '"v1"'), true);
  assert.equal(matchesETag('"v2", *', '"v1"'), true);
  assert.equal(matchesETag('W/"v1"', '"v1"'), false);
  assert.equal(matchesETag('"v10"', '"v1"'), false);
});
