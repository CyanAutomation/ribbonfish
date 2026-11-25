// @typecheck-node-test
import assert from "node:assert/strict";
import { test } from "node:test";
import { dashboardSVG, renderDashboardPNG } from "./render.ts";
import { svgCheckHistory, svgEventPanel, svgFreshnessBadge, svgGroupSummary, svgHealthOverview, svgMaintenanceAgenda, svgPanel, svgProviderIdentity, svgServiceRow, svgSourceNotice, svgStatusBadge, svgStatusDot, svgText, truncateText } from "./render-components.ts";
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
  assert.match(svg, /2 configured sources · 2 monitored services · 1 disabled source/);
  assert.match(svg, /1 Unknown/);
  assert.doesNotMatch(svg, /0 stale|0 pending/);
  assert.doesNotMatch(svg, /Monitoring data unavailable|Monitoring data delayed/);
});

test("dashboard layout ranks unhealthy sources first without reordering its input", () => {
  const healthy: DashboardSource = {
    ...sample,
    id: "healthy-source",
    displayName: "Healthy source",
    components: [{ ...sample.components[0], name: "Healthy component", status: "operational" }],
  };
  const down: DashboardSource = {
    ...sample,
    id: "down-source",
    displayName: "Down source",
    components: [{ ...sample.components[0], name: "Down component", status: "down" }],
  };
  const sources = [healthy, down];
  const originalSources = [...sources];

  const svg = dashboardSVG(sources);

  assert.ok(svg.indexOf("Down source") < svg.indexOf("Healthy source"));
  assert.deepEqual(sources, originalSources);
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

test("compact cards keep the source health label and omit full-card details", () => {
  const sources = Array.from({ length: 30 }, (_, index) => ({ ...sample, id: `source-${index}` }));
  const svg = dashboardSVG(sources, 3840, 2160);

  assert.match(svg, />Services: Unknown<\/text>/);
  assert.doesNotMatch(svg, /Data fresh/);
  assert.doesNotMatch(svg, /Checked 00:00 UTC/);
});

test("source health badges do not squeeze longer card titles", () => {
  const sources = Array.from({ length: 4 }, (_, index) => ({ ...sample, id: `source-${index}`, displayName: "North America services" }));
  const svg = dashboardSVG(sources);
  assert.match(svg, />North America services<\/text>/);
  assert.match(svg, />Services: Unknown<\/text>/);
});

test("narrow source cards put freshness on its own line so hostnames remain readable", () => {
  const sources = Array.from({ length: 4 }, (_, index) => ({
    ...sample,
    id: `source-${index}`,
    displayName: `Source ${index + 1}`,
    hostname: `monitor-${index + 1}.example.org`,
  }));
  const svg = dashboardSVG(sources);
  for (const source of sources) assert.match(svg, new RegExp(source.hostname!.replaceAll(".", "\\.")));
});

test("shared SVG primitives escape text and render status panels, dots, and badges", () => {
  assert.equal(svgText("<service & 'status'>"), "&lt;service &amp; &apos;status&apos;&gt;");
  assert.equal(truncateText("long-name", 6), "lon...");
  assert.match(svgPanel(1, 2, 30, 40, 1, "#20c997"), /stroke="#344a66"/);
  assert.match(svgSourceNotice({ x: 0, y: 0, width: 320, scale: 1, title: "Feed unavailable", detail: "HTTP 403 & blocked", color: "#ff647c", unavailable: true }), /HTTP 403 &amp; blocked/);
  assert.match(svgStatusDot(4, 5, 6, "#ff647c"), /<circle cx="4" cy="5" r="6" fill="#ff647c"\/>/);
  assert.match(svgStatusBadge(0, 0, 200, 50, 1, "Down", "#ff647c"), />Down<\/text>/);
  assert.match(svgHealthOverview(10, 20, 1000, 1, [{ label: "Operational", count: 2, color: "#20c997" }, { label: "Down", count: 1, color: "#ff647c" }]), />2 Operational<\/text>/);
  assert.match(svgHealthOverview(10, 20, 1000, 1, [{ label: '<img onerror="x">', count: 1, color: "#20c997" }]), /&lt;img onerror=&quot;x&quot;&gt;/);
  assert.match(svgProviderIdentity(10, 20, 1, "Uptime Kuma", "status.example.com"), /Uptime Kuma<\/tspan><tspan> \| status\.example\.com/);
  assert.doesNotMatch(svgProviderIdentity(10, 20, 1, "Uptime Kuma", "<SCRIPT>alert(1)</SCRIPT>"), /<\/?script\b/i);
  assert.match(svgServiceRow({ x: 10, y: 30, right: 600, scale: 1, name: "API <edge>", status: "Down", color: "#ff647c" }), /API &lt;edge&gt;/);
  const summary = svgGroupSummary({ x: 10, y: 30, right: 600, scale: 1, label: "operational", count: 2, history: ["operational", "down"] });
  assert.match(summary, />2 services operational<\/text>/);
  assert.match(summary, />24h<\/text>/);
  assert.match(summary, />Now<\/text>/);
  assert.equal((svgCheckHistory({ x: 0, y: 0, width: 100, height: 8, states: ["operational", "down"] }).match(/<rect /g) ?? []).length, 2);
  assert.doesNotMatch(svgServiceRow({ x: 10, y: 30, right: 600, scale: 1, name: "API", status: "Operational", color: "#20c997" }), /120 ms/);
});

test("healthy slide dashboards keep the overall takeaway, omit the status key, and retain history bars", () => {
  const historical: DashboardSource = {
    ...sample,
    fetchedAt: "2026-01-02T03:05:00.000Z",
    components: [{ ...sample.components[0], status: "operational", history: [
      { at: "2026-01-01T04:00:00.000Z", status: "down" },
      { at: "2026-01-02T03:04:00.000Z", status: "operational" },
    ] }],
  };
  const svg = dashboardSVG([historical]);
  assert.match(svg, />1\/1 Operational</);
  assert.match(svg, />24h<\/text>/);
  assert.match(svg, />Now<\/text>/);
  assert.match(svg, /24-hour history in 12 two-hour windows/);
  assert.doesNotMatch(svg, /Status key/);
});

test("large healthy Uptime Kuma groups list representative monitors and summarize the remainder without latency", () => {
  const healthy: DashboardSource = {
    ...sample,
    groups: [{ id: "g", name: "Primary group", order: 0 }],
    components: Array.from({ length: 32 }, (_, index) => ({ ...sample.components[0], id: String(index), name: `Service ${index}`, latencyMs: 99 })),
  };
  const svg = dashboardSVG([healthy]);
  assert.match(svg, /Primary group/);
  assert.match(svg, /Service 0/);
  assert.match(svg, /Service 15/);
  assert.match(svg, /16 services operational/);
  assert.doesNotMatch(svg, /Service 16|99 ms/);
  assert.match(svg, /<tspan fill="#f5f8fc" font-weight="700">Uptime Kuma<\/tspan><tspan> \|/);
});

test("Uptime Kuma history bars include checks from all monitors in a large group", () => {
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
  assert.match(svg, />24h<\/text>/);
  assert.match(svg, /24-hour history in 12 two-hour windows[^\"]*Down/);
});

test("small healthy Uptime Kuma groups list routine monitors without response time", () => {
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
  assert.match(svg, />API</);
  assert.equal([...svg.matchAll(/>Operational<\/text>/g)].length, 2);
  assert.doesNotMatch(svg, /84 ms|121 ms/);
});

test("Kuma group summaries show labelled 24-hour history when available", () => {
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
  assert.match(svg, /<title>24-hour history in 12 two-hour windows/);
  assert.match(svg, /#ff647c/);
});

test("history bars distinguish no data, report sparse coverage, and name each two-hour window", () => {
  const svg = svgGroupSummary({ x: 10, y: 30, right: 600, scale: 1, label: "operational", count: 2,
    history: ["down", null, null, null, null, null, null, null, null, null, null, "operational"] });
  assert.match(svg, /Limited history · 24h · 2\/12 windows with data/);
  assert.match(svg, /aria-label="24-hour history in 12 two-hour windows, oldest to newest:/);
  assert.match(svg, /22–24 hours ago: Down/);
  assert.match(svg, /0–2 hours ago: Operational/);
  assert.match(svg, /2–4 hours ago: No data/);
  assert.match(svg, /fill="#334155"/);
});

test("full coverage and mixed-monitor group history use the worst observed status per window", () => {
  const full = svgGroupSummary({ x: 10, y: 30, right: 600, scale: 1, label: "operational", count: 2, history: Array(12).fill("operational") });
  assert.match(full, /24h · 12\/12 windows with data/);
  assert.doesNotMatch(full, /Limited history/);

  const mixed: DashboardSource = { ...sample, fetchedAt: "2026-01-02T03:05:00.000Z", components: [
    { ...sample.components[0], id: "api", status: "down", history: [{ at: "2026-01-02T00:00:00.000Z", status: "down" }] },
    { ...sample.components[0], id: "web", status: "operational", history: [{ at: "2026-01-02T00:00:00.000Z", status: "operational" }] },
  ] };
  const svg = dashboardSVG([mixed]);
  assert.match(svg, /2–4 hours ago: Down/);
  assert.match(svg, /Limited history · 24h · 1\/12 windows with data/);
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
  assert.match(svg, /Service data stale/);
  assert.match(svg, /Service status unknown/);
  assert.doesNotMatch(svg, /1 service operational/);
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
  assert.match(svg, /1 configured source · 1 monitored service/);
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
    cache: { statusPage: { contentFetchedAt: "2026-01-01T12:00:00.000Z" } },
  };
  const svg = dashboardSVG([unavailable]);
  assert.match(svg, /1 unavailable feed/);
  assert.match(svg, /Feed unavailable/);
  assert.match(svg, /Monitoring data unavailable/);
  assert.match(svg, /1 unavailable feed/);
  assert.match(svg, /Service status cannot be confirmed/);
  assert.match(svg, /Last known: Operational/);
  assert.match(svg, /Monitoring feed unavailable"><rect x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+" rx="[^"]+" fill="#202d40" stroke="#fb923c"/);
  assert.doesNotMatch(svg, /Services: Unknown/);
  assert.doesNotMatch(svg, /2 active services · 2 services operational/);
  const descriptionY = Number(svg.match(/<text x="[^"]+" y="([\d.]+)"[^>]*>Statuspage: Status source unavailable<\/text>/)?.[1]);
  assert.match(svg, /Status API request failed\./);
  assert.match(svg, /Last successful feed data 12:00 UTC/);
  const noticeY = Number(svg.match(/<g role="group" aria-label="Monitoring feed unavailable"><rect x="[^"]+" y="([\d.]+)"/)?.[1]);
  assert.ok(noticeY > descriptionY, "source errors should sit below the source details");
});

test("stale service data is described separately from service outages and includes its age", () => {
  const stale: DashboardSource = {
    ...sample,
    fetchedAt: "2026-01-01T10:40:00.000Z",
    freshness: "stale",
    status: "stale",
    components: [{ ...sample.components[0], status: "stale", sampledAt: "2026-01-01T03:13:00.000Z" }],
  };
  const svg = dashboardSVG([stale]);
  assert.match(svg, /Monitoring data delayed/);
  assert.match(svg, /1 service with stale data/);
  assert.match(svg, /1 stale feed/);
  assert.match(svg, /Stale · Last check 03:13 UTC · 7h 27m old/);
  assert.match(svg, /Service data is stale; health unconfirmed/);
  assert.doesNotMatch(svg, /1 down/);
  const narrow = dashboardSVG(Array.from({ length: 4 }, (_, index) => ({
    ...stale,
    id: `stale-${index}`,
    components: [{ ...stale.components[0], history: [{ at: "2026-01-01T03:13:00.000Z", status: "operational" as const }] }],
  })));
  assert.match(narrow, /Last: Operational · 7h27m/);
});

test("stale service cards sort a copy of history to show the latest known status", () => {
  const history = [
    { at: "2026-01-01T03:10:00.000Z", status: "degraded" as const },
    { at: "2026-01-01T03:13:00.000Z", status: "operational" as const },
  ];
  const originalHistory = history.map((item) => ({ ...item }));
  const stale: DashboardSource = {
    ...sample,
    fetchedAt: "2026-01-01T10:40:00.000Z",
    freshness: "stale",
    status: "stale",
    components: [{ ...sample.components[0], status: "stale", sampledAt: "2026-01-01T03:13:00.000Z", history }],
  };

  const svg = dashboardSVG([stale]);

  assert.match(svg, /Last known: Operational/);
  assert.deepEqual(history, originalHistory);
});

test("unexpected cached statuses use the Unknown label in wide and narrow cards", () => {
  const invalid: DashboardSource = {
    ...sample,
    freshness: "unavailable",
    fetchedAt: "2026-01-01T10:40:00.000Z",
    components: [{ ...sample.components[0], status: "future-status" as DashboardSource["components"][number]["status"], sampledAt: "2026-01-01T10:40:00.000Z" }],
  };
  const wide = dashboardSVG([invalid]);
  assert.match(wide, /Last known: Unknown/);
  assert.doesNotMatch(wide, /Last known: undefined/);

  const narrow = dashboardSVG(Array.from({ length: 4 }, (_, index) => ({ ...invalid, id: `invalid-${index}` })));
  assert.match(narrow, /Last: Unknown · 0m/);
  assert.doesNotMatch(narrow, /Last: undefined/);
});

test("Statuspage incidents remain in their source card while maintenance uses the shared agenda", () => {
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
  assert.match(svg, /Scheduled maintenance · 1 event/);
  assert.match(svg, /Elevated error rate/);
  assert.match(svg, /Sample flight-planning service v4\.2\.0 update/);
  assert.match(svg, /Starts 2026-01-02 05:00 UTC/);
  assert.match(svg, /in 2 hours/);
  assert.match(svg, /Updated 03:00 UTC/);
  assert.doesNotMatch(svg, /MAINTENANCE · Sample flight-planning/);
});

test("scheduled maintenance is promoted into one shared, detailed agenda and duplicate feeds are combined", () => {
  const west: DashboardSource = {
    ...sample,
    id: "west",
    displayName: "West Europe",
    provider: "atlassian-statuspage",
    fetchedAt: "2026-01-02T03:00:00.000Z",
    components: [{ ...sample.components[0], name: "Flight app", status: "maintenance" }],
    maintenance: [{ id: "maintenance-west", name: "Platform update", status: "scheduled", impact: "maintenance", updatedAt: "2026-01-02T02:30:00.000Z", scheduledFor: "2026-01-02T05:00:00.000Z", scheduledUntil: "2026-01-02T06:00:00.000Z", componentNames: ["Flight app"] }],
  };
  const north: DashboardSource = {
    ...west,
    id: "north",
    displayName: "North America",
    components: [{ ...sample.components[0], name: "Reporting", status: "maintenance" }],
    maintenance: [{ ...west.maintenance[0], id: "maintenance-north", status: "in_progress", componentNames: ["Reporting"] }],
  };

  const svg = dashboardSVG([west, north], 1280, 720);

  assert.match(svg, /Scheduled maintenance · 1 event/);
  assert.equal((svg.match(/Platform update/g) ?? []).length, 1, "a shared event should render once");
  assert.match(svg, /IN PROGRESS/);
  assert.match(svg, /Starts 2026-01-02 05:00 UTC/);
  assert.match(svg, /Ends 2026-01-02 06:00 UTC/);
  assert.doesNotMatch(svg, /in 2 hours/);
  assert.match(svg, /Impact: maintenance/);
  assert.match(svg, /Affected: Flight app, Reporting/);
  assert.match(svg, /Sources: West Europe, North America/);
  assert.match(svg, /Updated 02:30 UTC/);
  assert.doesNotMatch(svg, /MAINTENANCE · Platform update/);
});

test("unscheduled duplicates merge with a single scheduled match and promote their active status", () => {
  const createSource = (id: string, displayName: string, maintenance: DashboardSource["maintenance"][number]): DashboardSource => ({
    ...sample,
    id,
    displayName,
    provider: "atlassian-statuspage",
    maintenance: [maintenance],
  });
  const west = createSource("west", "West", { id: "west-update", name: "Platform update", status: "scheduled", impact: "maintenance", updatedAt: null });
  const north = createSource("north", "North", { id: "north-update", name: "Platform update", status: "in_progress", impact: "major", updatedAt: null, scheduledFor: "2026-01-02T05:00:00.000Z" });

  const svg = dashboardSVG([west, north]);

  assert.match(svg, /Scheduled maintenance · 1 event/);
  assert.equal((svg.match(/Platform update/g) ?? []).length, 1);
  assert.match(svg, /IN PROGRESS/);
  assert.match(svg, /Sources: West, North/);
  assert.match(svg, /Starts 2026-01-02 05:00 UTC/);
});

test("unscheduled duplicates with different statuses merge without a scheduled time", () => {
  const west: DashboardSource = {
    ...sample,
    id: "west",
    displayName: "West",
    maintenance: [{ id: "west-update", name: "Platform update", status: "scheduled", impact: "maintenance", updatedAt: null }],
  };
  const north: DashboardSource = {
    ...west,
    id: "north",
    displayName: "North",
    maintenance: [{ id: "north-update", name: "Platform update", status: "in_progress", impact: "maintenance", updatedAt: null }],
  };

  const svg = dashboardSVG([west, north]);

  assert.match(svg, /Scheduled maintenance · 1 event/);
  assert.equal((svg.match(/Platform update/g) ?? []).length, 1);
  assert.match(svg, /IN PROGRESS/);
  assert.match(svg, /Sources: West, North/);
  assert.match(svg, /Schedule time not provided/);
});

test("an unscheduled event stays separate when the same name has multiple scheduled windows", () => {
  const source: DashboardSource = {
    ...sample,
    maintenance: [
      { id: "window-one", name: "Platform update", status: "scheduled", impact: "maintenance", updatedAt: null, scheduledFor: "2026-01-02T05:00:00.000Z" },
      { id: "window-two", name: "Platform update", status: "scheduled", impact: "maintenance", updatedAt: null, scheduledFor: "2026-01-02T07:00:00.000Z" },
      { id: "unscheduled", name: "Platform update", status: "scheduled", impact: "maintenance", updatedAt: null },
    ],
  };

  const svg = dashboardSVG([source]);

  assert.match(svg, /Scheduled maintenance · 3 events/);
  assert.equal((svg.match(/Platform update/g) ?? []).length, 2, "two cards render and one is summarized in the overflow count");
  assert.match(svg, /\+ 1 more maintenance event/);
});

test("the service cards reclaim the agenda space when no maintenance is active", () => {
  const source: DashboardSource = {
    ...sample,
    provider: "atlassian-statuspage",
    maintenance: [{ id: "maintenance", name: "Platform update", status: "scheduled", impact: "maintenance", updatedAt: null, scheduledFor: "2026-01-02T05:00:00.000Z" }],
  };
  const cardY = (svg: string) => Number(svg.match(/<rect x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="[\d.]+" rx="[\d.]+" fill="#142238" stroke="#344a66"/)?.[1]);
  const withoutMaintenance = dashboardSVG([{ ...source, maintenance: [] }], 1280, 720);
  const withMaintenance = dashboardSVG([source], 1280, 720);

  assert.doesNotMatch(withoutMaintenance, /Scheduled maintenance/);
  assert.equal(cardY(withMaintenance), cardY(withoutMaintenance), "source cards remain anchored below the dashboard summary");
  const cardHeight = (svg: string) => Number(svg.match(/<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="([\d.]+)" rx="[\d.]+" fill="#142238" stroke="#344a66"/)?.[1]);
  assert.ok(cardHeight(withMaintenance) < cardHeight(withoutMaintenance), "only active maintenance reduces source-card height");
  assert.match(withMaintenance, /Platform update/);
  assert.ok(Number(withMaintenance.match(/Scheduled maintenance[^<]*<\/text><rect x="[\d.]+" y="([\d.]+)"/)?.[1]) > cardY(withMaintenance));
  assert.doesNotMatch(withMaintenance, /MAINTENANCE · Platform update/);
});

test("the agenda gives active work priority, shows the next scheduled work, and counts overflow", () => {
  const source: DashboardSource = {
    ...sample,
    maintenance: [
      { id: "later", name: "Later maintenance", status: "scheduled", impact: "minor", updatedAt: null, scheduledFor: "2026-01-03T05:00:00.000Z" },
      { id: "soon", name: "Next maintenance", status: "scheduled", impact: "major", updatedAt: null, scheduledFor: "2026-01-02T05:00:00.000Z" },
      { id: "active", name: "Active maintenance", status: "in_progress", impact: "major", updatedAt: null, scheduledFor: "2026-01-02T02:00:00.000Z" },
    ],
  };

  const svg = dashboardSVG([source], 1280, 720);

  assert.ok(svg.indexOf("Active maintenance") < svg.indexOf("Next maintenance"));
  assert.match(svg, /Scheduled maintenance · 3 events/);
  assert.match(svg, /\+ 1 more maintenance event/);
  assert.doesNotMatch(svg, /Later maintenance/);
});

test("dense multirow dashboards expand one maintenance card and summarize the rest", () => {
  const sources = Array.from({ length: 4 }, (_, index) => ({ ...sample, id: `source-${index}` }));
  sources[0].maintenance = [
    { id: "active", name: "Active maintenance", status: "in_progress", impact: "major", updatedAt: null, scheduledFor: "2026-01-02T02:00:00.000Z" },
    { id: "next", name: "Next maintenance", status: "scheduled", impact: "minor", updatedAt: null, scheduledFor: "2026-01-02T05:00:00.000Z" },
    { id: "later", name: "Later maintenance", status: "scheduled", impact: "minor", updatedAt: null, scheduledFor: "2026-01-03T05:00:00.000Z" },
  ];

  const svg = dashboardSVG(sources, 1280, 720);

  assert.match(svg, /Scheduled maintenance · 3 events/);
  assert.match(svg, /Active maintenance/);
  assert.doesNotMatch(svg, /Next maintenance|Later maintenance/);
  assert.match(svg, /\+ 2 more maintenance events/);
});

test("cached maintenance from stale feeds is not shown as current work", () => {
  const source: DashboardSource = {
    ...sample,
    freshness: "stale",
    maintenance: [{ id: "old", name: "Possibly outdated work", status: "scheduled", impact: "maintenance", updatedAt: null, scheduledFor: "2026-01-02T05:00:00.000Z" }],
  };
  assert.doesNotMatch(dashboardSVG([source]), /Scheduled maintenance|Possibly outdated work/);
});

test("maintenance-free office cards keep service rows compact instead of stretching them through empty space", () => {
  const source: DashboardSource = {
    ...sample,
    provider: "atlassian-statuspage",
    groups: [{ id: "customer", name: "Customer services", order: 0 }, { id: "shared", name: "Shared services", order: 1 }],
    components: [
      { ...sample.components[0], id: "flight", name: "Flight search", groupId: "customer", groupName: "Customer services", groupOrder: 0, componentOrder: 0 },
      { ...sample.components[0], id: "booking", name: "Booking API", groupId: "customer", groupName: "Customer services", groupOrder: 0, componentOrder: 1 },
      { ...sample.components[0], id: "web", name: "Public website", groupId: "shared", groupName: "Shared services", groupOrder: 1, componentOrder: 2 },
      { ...sample.components[0], id: "mail", name: "Notifications", groupId: "shared", groupName: "Shared services", groupOrder: 1, componentOrder: 3 },
    ],
    maintenance: [],
  };
  const svg = dashboardSVG([source], 1280, 720);
  const labels = ["Customer services", "Flight search", "Booking API", "Shared services", "Public website", "Notifications"];
  const baselines = labels.map((label) => Number(svg.match(new RegExp(`<text x="[^\"]+" y="([\\d.]+)"[^>]*>${label}</text>`))?.[1]));

  assert.ok(baselines.every(Number.isFinite));
  assert.ok(baselines.slice(1).every((baseline, index) => baseline - baselines[index] <= 42), `service row gaps are too large: ${baselines}`);
  assert.doesNotMatch(svg, /Scheduled maintenance/);
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

test("header emphasizes issue counts without a redundant status key", () => {
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

test("maintenance agenda is a reusable, escaped UI component with a visible overflow count", () => {
  const agenda = svgMaintenanceAgenda({ x: 10, y: 20, width: 900, height: 300, scale: 1, events: [
    { name: "Upgrade <core>", status: "in_progress", impact: "major", color: "#a78bfa", scheduledFor: "2026-01-02T02:00:00.000Z", scheduledUntil: "2026-01-02T06:00:00.000Z", referenceAt: "2026-01-02T03:00:00.000Z", updatedAt: "2026-01-02T02:30:00.000Z", sources: ["West"], affected: ["API"] },
  ], hiddenCount: 2 });
  assert.match(agenda, /Scheduled maintenance · 3 events/);
  assert.match(agenda, /Upgrade &lt;core&gt;/);
  assert.match(agenda, /IN PROGRESS/);
  assert.match(agenda, /started 1 hour ago/);
  assert.match(agenda, /Starts 2026-01-02 02:00 UTC/);
  assert.match(agenda, /Ends 2026-01-02 06:00 UTC/);
  assert.match(agenda, /Impact: major/);
  assert.match(agenda, /Sources: West/);
  assert.match(agenda, /Affected: API/);
  assert.match(agenda, /2 more maintenance events/);
  assert.doesNotMatch(agenda, /<core>/);
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
    svgMaintenanceAgenda({ x: 0, y: 0, width: 400, height: 220, scale: 1, events: [{ name: "Maintenance", status: "scheduled", color: hostileColor, sources: [], affected: [] }] }),
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
