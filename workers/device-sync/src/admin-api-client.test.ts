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

test("admin API does not permit callers to override the no-store policy", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let cache: RequestInit["cache"];
  globalThis.fetch = async (_input, init) => {
    cache = init?.cache;
    return Response.json({});
  };
  await api("/admin/api/overview", { cache: "force-cache" });
  assert.equal(cache, "no-store");
});

test("admin API reports server errors and falls back for invalid JSON", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({ error: "Denied" }, { status: 403 });
  await assert.rejects(api("/admin/api/overview"), { message: "Denied" });
  globalThis.fetch = async () => new Response("not JSON", { status: 500 });
  await assert.rejects(api("/admin/api/overview"), { message: "Something went wrong. Please try again." });
});
