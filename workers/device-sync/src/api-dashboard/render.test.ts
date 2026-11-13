import assert from "node:assert/strict";
import { test } from "node:test";
import { dashboardSVG, renderDashboardPNG } from "./render.ts";
import { svgCheckHistory, svgEventPanel, svgFreshnessBadge, svgGroupSummary, svgHealthLegend, svgHealthOverview, svgPanel, svgServiceRow, svgStatusBadge, svgStatusDot, svgText, truncateText } from "./render-components.ts";
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

test("small source sets use full-height cards and identify the Kuma instance and update time", () => {
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
  assert.ok(Number(cards[0][4]) > 700, "source cards should use the available vertical screen space");
  assert.match(svg, /monitor-west\.example\.org/);
  assert.match(svg, /monitor-east\.example\.org/);
  assert.match(svg, /Checked 12:34 UTC/);
});

test("dense 720p layouts keep cards readable and center the final partial row", () => {
  const sources = Array.from({ length: 7 }, (_, index) => ({ ...sample, id: `source-${index}`, displayName: `Operations source ${index + 1}` }));
  const svg = dashboardSVG(sources, 1280, 720);
  const cards = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="[\d.]+" fill="#142238" stroke="#344a66"/g)];
  assert.equal(cards.length, 7);
  assert.ok(Number(cards[0][4]) > 170, "three-card rows should receive enough height for readable service details");
  assert.notEqual(cards[0][1], cards[1][1]);
  assert.notEqual(cards[1][1], cards[2][1]);
  assert.equal(cards[6][1], cards[1][1], "the single card on the last row should be centered");
  assert.notEqual(cards[6][2], cards[1][2]);
});

test("source health badges do not squeeze longer card titles", () => {
  const sources = Array.from({ length: 4 }, (_, index) => ({ ...sample, id: `source-${index}`, displayName: "North America services" }));
  const svg = dashboardSVG(sources);
  assert.match(svg, />North America services<\/text>/);
  assert.match(svg, />Services: Unknown<\/text>/);
});

test("shared SVG primitives escape text and render status panels, dots, and badges", () => {
  assert.equal(svgText("<service & 'status'>"), "&lt;service &amp; &apos;status&apos;&gt;");
  assert.equal(truncateText("long-name", 6), "lon...");
  assert.match(svgPanel(1, 2, 30, 40, 1, "#20c997"), /stroke="#344a66"/);
  assert.match(svgStatusDot(4, 5, 6, "#ff647c"), /<circle cx="4" cy="5" r="6" fill="#ff647c"\/>/);
  assert.match(svgStatusBadge(0, 0, 200, 50, 1, "Down", "#ff647c"), />Down<\/text>/);
  assert.match(svgHealthOverview(10, 20, 1000, 1, [{ label: "Operational", count: 2, color: "#20c997" }, { label: "Down", count: 1, color: "#ff647c" }]), />2 Operational<\/text>/);
  assert.match(svgHealthOverview(10, 20, 1000, 1, [{ label: '<img onerror="x">', count: 1, color: "#20c997" }]), /&lt;img onerror=&quot;x&quot;&gt;/);
  assert.match(svgServiceRow({ x: 10, y: 30, right: 600, scale: 1, name: "API <edge>", status: "Down", color: "#ff647c" }), /API &lt;edge&gt;/);
  assert.match(svgGroupSummary({ x: 10, y: 30, right: 600, scale: 1, label: "operational", count: 2, history: ["operational", "unknown"] }), />2 services operational<\/text>/);
  assert.equal((svgCheckHistory({ x: 0, y: 0, width: 100, height: 8, states: ["operational", "down"] }).match(/<rect /g) ?? []).length, 2);
  assert.doesNotMatch(svgServiceRow({ x: 10, y: 30, right: 600, scale: 1, name: "API", status: "Operational", color: "#20c997" }), /120 ms/);
});

