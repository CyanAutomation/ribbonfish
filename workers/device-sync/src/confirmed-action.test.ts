// @typecheck-node-test
import assert from "node:assert/strict";
import { test } from "node:test";
import { runConfirmedAction } from "../public/admin/confirmed-action.ts";

test("a confirmed action reports success without reloading dashboard data", async () => {
  const messages: Array<[string, boolean?, string?]> = [];
  let performed = false;
  await runConfirmedAction({
    confirmAndPerform: async () => { performed = true; return true; },
    successMessage: "Playlist activated",
    context: "playlist",
    showMessage: (...message) => messages.push(message),
  });

  assert.deepEqual(messages, [["Playlist activated Click Refresh data to load the latest status.", false, "playlist"]]);
  assert.equal(performed, true);
});

test("a declined action shows no result", async () => {
  const messages: Array<[string, boolean?, string?]> = [];
  await runConfirmedAction({
    confirmAndPerform: async () => false,
    successMessage: "Playlist activated",
    context: "playlist",
    showMessage: (...message) => messages.push(message),
  });

  assert.deepEqual(messages, []);
});

test("a failed action reports its error", async () => {
  const messages: Array<[string, boolean?, string?]> = [];
  await runConfirmedAction({
    confirmAndPerform: async () => { throw new Error("request failed"); },
    successMessage: "Playlist activated",
    context: "playlist",
    showMessage: (...message) => messages.push(message),
  });

  assert.deepEqual(messages, [["request failed", true, "playlist"]]);
});
