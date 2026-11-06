import assert from "node:assert/strict";
import { test } from "node:test";
import { dashboardSVG, renderDashboardPNG } from "./render.ts";
import { svgPanel, svgServiceRow, svgStatusBadge, svgStatusDot, svgText, truncateText } from "./render-components.ts";
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
  const svg = dashboardSVG([longName, ...Array.from({ length: 6 }, (_, index) => ({ ...sample, id: `source-${index + 2}` }))]);
  assert.match(svg, /\.\.\./);
  assert.doesNotMatch(svg, /…/);
});

test("small source sets use wide cards and identify the Kuma instance and update time", () => {
  const kuma: DashboardSource = {
    ...sample,
    displayName: "Operations status",
    hostname: "monitor-west.example.org",
    fetchedAt: "2026-01-01T12:34:00.000Z",
  };
  const svg = dashboardSVG([kuma, { ...kuma, id: "source-2", displayName: "Operations status", hostname: "monitor-east.example.org" }]);
  const cards = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="[\d.]+" fill="#142238" stroke="#344a66"/g)];
  assert.equal(cards.length, 2);
  assert.ok(Number(cards[0][3]) > 800, "two sources should use wide cards on a 1920px canvas");
  assert.match(svg, /monitor-west\.example\.org/);
  assert.match(svg, /monitor-east\.example\.org/);
  assert.match(svg, /Fetched 12:34 UTC/);
});

test("shared SVG primitives escape text and render status panels, dots, and badges", () => {
  assert.equal(svgText("<service & 'status'>"), "&lt;service &amp; &apos;status&apos;&gt;");
  assert.equal(truncateText("long-name", 6), "lon...");
  assert.match(svgPanel(1, 2, 30, 40, 1, "#20c997"), /stroke="#344a66"/);
  assert.match(svgStatusDot(4, 5, 6, "#ff647c"), /<circle cx="4" cy="5" r="6" fill="#ff647c"\/>/);
  assert.match(svgStatusBadge(0, 0, 200, 50, 1, "Down", "#ff647c"), />Down<\/text>/);
  assert.match(svgServiceRow({ x: 10, y: 30, right: 600, scale: 1, name: "API <edge>", status: "Down", color: "#ff647c", latencyMs: 120 }), /API &lt;edge&gt;/);
});

test("SVG color attributes escape caller-provided values", () => {
  const hostileColor = '#fff" onload="alert(1)';
  const fragments = [
    svgStatusDot(0, 0, 2, hostileColor),
    svgPanel(0, 0, 10, 10, 1, hostileColor),
    svgStatusBadge(0, 0, 80, 30, 1, "Status", hostileColor),
    svgServiceRow({ x: 0, y: 12, right: 200, scale: 1, name: "Service", status: "Up", color: hostileColor }),
  ];
  for (const fragment of fragments) {
    assert.doesNotMatch(fragment, /onload="|<script\b/i);
    assert.match(fragment, /&quot; onload=&quot;/);
  }
});

test("affected services appear before operational services within a group", () => {
  const mixed: DashboardSource = {
    ...sample,
    components: [
      { ...sample.components[0], id: "healthy", name: "Healthy service", status: "operational", componentOrder: 0 },
      { ...sample.components[0], id: "failed", name: "Failed service", status: "down", componentOrder: 1 },
    ],
  };
  const svg = dashboardSVG([mixed]);
  assert.ok(svg.indexOf("Failed service") < svg.indexOf("Healthy service"));
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