test("health legend names every state so color is never the only status cue", () => {
  const legend = svgHealthLegend(12, 24, 1000, 1);
  for (const state of ["Operational", "Degraded", "Down", "Maintenance", "Pending", "Unknown", "Stale"]) {
    assert.match(legend, new RegExp(state));
  }
  assert.match(legend, /Status key/);
});

test("history strip explains its time direction and each sampled status", () => {
  const history = svgCheckHistory({ x: 10, y: 20, width: 144, height: 10, states: ["operational", "down"] });
  assert.match(history, /24 hours ago/);
  assert.match(history, /now/i);
  assert.match(history, /Operational/);
  assert.match(history, /Down/);
});

test("dashboard includes a visible status key and gives history strips a now label", () => {
  const historical: DashboardSource = {
    ...sample,
    fetchedAt: "2026-01-02T03:05:00.000Z",
    components: [{ ...sample.components[0], status: "operational", history: [
      { at: "2026-01-01T04:00:00.000Z", status: "down" },
      { at: "2026-01-02T03:04:00.000Z", status: "operational" },
    ] }],
  };
  const svg = dashboardSVG([historical]);
  assert.match(svg, /Status key/);
  assert.match(svg, />Now</);
  assert.match(svg, /24 hours ago/);
});

test("large healthy Uptime Kuma groups show representative monitors and summarize the remainder", () => {
  const healthy: DashboardSource = {
    ...sample,
    groups: [{ id: "g", name: "Primary group", order: 0 }],
    components: Array.from({ length: 32 }, (_, index) => ({ ...sample.components[0], id: String(index), name: `Service ${index}`, latencyMs: 99 })),
  };
  const svg = dashboardSVG([healthy]);
  assert.match(svg, /Primary group/);
  assert.match(svg, /16 services operational/);
  assert.match(svg, /Service 0/);
  assert.match(svg, /Service 15/);
  assert.doesNotMatch(svg, /Service 16/);
  assert.match(svg, /99 ms/);
});

