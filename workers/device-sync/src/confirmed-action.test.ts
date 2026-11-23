// @typecheck-node-test
import assert from "node:assert/strict";
import { test } from "node:test";
import { runConfirmedAction } from "../public/admin/confirmed-action.ts";

test("a confirmed action reports success and refreshes after it completes", async () => {
  const messages: Array<[string, boolean?, string?]> = [];
  let refreshed = false;
  await runConfirmedAction({
    confirmAndPerform: async () => true,
    successMessage: "Playlist activated",
    context: "playlist",
    showMessage: (...message) => messages.push(message),
    refresh: async () => { refreshed = true; },
  });

  assert.deepEqual(messages, [["Playlist activated", false, "playlist"]]);
  assert.equal(refreshed, true);
});

test("a declined action shows no result and does not refresh", async () => {
  const messages: Array<[string, boolean?, string?]> = [];
  let refreshed = false;
  await runConfirmedAction({
    confirmAndPerform: async () => false,
    successMessage: "Playlist activated",
    context: "playlist",
    showMessage: (...message) => messages.push(message),
    refresh: async () => { refreshed = true; },
  });

  assert.deepEqual(messages, []);
  assert.equal(refreshed, false);
});

test("a failed action reports its error and does not refresh", async () => {
  const messages: Array<[string, boolean?, string?]> = [];
  let refreshed = false;
  await runConfirmedAction({
    confirmAndPerform: async () => { throw new Error("request failed"); },
    successMessage: "Playlist activated",
    context: "playlist",
    showMessage: (...message) => messages.push(message),
    refresh: async () => { refreshed = true; },
  });

  assert.deepEqual(messages, [["request failed", true, "playlist"]]);
  assert.equal(refreshed, false);
});
