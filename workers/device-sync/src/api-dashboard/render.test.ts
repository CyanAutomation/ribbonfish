import assert from "node:assert/strict";
import { test } from "node:test";
import { dashboardSVG, renderDashboardPNG } from "./render.ts";
import type { DashboardSource } from "./model.ts";

const sample: DashboardSource = { id: "source-1", provider: "uptime-kuma", displayName: "<SCRIPT>alert('x')</SCRIPT>", fetchedAt: "2026-01-01T00:00:00.000Z", freshness: "fresh", status: "operational", statusDescription: "All systems operational", incidents: [], maintenance: [], components: [
  { id: "1", name: "A very long component name that cannot fit in a compact dashboard and must be shortened safely", status: "operational", latencyMs: 87, sampledAt: null, groupId: "g", groupName: "Primary group" },
  { id: "2", name: "Unknown service", status: "unknown", sampledAt: null, groupId: "g", groupName: "Primary group" },
] };

test("SVG text is escaped and dashboard output is deterministic", () => {
  const first = dashboardSVG([sample]);
  const second = dashboardSVG([{ ...sample, fetchedAt: "2026-01-02T00:00:00.000Z" }]);
  assert.equal(first, second);
  assert.match(first, /&lt;script&gt;/i);
  assert.doesNotMatch(first, /<script\b/i);
  assert.match(first, /Unknown service/);
});

test("disabled sources are labelled separately and do not make active sources stale", () => {
  const disabled: DashboardSource = { ...sample, disabled: true, freshness: "unavailable", status: "unknown", components: [] };
  const svg = dashboardSVG([sample, disabled]);
  assert.match(svg, />Disabled<\/text>/);
  assert.match(svg, /Source is disabled and not polled/);
  assert.doesNotMatch(svg, /One or more sources unavailable or stale/);
});

test("overflow and active event footer labels occupy separate rows", () => {
  const crowded: DashboardSource = {
    ...sample,
    components: Array.from({ length: 100 }, (_, index) => ({ ...sample.components[0], id: String(index), name: `Component ${index}` })),
    incidents: [{ id: "incident-1", name: "Active incident", status: "investigating", impact: "major", updatedAt: null }],
  };
  const svg = dashboardSVG([crowded]);
  const overflowY = Number(svg.match(/<text x="[^"]+" y="([\d.]+)"[^>]*>\+ \d+ more services<\/text>/)?.[1]);
  const eventsY = Number(svg.match(/<text x="[^"]+" y="([\d.]+)"[^>]*>Incident \(/)?.[1]);
  assert.ok(Number.isFinite(overflowY));
  assert.ok(Number.isFinite(eventsY));
  assert.ok(Math.abs(overflowY - eventsY) >= 18, `footer baselines are too close: ${overflowY} and ${eventsY}`);
});

test("provider group parents render as headings instead of duplicate monitored services", () => {
  const grouped: DashboardSource = {
    ...sample,
    provider: "atlassian-statuspage",
    components: [
      { id: "database-group", name: "Database", status: "degraded", sampledAt: null, groupId: null, groupName: null, isGroup: true, groupOrder: 0, componentOrder: 0 },
      { id: "database-primary", name: "Primary database", status: "degraded", sampledAt: null, groupId: "database-group", groupName: "Database", groupOrder: 0, componentOrder: 1 },
    ],
  };
  const svg = dashboardSVG([grouped]);
  assert.match(svg, />Database<\/text>/);
  assert.match(svg, />Primary database<\/text>/);
  assert.doesNotMatch(svg, /Database \(group\)/);
});

test("long text uses supported ASCII ellipses rather than missing font glyphs", () => {
  const longName = { ...sample, displayName: "Synthetic source name with an intentionally long label", components: [{ ...sample.components[0], name: "Synthetic service name with many details that must be shortened to fit the screen" }] };
  const svg = dashboardSVG([longName]);
  assert.match(svg, /\.\.\./);
  assert.doesNotMatch(svg, /…/);
});

test("overflow counts only omitted services and reports hidden incidents explicitly", () => {
  const crowded: DashboardSource = {
    ...sample,
    components: Array.from({ length: 100 }, (_, index) => ({ ...sample.components[0], id: String(index), name: `Component ${index}` })),
    incidents: Array.from({ length: 4 }, (_, index) => ({ id: `incident-${index}`, name: `Active incident ${index}`, status: "investigating", impact: "major", updatedAt: null })),
  };
  const svg = dashboardSVG([crowded]);
  assert.match(svg, /more services/);
  assert.match(svg, /\+3 more active events/);
});

test("renderer produces a valid dimensioned PNG and stable bytes", async () => {
  const first = await renderDashboardPNG([sample]);
  const second = await renderDashboardPNG([sample]);
  assert.equal(first[0], 137);
  assert.equal(String.fromCharCode(...first.slice(1, 4)), "PNG");
  assert.equal(new DataView(first.buffer, first.byteOffset).getUint32(16), 1920);
  assert.equal(new DataView(first.buffer, first.byteOffset).getUint32(20), 1080);
  assert.deepEqual(first, second);
  assert.ok(first.byteLength < 32 * 1024 * 1024);
});

test("renderer rejects overlarge and undersized workloads", async () => {
  assert.throws(() => dashboardSVG([], 5000, 1080));
  await assert.rejects(renderDashboardPNG([], 100, 100));
});
