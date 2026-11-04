import test from "node:test";
import assert from "node:assert/strict";
import { calculateDailyCaptureForecast, type CaptureForecastTarget } from "./capture-forecast.ts";

function target(overrides: Partial<CaptureForecastTarget> = {}): CaptureForecastTarget {
  return {
    capture_id: "site-a",
    display_label: "Site A",
    capture_interval_seconds: 3600,
    active_in_playlist: true,
    schedule_reviewed: true,
    average_browser_ms: 2000,
    browser_ms_samples: 4,
    ...overrides,
  };
}

test("daily capture forecast multiplies active reviewed cadence by measured runtime", () => {
  const forecast = calculateDailyCaptureForecast([
    target(),
    target({
      capture_id: "site-b",
      display_label: "Site B",
      capture_interval_seconds: 6 * 60 * 60,
      average_browser_ms: 3000,
      browser_ms_samples: 2,
    }),
  ]);

  assert.equal(forecast.total_estimated_ms, 60_000);
  assert.equal(forecast.is_complete, true);
  assert.deepEqual(forecast.sites.map((site) => [site.capture_id, site.captures_per_day, site.estimated_browser_ms_per_day]), [
    ["site-a", 24, 48_000],
    ["site-b", 4, 12_000],
  ]);
});

test("changing one site's draft interval immediately changes its forecast", () => {
  const targets = [target()];
  const before = calculateDailyCaptureForecast(targets);
  const after = calculateDailyCaptureForecast(targets, new Map([["site-a", 6 * 60 * 60]]));

  assert.equal(before.total_estimated_ms, 48_000);
  assert.equal(after.total_estimated_ms, 8_000);
  assert.equal(after.sites[0].interval_seconds, 6 * 60 * 60);
});

test("inactive and unreviewed sites do not contribute to recurring daily forecast", () => {
  const forecast = calculateDailyCaptureForecast([
    target(),
    target({ capture_id: "staged", active_in_playlist: false }),
    target({ capture_id: "unreviewed", schedule_reviewed: false }),
  ]);

  assert.equal(forecast.total_estimated_ms, 48_000);
  assert.deepEqual(forecast.sites.map((site) => site.capture_id), ["site-a"]);
});

test("new sites use the active-site measured average and identify that estimate", () => {
  const forecast = calculateDailyCaptureForecast([
    target({ browser_ms_samples: 1, average_browser_ms: 1000 }),
    target({
      capture_id: "new-site",
      capture_interval_seconds: 6 * 60 * 60,
      average_browser_ms: null,
      browser_ms_samples: 0,
    }),
  ]);

  assert.equal(forecast.sites[1].average_browser_ms, 1000);
  assert.equal(forecast.sites[1].runtime_source, "fleet-history");
  assert.equal(forecast.total_estimated_ms, 28_000);
  assert.equal(forecast.is_complete, true);
});

test("forecast remains explicitly incomplete until any browser runtime has been observed", () => {
  const forecast = calculateDailyCaptureForecast([
    target({ average_browser_ms: null, browser_ms_samples: 0 }),
  ]);

  assert.equal(forecast.total_estimated_ms, null);
  assert.equal(forecast.is_complete, false);
  assert.equal(forecast.sites[0].estimated_browser_ms_per_day, null);
  assert.equal(forecast.sites[0].runtime_source, "unavailable");
});

test("forecast reports the Cloudflare Free allowance and app safety budget independently", () => {
  const forecast = calculateDailyCaptureForecast([target()], new Map(), {
    freePlanLimitMs: 600_000,
    workerBudgetMs: 540_000,
  });

  assert.equal(forecast.free_plan_limit_ms, 600_000);
  assert.equal(forecast.worker_budget_ms, 540_000);
  assert.equal(forecast.total_estimated_ms, 48_000);
});
