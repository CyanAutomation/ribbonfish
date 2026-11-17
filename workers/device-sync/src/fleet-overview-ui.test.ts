import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderFleetOverviewMetrics } from "../public/admin/fleet-overview.ts";

test("fleet overview metrics show live counts and link to their modules", () => {
  const dom = new JSDOM("<div id='metrics'></div>");
  const container = dom.window.document.querySelector<HTMLElement>("#metrics");
  assert.ok(container);

  renderFleetOverviewMetrics(container, {
    active_playlist: { playlist_id: "office", revision: "current" },
    capture_targets: [
      { capture_type: "browser", last_success_at: 10, schedule_reviewed: true },
      { capture_type: "browser", schedule_reviewed: false },
      { capture_type: "browser", last_error: "Timed out", schedule_reviewed: true, last_success_at: 5 },
      { capture_type: "api-dashboard", last_error: "Not a screenshot site" },
    ],
    devices: [
      { enabled: 1, health: { status: "offline" } },
      { enabled: 1, health: { status: "online", applied_playlist_id: "office", applied_revision: "old" } },
      { enabled: 0, health: { status: "offline" } },
      { enabled: 1, health: { status: "online", applied_playlist_id: "office", applied_revision: "current" } },
    ],
    capture_efficiency: { daily_usage: { accounted_ms: 90_000, budget_ms: 540_000 } },
  }, [{ request_id: "pending-1" }, { request_id: "pending-2" }]);

  const metrics = [...container.querySelectorAll<HTMLAnchorElement>("a.overview-metric")];
  assert.deepEqual(metrics.map((metric) => metric.getAttribute("href")), [
    "#sites-section", "#device-section", "#pending-enrollments-title", "#capture-efficiency-section",
  ]);
  assert.match(metrics[0].textContent ?? "", /Sites needing attention\s*2/);
  assert.match(metrics[1].textContent ?? "", /Devices offline or behind\s*2/);
  assert.match(metrics[2].textContent ?? "", /Pending approvals\s*2/);
  assert.match(metrics[3].textContent ?? "", /Browser Run used today\s*1m 30s \/ 9m 0s/);
});

test("fleet overview metrics keep honest empty and unavailable states", () => {
  const dom = new JSDOM("<div id='metrics'></div>");
  const container = dom.window.document.querySelector<HTMLElement>("#metrics");
  assert.ok(container);

  renderFleetOverviewMetrics(container, {}, []);

  assert.match(container.textContent ?? "", /Sites needing attention\s*0/);
  assert.match(container.textContent ?? "", /Devices offline or behind\s*0/);
  assert.match(container.textContent ?? "", /Pending approvals\s*0/);
  assert.match(container.textContent ?? "", /Browser Run used today\s*Unavailable/);
});

test("fleet overview does not count devices as behind when the active revision is missing", () => {
  const dom = new JSDOM("<div id='metrics'></div>");
  const container = dom.window.document.querySelector<HTMLElement>("#metrics");
  assert.ok(container);

  renderFleetOverviewMetrics(container, {
    active_playlist: { playlist_id: "office" },
    devices: [
      { enabled: 1, health: { status: "online", applied_playlist_id: "office", applied_revision: "current" } },
    ],
  });

  assert.match(container.textContent ?? "", /Devices offline or behind\s*0/);
});
