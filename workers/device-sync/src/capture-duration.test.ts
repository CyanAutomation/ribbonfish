import test from "node:test";
import assert from "node:assert/strict";
import { summarizeCaptureDurations } from "./capture-duration.ts";

test("capture duration summary separates measured samples from reserve estimates", () => {
  const samples = [
    ...Array.from({ length: 20 }, (_, index) => ({
      browser_ms: (index + 1) * 1000,
      browser_ms_source: "response_header",
      reserve_ms: 60_000,
      attempt: index === 1 ? 2 : 1,
      outcome: index === 0 ? "failed" : "succeeded",
    })),
    ...Array.from({ length: 3 }, (_, index) => ({ browser_ms: 60_000, browser_ms_source: "reserve", reserve_ms: 60_000,
      attempt: index === 1 ? 2 : 1, outcome: index === 0 ? "failed" : "succeeded" })),
    ...Array.from({ length: 2 }, () => ({ browser_ms: 0, browser_ms_source: "unknown", reserve_ms: 60_000 })),
  ];

  assert.deepEqual(summarizeCaptureDurations(samples, 60_000), {
    total_samples: 25,
    measured_sample_count: 20,
    reserve_estimated_sample_count: 3,
    unknown_sample_count: 2,
    failed_attempt_count: 2,
    retry_attempt_count: 2,
    capture_attempt_failure_rate: 0.08,
    retry_attempt_rate: 0.08,
    measured_header_coverage: 0.8,
    measured_p50_ms: 10_500,
    measured_p90_ms: 18_000,
    measured_average_ms: 10_500,
    reserve_estimated_total_ms: 180_000,
    configured_reserve_ms: 60_000,
    reserve_review: "possible_overestimate",
  });
});

test("reserve-estimated and unknown samples cannot create a conservative-runtime signal", () => {
  const samples = [
    ...Array.from({ length: 19 }, () => ({ browser_ms: 1000, browser_ms_source: "response_header", reserve_ms: 60_000 })),
    ...Array.from({ length: 20 }, () => ({ browser_ms: 60_000, browser_ms_source: "reserve", reserve_ms: 60_000 })),
  ];
  assert.equal(summarizeCaptureDurations(samples, 60_000).reserve_review, "insufficient_data");
});

test("potential-overestimate flag requires measured coverage as well as a low measured p90", () => {
  const samples = [
    ...Array.from({ length: 20 }, () => ({ browser_ms: 1000, browser_ms_source: "response_header", reserve_ms: 60_000 })),
    ...Array.from({ length: 6 }, () => ({ browser_ms: 60_000, browser_ms_source: "reserve", reserve_ms: 60_000 })),
  ];
  assert.equal(summarizeCaptureDurations(samples, 60_000).measured_header_coverage, 20 / 26);
  assert.equal(summarizeCaptureDurations(samples, 60_000).reserve_review, "insufficient_data");
});

test("reserve review distinguishes possible underestimates from in-range measurements", () => {
  const measured = (duration: number) => Array.from({ length: 20 }, () => ({
    browser_ms: duration, browser_ms_source: "response_header", reserve_ms: 60_000,
  }));
  assert.equal(summarizeCaptureDurations(measured(60_001), 60_000).reserve_review, "possible_underestimate");
  assert.equal(summarizeCaptureDurations(measured(30_001), 60_000).reserve_review, "not_flagged");
  assert.equal(summarizeCaptureDurations(measured(30_000), 60_000).reserve_review, "possible_overestimate");
});
