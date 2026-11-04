import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderCaptureEfficiencyModule } from "../public/admin/capture-efficiency-module.ts";

test("Capture Efficiency shows source-separated duration samples and possible reserve overestimates", () => {
  const dom = new JSDOM("<section id='capture-efficiency'></section>");
  const container = dom.window.document.querySelector("#capture-efficiency");
  assert.ok(container);
  renderCaptureEfficiencyModule(container, [{
    capture_id: "site-1",
    display_url: "https://status.example.com/",
    capture_interval_seconds: 3600,
    wait_for_selector: "main",
    active_in_playlist: true,
    schedule_reviewed: true,
    average_browser_ms: 10_500,
    browser_ms_samples: 20,
    duration_summary: {
      total_samples: 25,
      measured_sample_count: 20,
      reserve_estimated_sample_count: 3,
      unknown_sample_count: 2,
      failed_attempt_count: 1,
      retry_attempt_count: 2,
      capture_attempt_failure_rate: 0.04,
      retry_attempt_rate: 0.08,
      measured_header_coverage: 0.8,
      measured_p50_ms: 10_500,
      measured_p90_ms: 18_000,
      measured_average_ms: 10_500,
      reserve_estimated_total_ms: 180_000,
      configured_reserve_ms: 60_000,
      conservative_review: "review",
    },
  }], {
    daily_usage: { accounted_ms: 10_000, budget_ms: 600_000, free_plan_limit_ms: 600_000 },
    last_30_days: {},
  });

  assert.match(container.textContent ?? "", /20 measured samples/);
  assert.match(container.textContent ?? "", /3 reserve-estimated/);
  assert.match(container.textContent ?? "", /p90 0m 18s/);
  assert.match(container.textContent ?? "", /Possible reserve overestimate/);
  assert.match(container.textContent ?? "", /1 failed capture attempt/);
  assert.match(container.textContent ?? "", /2 retry attempts/);
  assert.match(container.textContent ?? "", /readiness: selector gated/);
});