test("large-group history includes checks from both visible and overflow monitors", () => {
  const grouped: DashboardSource = {
    ...sample,
    groups: [{ id: "g", name: "Primary group", order: 0 }],
    components: Array.from({ length: 32 }, (_, index) => ({
      ...sample.components[0],
      id: String(index),
      name: `Service ${index}`,
      history: [{
        at: index === 0 ? "2025-12-31T23:00:00.000Z" : "2025-12-31T23:10:00.000Z",
        status: index === 0 ? "down" as const : "operational" as const,
      }],
    })),
  };
  const svg = dashboardSVG([grouped]);
  assert.match(svg, /Recent checks from 24 hours ago to now:[^\"]*Down/);
});

test("small Uptime Kuma groups list monitor names, state, and response time", () => {
  const smallGroup: DashboardSource = {
    ...sample,
    groups: [{ id: "g", name: "West Europe", order: 0 }],
    components: [
      { ...sample.components[0], id: "web", name: "Public web", latencyMs: 84, sampledAt: "2026-01-01T12:30:00.000Z" },
      { ...sample.components[0], id: "api", name: "API", latencyMs: 121, sampledAt: "2026-01-01T12:30:00.000Z" },
    ],
  };
  const svg = dashboardSVG([smallGroup]);
  assert.match(svg, /Public web/);
  assert.match(svg, /API/);
  assert.match(svg, /Operational/);
  assert.match(svg, /84 ms/);
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
  assert.match(svg, /<title>Recent checks from 24 hours ago to now:/);
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
  assert.match(svg, /87 ms/);
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
  const descriptionY = Number(svg.match(/<text x="[^"]+" y="([\d.]+)"[^>]*>Statuspage: Status source unavailable<\/text>/)?.[1]);
  const errorY = Number(svg.match(/<text x="[^"]+" y="([\d.]+)"[^>]*>Status API request failed\.<\/text>/)?.[1]);
  assert.ok(errorY > descriptionY, "source errors should sit below the source details");
});

test("Statuspage incidents and scheduled maintenance use a prominent event panel", () => {
  const source: DashboardSource = {
    ...sample,
    provider: "atlassian-statuspage",
    fetchedAt: "2026-01-02T03:00:00.000Z",
    incidents: [{ id: "incident", name: "Elevated error rate", status: "investigating", impact: "major", updatedAt: null }],
    maintenance: [{ id: "maintenance", name: "Sample flight-planning service v4.2.0 update", status: "scheduled", impact: "maintenance", updatedAt: "2026-01-02T03:00:00.000Z", scheduledFor: "2026-01-02T05:00:00.000Z" }],
  };
  const svg = dashboardSVG([source]);
  assert.match(svg, /fill="#202d40"/);
  assert.match(svg, /INCIDENT/);
  assert.match(svg, /MAINTENANCE/);
  assert.match(svg, /Elevated error rate/);
  assert.match(svg, /Sample flight-planning service v4\.2\.0 update/);
  assert.match(svg, /Starts 2026-01-02 05:00 UTC/);
  assert.match(svg, /in 2 hours/);
  assert.match(svg, /Updated 03:00 UTC/);
});

test("healthy Statuspage groups show service names when they fit", () => {
  const source: DashboardSource = {
    ...sample,
    provider: "atlassian-statuspage",
    groups: [{ id: "flight", name: "Flight services", order: 0 }],
    components: [
      { ...sample.components[0], id: "group-flight", name: "Flight services", isGroup: true, groupId: null, groupName: null },
      { ...sample.components[0], id: "check-in", name: "Online check-in", status: "operational", groupId: "group-flight", groupName: "Flight services" },
      { ...sample.components[0], id: "booking", name: "Booking", status: "operational", groupId: "group-flight", groupName: "Flight services" },
    ],
  };
  const svg = dashboardSVG([source]);
  assert.match(svg, /Online check-in/);
  assert.match(svg, />Operational<\/text>/);
  assert.match(svg, /Booking/);
});

test("Statuspage keeps affected services first and summarizes healthy overflow", () => {
  const source: DashboardSource = {
    ...sample,
    provider: "atlassian-statuspage",
    groups: [{ id: "platform", name: "Platform", order: 0 }],
    components: [
      { ...sample.components[0], id: "platform", name: "Platform", isGroup: true, groupId: null, groupName: null },
      ...Array.from({ length: 10 }, (_, index) => ({ ...sample.components[0], id: `service-${index}`, name: `Service ${index + 1}`, status: index === 8 ? "down" as const : "operational" as const, componentOrder: index + 1, groupId: "platform", groupName: "Platform" })),
    ],
  };
  const svg = dashboardSVG([source]);
  assert.ok(svg.indexOf("Service 9") < svg.indexOf("Service 1"), "the affected component should appear first");
  assert.match(svg, />2 services operational<\/text>/);
  assert.match(svg, /Service 7/);
  assert.doesNotMatch(svg, /Service 8/);
  assert.doesNotMatch(svg, /Service 10/);
});

test("header emphasizes live service counts while retaining the full status key", () => {
  const source: DashboardSource = {
    ...sample,
    provider: "atlassian-statuspage",
    components: [
      { ...sample.components[0], id: "a", name: "API", status: "operational" },
      { ...sample.components[0], id: "b", name: "Web", status: "down" },
    ],
  };
  const svg = dashboardSVG([source]);
  assert.match(svg, />1 Operational<\/text>/);
  assert.match(svg, />1 Down<\/text>/);
  assert.match(svg, /Status key/);
});

test("shared event panel escapes names and gives scheduled time a separate visual line", () => {
  const panel = svgEventPanel({ x: 0, y: 0, width: 800, height: 72, scale: 1, events: [
    { kind: "Maintenance", name: "Sample <service upgrade>", status: "scheduled", color: "#a78bfa", scheduledFor: "2026-01-02T05:00:00.000Z", referenceAt: "2026-01-02T03:00:00.000Z" },
  ] });
  assert.match(panel, /MAINTENANCE/);
  assert.match(panel, /Sample &lt;service upgrade&gt;/);
  assert.match(panel, /Starts 2026-01-02 05:00 UTC/);
  assert.match(panel, /in 2 hours/);
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
