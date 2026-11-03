import test from "node:test";
import assert from "node:assert/strict";
import { HTTPError } from "./http-error.ts";

test("HTTPError preserves the status and message for response handling", () => {
  const error = new HTTPError(403, "access denied");
  assert.ok(error instanceof Error);
  assert.ok(error instanceof HTTPError);
  assert.equal(error.status, 403);
  assert.equal(error.message, "access denied");
});
