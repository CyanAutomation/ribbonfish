import test from "node:test";
import assert from "node:assert/strict";
import { formatCaptureObservation, formatJevCaptureOutcomeSummary, formatRunTime } from "../public/admin/capture-presentation.ts";

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

test("summarizes JEV deferral outcomes without merging distinct unverified states", () => {
  assert.equal(formatJevCaptureOutcomeSummary({
    jev_shadow_assessments: 46,
    jev_candidate_deferrals: 6,
    jev_candidate_changed: 1,
    jev_candidate_unchanged: 1,
    jev_candidate_validator_unchanged: 1,
    jev_candidate_budget_deferred: 1,
    jev_candidate_failed: 1,
    jev_candidate_unobserved: 1,
  }), "Scheduled JEV made 46 shadow assessments. Among 6 defer suggestions: 1 changed screenshot, 1 unchanged screenshot, 1 validator-only result, 1 budget deferral, 1 failed capture, 1 unobserved outcome. Schedules were unchanged.");
  assert.match(formatJevCaptureOutcomeSummary({}), /0 shadow assessments/);
});
