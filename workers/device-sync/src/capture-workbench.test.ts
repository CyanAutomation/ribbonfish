import test from "node:test";
import assert from "node:assert/strict";
import { summarizeCaptureHistory } from "./capture-workbench.ts";

test("capture history exposes bounded change markers without screenshot hashes", () => {
  const history = summarizeCaptureHistory([
    { captured_at: 500, sha256: "c" },
    { captured_at: 400, sha256: "b" },
    { captured_at: 300, sha256: "b" },
    { captured_at: 200, sha256: "a" },
  ]);

  assert.deepEqual(history, {
    recent_change_count: 2,
    unchanged_capture_streak: 0,
    recent_history: [
      { captured_at: 500, changed: true },
      { captured_at: 400, changed: false },
      { captured_at: 300, changed: true },
      { captured_at: 200, changed: null },
    ],
  });
  assert.equal(JSON.stringify(history).includes('"sha256"'), false);
});

test("capture history treats absent hashes as unknown and caps samples at ten", () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    captured_at: 1_000 - index,
    sha256: index < 2 ? null : "same",
  }));

  const history = summarizeCaptureHistory(rows);
  assert.equal(history.recent_history.length, 10);
  assert.equal(history.recent_history[0]?.changed, null);
  assert.equal(history.recent_history[1]?.changed, null);
  assert.equal(history.recent_change_count, 0);
  assert.equal(history.unchanged_capture_streak, 0, "a missing current hash cannot establish an unchanged streak");
});
