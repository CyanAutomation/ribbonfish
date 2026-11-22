import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  createFleetOverviewA2uiMessage,
  renderA2uiMessages,
  renderFleetOverviewA2ui,
} from "../public/admin/fleet-overview.ts";

test("fleet overview is represented as a single A2UI v1.0 surface with bound data", () => {
  const message = createFleetOverviewA2uiMessage({
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
    active_playlist: { playlist_id: "office", revision: "current" },
    capture_efficiency: { daily_usage: { accounted_ms: 90_000, budget_ms: 540_000 } },
  }, [{ request_id: "pending-1" }, { request_id: "pending-2" }]);

  assert.deepEqual(Object.keys(message).sort(), ["createSurface", "version"]);
  assert.equal(message.version, "1.0");
  assert.equal(message.createSurface.surfaceId, "fleetOverview");
  assert.equal(message.createSurface.catalogId, "https://ribbonfish.dev/a2ui/catalogs/fleet-overview-v1.json");
  assert.equal(message.createSurface.sendDataModel, false);
  assert.deepEqual(message.createSurface.dataModel.metrics, [
    { label: "Sites needing attention", value: "2", detail: "Review screenshot sites" },
    { label: "Devices offline or behind", value: "2", detail: "Check device health and playlist sync" },
    { label: "Pending approvals", value: "2", detail: "Verify device fingerprints" },
    { label: "Browser Run used today", value: "1m 30s / 9m 0s", detail: "Used / configured daily budget" },
  ]);
  assert.equal(message.createSurface.components.filter((component) => component.component === "Card").length, 4);
  assert.equal(message.createSurface.components.filter((component) => component.component === "Button").length, 0);
});

test("A2UI fleet surface renders the existing live metrics and fixed internal links", () => {
  const dom = new JSDOM("<div id='metrics'></div>");
  const container = dom.window.document.querySelector<HTMLElement>("#metrics");
  assert.ok(container);

  renderFleetOverviewA2ui(container, {
    capture_targets: [{ capture_type: "browser", schedule_reviewed: false }],
    devices: [{ enabled: 1, health: { status: "offline" } }],
    capture_efficiency: { daily_usage: { accounted_ms: 90_000, budget_ms: 540_000 } },
  }, [{ request_id: "pending-1" }]);

  const metrics = [...container.querySelectorAll<HTMLAnchorElement>("a.overview-metric")];
  assert.deepEqual(metrics.map((metric) => metric.getAttribute("href")), [
    "#sites-section", "#device-section", "#pending-enrollments-title", "#capture-efficiency-section",
  ]);
  assert.match(metrics[0].textContent ?? "", /Sites needing attention\s*1/);
  assert.match(metrics[1].textContent ?? "", /Devices offline or behind\s*1/);
  assert.match(metrics[2].textContent ?? "", /Pending approvals\s*1/);
  assert.match(metrics[3].textContent ?? "", /Browser Run used today\s*1m 30s \/ 9m 0s/);
  assert.match(container.querySelector(".fleet-summary-grid")?.className ?? "", /fleet-summary-grid/);
  dom.window.close();
});

test("fleet overview keeps honest empty and unavailable states through A2UI", () => {
  const dom = new JSDOM("<div id='metrics'></div>");
  const container = dom.window.document.querySelector<HTMLElement>("#metrics");
  assert.ok(container);

  renderFleetOverviewA2ui(container, {}, []);

  assert.match(container.textContent ?? "", /Sites needing attention\s*0/);
  assert.match(container.textContent ?? "", /Devices offline or behind\s*0/);
  assert.match(container.textContent ?? "", /Pending approvals\s*0/);
  assert.match(container.textContent ?? "", /Browser Run used today\s*Unavailable/);
  dom.window.close();
});

test("A2UI text is rendered as text and navigation targets cannot come from data", () => {
  const dom = new JSDOM("<div id='metrics'><p>previous</p></div>");
  const container = dom.window.document.querySelector<HTMLElement>("#metrics");
  assert.ok(container);
  const message = createFleetOverviewA2uiMessage({}, []);
  message.createSurface.dataModel.metrics[0].label = "<img src=x onerror=alert(1)>";
  message.createSurface.dataModel.metrics[0].href = "javascript:alert(1)";

  renderA2uiMessages(container, [message]);

  assert.equal(container.querySelector("img"), null);
  assert.match(container.textContent ?? "", /<img src=x onerror=alert\(1\)>/);
  const firstMetric = container.querySelector<HTMLAnchorElement>("a.overview-metric");
  assert.equal(firstMetric?.getAttribute("href"), "#sites-section");
  dom.window.close();
});

