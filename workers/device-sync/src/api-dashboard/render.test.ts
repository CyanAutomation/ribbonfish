import assert from "node:assert/strict";
import { test } from "node:test";
import { dashboardSVG, renderDashboardPNG } from "./render.ts";
import { svgCheckHistory, svgEventPanel, svgFreshnessBadge, svgGroupSummary, svgPanel, svgServiceRow, svgStatusBadge, svgStatusDot, svgText, truncateText } from "./render-components.ts";
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
  assert.match(svg, /2 configured sources · 2 active services · 1 disabled source/);
  assert.match(svg, /1 unknown/);
  assert.doesNotMatch(svg, /0 stale|0 pending/);
  assert.doesNotMatch(svg, /One or more sources unavailable or stale/);
});

test("overflow and active event footer labels occupy separate rows", () => {
  const crowded: DashboardSource = {
    ...sample,
    components: Array.from({ length: 100 }, (_, index) => ({ ...sample.components[0], id: String(index), name: `Component ${index}`, status: "down" })),
    incidents: [{ id: "incident-1", name: "Active incident", status: "investigating", impact: "major", updatedAt: null }],
  };
  const svg = dashboardSVG([crowded]);
  const overflowY = Number(svg.match(/<text x="[^"]+" y="([\d.]+)"[^>]*>\+ \d+ more services<\/text>/)?.[1]);
  const eventsY = Number(svg.match(/<text x="[^"]+" y="([\d.]+)"[^>]*>INCIDENT/)?.[1]);
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
  assert.ok(Number(cards[0][4]) < 300, "short status summaries should use compact card heights");
  assert.match(svg, /monitor-west\.example\.org/);
  assert.match(svg, /monitor-east\.example\.org/);
  assert.match(svg, /Checked 12:34 UTC/);
});

test("shared SVG primitives escape text and render status panels, dots, and badges", () => {
  assert.equal(svgText("<service & 'status'>"), "&lt;service &amp; &apos;status&apos;&gt;");
  assert.equal(truncateText("long-name", 6), "lon...");
  assert.match(svgPanel(1, 2, 30, 40, 1, "#20c997"), /stroke="#344a66"/);
  assert.match(svgStatusDot(4, 5, 6, "#ff647c"), /<circle cx="4" cy="5" r="6" fill="#ff647c"\/>/);
  assert.match(svgStatusBadge(0, 0, 200, 50, 1, "Down", "#ff647c"), />Down<\/text>/);
  assert.match(svgServiceRow({ x: 10, y: 30, right: 600, scale: 1, name: "API <edge>", status: "Down", color: "#ff647c" }), /API &lt;edge&gt;/);
  assert.match(svgGroupSummary({ x: 10, y: 30, right: 600, scale: 1, label: "operational", count: 2, history: ["operational", "unknown"] }), />2 services operational<\/text>/);
  assert.equal((svgCheckHistory({ x: 0, y: 0, width: 100, height: 8, states: ["operational", "down"] }).match(/<rect /g) ?? []).length, 2);
  assert.doesNotMatch(svgServiceRow({ x: 10, y: 30, right: 600, scale: 1, name: "API", status: "Operational", color: "#20c997" }), /120 ms/);
});

test("healthy services collapse into auditable group summaries and omit per-row latency", () => {
  const healthy: DashboardSource = {
    ...sample,
    groups: [{ id: "g", name: "Primary group", order: 0 }],
    components: Array.from({ length: 8 }, (_, index) => ({ ...sample.components[0], id: String(index), name: `Service ${index}`, latencyMs: 99 })),
  };
  const svg = dashboardSVG([healthy]);
  assert.match(svg, /Primary group/);
  assert.match(svg, /8 services operational/);
  assert.doesNotMatch(svg, /99 ms|Service 0/);
});

test("Kuma group summaries show a labelled 24-hour check strip when history is available", () => {
  const historical: DashboardSource = {
    ...sample,
    fetchedAt: "2026-01-02T03:05:00.000Z",
    components: [{ ...sample.components[0], status: "operational", history: [
      { at: "2026-01-01T04:00:00.000Z", status: "down" },
      { at: "2026-01-02T03:04:00.000Z", status: "operational" },
    ] }],
  };
  const svg = dashboardSVG([historical]);
  assert.match(svg, />24h<\/text>/);
  assert.match(svg, /<title>Recent checks<\/title>/);
  assert.match(svg, /#ff647c/);
});

test("affected service rows retain a last sample timestamp while healthy rows summarize", () => {
  const affected: DashboardSource = {
    ...sample,
    components: [
      { ...sample.components[0], id: "api", name: "Public API", status: "down", sampledAt: "2026-01-01T12:34:00.000Z", statusChangedAt: "2026-01-01T12:30:00.000Z" },
      { ...sample.components[0], id: "web", name: "Web", status: "operational" },
      { ...sample.components[0], id: "jobs", name: "Job runner", status: "unknown", sampledAt: "2026-01-01T12:31:00.000Z" },
    ],
  };
  const svg = dashboardSVG([affected]);
  assert.match(svg, /Public API/);
  assert.match(svg, /Down/);
  assert.match(svg, /Since 12:30 UTC/);
  assert.match(svg, /Checked 12:31 UTC/);
  assert.doesNotMatch(svg, /Down · Since 12:30 UTC · Checked/);
  assert.match(svg, /1 service operational/);
  assert.doesNotMatch(svg, /87 ms/);
});

test("source and event freshness labels distinguish updates from failed checks", () => {
  const source: DashboardSource = {
    ...sample,
    freshness: "stale",
    fetchedAt: "2026-01-01T12:34:00.000Z",
    incidents: [{ id: "incident", name: "API interruption", status: "investigating", impact: "major", updatedAt: "2026-01-01T12:20:00.000Z" }],
  };
  const svg = dashboardSVG([source]);
  assert.match(svg, /Checked 12:34 UTC/);
  assert.match(svg, /Updated 12:20 UTC/);
  assert.match(svg, /Services: Unknown/);
  assert.match(svg, /Data stale/);
});

test("Statuspage provider status and dashboard feed freshness have separate labels", () => {
  const source: DashboardSource = {
    ...sample,
    provider: "atlassian-statuspage",
    statusDescription: "All Systems Operational",
    status: "operational",
    freshness: "fresh",
    hostname: "status.example.com",
    fetchedAt: "2026-01-01T12:34:00.000Z",
    components: [{ ...sample.components[0], status: "operational" }],
  };
  const svg = dashboardSVG([source]);
  assert.match(svg, /Services: Operational/);
  assert.match(svg, /Data fresh/);
  assert.match(svg, /Checked 12:34 UTC/);
  assert.match(svg, /All Systems Operational/);
  assert.match(svg, /1 configured source · 1 active service · 1 service operational/);
});

test("unavailable feeds do not summarize old component data as operational", () => {
  const unavailable: DashboardSource = {
    ...sample,
    provider: "atlassian-statuspage",
    freshness: "unavailable",
    status: "stale",
    statusDescription: "Status source unavailable",
    hostname: "status.example.com",
    error: "Status API request failed.",
  };
  const svg = dashboardSVG([unavailable]);
  assert.match(svg, /1 stale or unavailable source/);
  assert.match(svg, /Feed unavailable/);
  assert.doesNotMatch(svg, /2 active services · 2 services operational/);
});

test("Statuspage incidents and scheduled maintenance use a prominent event panel", () => {
  const source: DashboardSource = {
    ...sample,
    provider: "atlassian-statuspage",
    incidents: [{ id: "incident", name: "Elevated error rate", status: "investigating", impact: "major", updatedAt: null }],
    maintenance: [{ id: "maintenance", name: "Database upgrade", status: "scheduled", impact: "maintenance", updatedAt: "2026-01-02T03:00:00.000Z", scheduledFor: "2026-01-02T05:00:00.000Z" }],
  };
  const svg = dashboardSVG([source]);
  assert.match(svg, /fill="#202d40"/);
  assert.match(svg, /INCIDENT/);
  assert.match(svg, /MAINTENANCE/);
  assert.match(svg, /Elevated error rate/);
  assert.match(svg, /Database upgrade/);
  assert.match(svg, /Starts 2026-01-02 05:00 UTC/);
  assert.match(svg, /Updated 03:00 UTC/);
});

test("shared event panel escapes names and gives scheduled time a separate visual line", () => {
  const panel = svgEventPanel({ x: 0, y: 0, width: 600, height: 72, scale: 1, events: [
    { kind: "Maintenance", name: "Database <upgrade>", status: "scheduled", color: "#a78bfa", scheduledFor: "2026-01-02T05:00:00.000Z" },
  ] });
  assert.match(panel, /MAINTENANCE/);
  assert.match(panel, /Database &lt;upgrade&gt;/);
  assert.match(panel, /Starts 2026-01-02 05:00 UTC/);
});

test("freshness badge is a reusable, labelled SVG primitive for every feed state", () => {
  assert.match(svgFreshnessBadge(10, 20, 1, "Data fresh", "#20c997"), /Data fresh/);
  assert.match(svgFreshnessBadge(10, 20, 1, "Feed unavailable", "#ff647c"), /#ff647c/);
  assert.doesNotMatch(svgFreshnessBadge(10, 20, 1, '<img onerror="x">', "#20c997"), /<img/);
});

test("SVG color attributes escape caller-provided values", () => {
  const hostileColor = '#fff" onload="alert(1)';
  const fragments = [
    svgStatusDot(0, 0, 2, hostileColor),
    svgPanel(0, 0, 10, 10, 1, hostileColor),
    svgStatusBadge(0, 0, 80, 30, 1, "Status", hostileColor),
    svgFreshnessBadge(0, 20, 1, "Data fresh", hostileColor),
    svgServiceRow({ x: 0, y: 12, right: 200, scale: 1, name: "Service", status: "Up", color: hostileColor }),
    svgEventPanel({ x: 0, y: 0, width: 240, height: 58, scale: 1, events: [{ kind: "Incident", name: "Service", status: "investigating", color: hostileColor }] }),
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
  assert.ok(svg.indexOf("Failed service") < svg.indexOf("1 service operational"));
});

test("overflow counts only omitted services and reports hidden incidents explicitly", () => {
  const crowded: DashboardSource = {
    ...sample,
    components: Array.from({ length: 100 }, (_, index) => ({ ...sample.components[0], id: String(index), name: `Component ${index}`, status: "down" })),
    incidents: Array.from({ length: 4 }, (_, index) => ({ id: `incident-${index}`, name: `Active incident ${index}`, status: "investigating", impact: "major", updatedAt: null })),
  };
  const svg = dashboardSVG([crowded]);
  assert.match(svg, /more services/);
  assert.match(svg, /\+1 more active events/);
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
