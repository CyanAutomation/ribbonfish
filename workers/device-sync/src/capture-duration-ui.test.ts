import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderCaptureEfficiencyModule } from "../public/admin/capture-efficiency-module.ts";

test("Capture Efficiency keeps per-site timing details in a collapsed table and explains its labels", () => {
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
      reserve_review: "possible_overestimate",
    },
  }], {
    daily_usage: { accounted_ms: 10_000, budget_ms: 600_000, free_plan_limit_ms: 600_000 },
    last_30_days: {
      successful_screenshots: 8,
      validator_unchanged: 2,
      successful_unclassified: 1,
      browser_run_ms: { response_header: 480_000, reserve: 120_000, unclassified_jobs: 3 },
      jev_shadow_assessments: 4,
      jev_candidate_deferrals: 3,
      jev_candidate_changed: 1,
      jev_candidate_unchanged: 1,
      jev_candidate_validator_unchanged: 1,
      jev_candidate_budget_deferred: 0,
      jev_candidate_failed: 0,
      jev_candidate_unobserved: 0,
    },
  });

  const advanced = container.querySelector("details.capture-efficiency-advanced");
  assert.ok(advanced);
  assert.equal(advanced.open, false, "advanced diagnostics start collapsed");
  assert.equal(advanced.querySelector("summary")?.textContent, "Advanced details");
  assert.match(container.querySelector(".capture-efficiency-summary")?.textContent ?? "", /10s of 10m 0s Browser Run minutes used today/);
  assert.match(container.querySelector(".browser-usage-budget-note")?.textContent ?? "", /forecast to stay within the.*daily budget/i);

  const durationTable = advanced.querySelector("[data-table='per-site-duration']");
  assert.ok(durationTable);
  assert.deepEqual([...durationTable.querySelectorAll("thead th")].map((cell) => cell.textContent), [
    "Site", "Measured samples", "p50 / p90", "Measured header coverage", "Reserve-estimated samples / time",
    "Unknown / failed / retries", "Readiness", "Reserve review",
  ]);
  assert.equal(durationTable.closest(".capture-efficiency-table-scroll")?.tabIndex, 0,
    "the horizontally scrollable details table can be reached by keyboard");
  assert.match(durationTable.textContent, /20/);
  assert.match(durationTable.textContent, /0m 18s/);
  assert.match(durationTable.textContent, /80%/);
  assert.match(durationTable.textContent, /3.*3m 0s/);
  assert.match(durationTable.textContent, /1.*failed.*2.*retr/i);
  assert.match(durationTable.textContent, /CSS selector/);
  assert.match(durationTable.textContent, /Possible reserve overestimate/);

  assert.match(advanced.textContent, /Measured runtime comes from Browser Run response headers/);
  assert.match(advanced.textContent, /reserve-estimated runtime uses the configured fallback/i);
  assert.match(advanced.textContent, /HTTP validator.*ETag or Last-Modified/i);
  assert.match(advanced.textContent, /p50 is the median; p90 is a duration/i);
  assert.match(advanced.textContent, /JEV \(screenshot skip advice\) is an advisory/i);
  const recentTable = advanced.querySelector("[data-table='capture-outcomes']");
  assert.ok(recentTable);
  assert.match(recentTable.textContent, /Unchanged HTTP-validator checks.*2 checks/i);
  assert.match(recentTable.textContent, /8m 0s/);
  assert.match(recentTable.textContent, /2m 0s/);
  assert.match(recentTable.textContent, /JEV advisory assessments4 assessments/);
  assert.match(recentTable.textContent, /JEV suggestions with changed screenshots1 screenshot/);
  assert.match(advanced.querySelector("[data-table='schedule-estimates']")?.textContent ?? "", /1 hour.*24\.0.*4m 12s per day/);
});

test("Capture Efficiency flags a possible reserve underestimate separately", () => {
  const dom = new JSDOM("<section id='capture-efficiency'></section>");
  const container = dom.window.document.querySelector("#capture-efficiency");
  assert.ok(container);
  renderCaptureEfficiencyModule(container, [{
    capture_id: "site-1", display_url: "https://status.example.com/", duration_summary: {
      total_samples: 20, measured_sample_count: 20, reserve_estimated_sample_count: 0,
      unknown_sample_count: 0, failed_attempt_count: 0, retry_attempt_count: 0,
      capture_attempt_failure_rate: 0, retry_attempt_rate: 0, measured_header_coverage: 1,
      measured_p50_ms: 62_000, measured_p90_ms: 65_000, measured_average_ms: 62_000,
      reserve_estimated_total_ms: 0, configured_reserve_ms: 60_000,
      reserve_review: "possible_underestimate",
    },
  }], { daily_usage: {}, last_30_days: {} });
  assert.match(container.textContent ?? "", /Possible reserve underestimate/);
  assert.match(container.textContent ?? "", /review the accounting reserve/i);
});
