import test from "node:test";
import assert from "node:assert/strict";
import { HTTPError } from "./http-error.ts";
import { readRequestBody, parseJSONBody } from "./request-body.ts";

test("reads a request body up to its byte limit", async () => {
  const request = new Request("https://example.test", { method: "POST", body: '{"ok":true}' });
  const bytes = await readRequestBody(request, 11);
  assert.deepEqual(parseJSONBody(bytes), { ok: true });
});

test("rejects missing, oversized and invalid bodies with client errors", async () => {
  const check = (status: number) => (error: unknown) => error instanceof HTTPError && error.status === status;
  await assert.rejects(readRequestBody(new Request("https://example.test"), 10), check(400));
  await assert.rejects(readRequestBody(new Request("https://example.test", { method: "POST", body: "12345" }), 4), check(413));
  assert.throws(() => parseJSONBody(new TextEncoder().encode("{")), check(400));
});
