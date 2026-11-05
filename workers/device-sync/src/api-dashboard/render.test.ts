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
