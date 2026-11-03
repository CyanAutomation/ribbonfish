import assert from "node:assert/strict";
import test from "node:test";
import { api } from "../public/admin/api.ts";

test("admin API sends no-store requests and returns the decoded response", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let received: { input: string | URL | Request; init?: RequestInit } | undefined;
  globalThis.fetch = async (input, init) => {
    received = { input, init };
    return Response.json({ id: "playlist" });
  };
  assert.deepEqual(await api("/admin/api/overview", { method: "POST" }), { id: "playlist" });
  assert.deepEqual(received, { input: "/admin/api/overview", init: { cache: "no-store", method: "POST" } });
});

test("admin API reports server errors and falls back for invalid JSON", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({ error: "Denied" }, { status: 403 });
  await assert.rejects(api("/admin/api/overview"), { message: "Denied" });
  globalThis.fetch = async () => new Response("not JSON", { status: 500 });
  await assert.rejects(api("/admin/api/overview"), { message: "Something went wrong. Please try again." });
});
