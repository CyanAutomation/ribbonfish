import test from "node:test";
import assert from "node:assert/strict";
import { formatCaptureObservation, formatRunTime } from "../public/admin/capture-presentation.ts";

test("formats capture duration with rounding and a nonnegative fallback", () => {
  assert.equal(formatRunTime(90_000), "1m 30s");
  assert.equal(formatRunTime(-1_000), "0m 0s");
  assert.equal(formatRunTime(undefined), "0m 0s");
});

test("describes each capture observation without implying an unverified screenshot", () => {
  assert.equal(formatCaptureObservation({ observed_result: "changed", observed_delay_ms: 1200 }), "The scheduled screenshot changed content. 0m 1s after due time.");
  assert.equal(formatCaptureObservation({ observed_result: "unchanged" }), "The scheduled screenshot matched the previous image.");
  assert.match(formatCaptureObservation({ observed_result: "validator_unchanged" }), /no screenshot was taken/);
  assert.match(formatCaptureObservation({ observed_result: "failed" }), /failed/);
  assert.match(formatCaptureObservation({ observed_result: "budget_deferred" }), /no content result/);
  assert.match(formatCaptureObservation({}), /has not been recorded/);
});