test("A2UI renderer rejects unknown components without replacing the current UI", () => {
  const dom = new JSDOM("<div id='metrics'><p>previous</p></div>");
  const container = dom.window.document.querySelector<HTMLElement>("#metrics");
  assert.ok(container);
  const message = structuredClone(createFleetOverviewA2uiMessage({}, []));
  const text = message.createSurface.components.find((component) => component.component === "Text");
  assert.ok(text);
  text.component = "Script";

  assert.throws(() => renderA2uiMessages(container, [message]), /unknown|unsupported|catalog|component/i);
  assert.equal(container.textContent, "previous");
  dom.window.close();
});

test("A2UI bounds reject malformed component entries before processing", () => {
  const dom = new JSDOM("<div id='metrics'><p>previous</p></div>");
  const container = dom.window.document.querySelector<HTMLElement>("#metrics");
  assert.ok(container);
  const message = createFleetOverviewA2uiMessage({}, []);
  const components = message.createSurface.components as unknown[];
  components[0] = { component: "Column", children: [] };

  assert.throws(
    () => renderA2uiMessages(container, [message]),
    /A2UI fleet overview contains an invalid component/,
  );
  assert.equal(container.textContent, "previous");
  dom.window.close();
});

test("A2UI renderer rejects component trees deeper than the safe limit", () => {
  const dom = new JSDOM("<div id='metrics'><p>previous</p></div>");
  const container = dom.window.document.querySelector<HTMLElement>("#metrics");
  assert.ok(container);
  const message = createFleetOverviewA2uiMessage({}, []);
  const nestedColumns = Array.from({ length: 11 }, (_, index) => ({
    id: `column${index + 1}`,
    component: "Column" as const,
    children: [index === 10 ? "leaf" : `column${index + 2}`],
  }));
  message.createSurface.components = [
    { id: "root", component: "Column", children: ["column1"] },
    ...nestedColumns,
    { id: "leaf", component: "Text", text: "leaf" },
  ];

  assert.throws(
    () => renderA2uiMessages(container, [message]),
    /A2UI fleet overview exceeds the supported component depth/,
  );
  assert.equal(container.textContent, "previous");
  dom.window.close();
});

test("A2UI fleet catalog rejects interactive components", () => {
  const dom = new JSDOM("<div id='metrics'><p>previous</p></div>");
  const container = dom.window.document.querySelector<HTMLElement>("#metrics");
  assert.ok(container);
  const message = structuredClone(createFleetOverviewA2uiMessage({}, []));
  const card = message.createSurface.components.find((component) => component.component === "Card");
  assert.ok(card);
  card.component = "Button";
  card.action = { event: { name: "disable_device", context: { device_id: "device-1" } } };

  assert.throws(() => renderA2uiMessages(container, [message]), /unknown|unsupported|catalog|component/i);
  assert.equal(container.textContent, "previous");
  dom.window.close();
});

test("A2UI renderer rejects extra messages and oversized data before replacing the current UI", () => {
  const dom = new JSDOM("<div id='metrics'><p>previous</p></div>");
  const container = dom.window.document.querySelector<HTMLElement>("#metrics");
  assert.ok(container);
  const message = createFleetOverviewA2uiMessage({}, []);

  assert.throws(() => renderA2uiMessages(container, [message, message]), /one v1.0 createSurface/);
  const oversizedMessage = structuredClone(message);
  oversizedMessage.createSurface.dataModel.padding = "x".repeat(16_384);
  assert.throws(() => renderA2uiMessages(container, [oversizedMessage]), /exceeds the supported size/);
  assert.equal(container.textContent, "previous");
  dom.window.close();
});

test("fleet overview does not count devices as behind without an active revision", () => {
  const dom = new JSDOM("<div id='metrics'></div>");
  const container = dom.window.document.querySelector<HTMLElement>("#metrics");
  assert.ok(container);

  renderFleetOverviewA2ui(container, {
    active_playlist: { playlist_id: "office" },
    devices: [{ enabled: 1, health: { status: "online", applied_playlist_id: "office", applied_revision: "current" } }],
  });

  assert.match(container.textContent ?? "", /Devices offline or behind\s*0/);
  dom.window.close();
});
