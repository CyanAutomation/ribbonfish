import test from "node:test";
import assert from "node:assert/strict";
import { jsonResponse, privateHeaders } from "./http-response.ts";

test("private headers preserve supplied headers and enforce privacy and nosniff", () => {
  const headers = privateHeaders({ ETag: '"v1"', "Cache-Control": "public" });
  assert.equal(headers.get("ETag"), '"v1"');
  assert.equal(headers.get("Cache-Control"), "private, no-store, no-transform");
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
});

test("JSON responses preserve status and additional headers", async () => {
  const response = jsonResponse({ ok: true }, 201, { ETag: '"v1"' });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("Cache-Control"), "private, no-store, no-transform");
  assert.equal(response.headers.get("ETag"), '"v1"');
  assert.deepEqual(await response.json(), { ok: true });
});

test("JSON responses default to status 200", () => {
  assert.equal(jsonResponse({}).status, 200);
});
