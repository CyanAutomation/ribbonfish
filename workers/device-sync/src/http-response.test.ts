import test from "node:test";
import assert from "node:assert/strict";
import { jsonResponse, privateHeaders } from "./http-response.ts";

// Management API responses are private and JSON-typed: ../README.md#management-api.
test("private headers preserve supplied headers and enforce privacy and nosniff", () => {
  const headers = privateHeaders({ ETag: '"v1"', "Cache-Control": "public" });
  assert.equal(headers.get("ETag"), '"v1"');
  assert.equal(headers.get("Cache-Control"), "private, no-store, no-transform");
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
});

test("JSON responses preserve explicit status and headers and default omitted status to 200", async () => {
  const response = jsonResponse({ ok: true }, 201, { ETag: '"v1"' });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("Cache-Control"), "private, no-store, no-transform");
  assert.equal(response.headers.get("ETag"), '"v1"');
  assert.deepEqual(await response.json(), { ok: true });
  const defaultResponse = jsonResponse({ ok: true });
  assert.equal(defaultResponse.status, 200);
  assert.deepEqual(await defaultResponse.json(), { ok: true });
});
