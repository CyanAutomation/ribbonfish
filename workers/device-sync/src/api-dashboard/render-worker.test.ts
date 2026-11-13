import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const wrangler = createRequire(import.meta.url).resolve("wrangler");

function visualScenarios(base: { width: number; height: number; sources: any[] }) {
  const healthy = structuredClone(base);
  for (const source of healthy.sources) {
    source.freshness = "fresh";
    source.status = "operational";
    source.error = undefined;
    source.incidents = [];
    source.maintenance = [];
    for (const component of source.components) if (!component.isGroup) component.status = "operational";
  }
  const clone = () => structuredClone(healthy);
  const scenarios = [{ name: "all-services-operational", value: clone() }];
  const officeSource = (id: string, displayName: string, hostname: string, names: string[]) => {
    const groups = [{ id: `${id}-customer`, name: "Customer services", order: 0 }, { id: `${id}-shared`, name: "Shared services", order: 1 }];
    const components = [
      { id: groups[0].id, name: groups[0].name, status: "operational", sampledAt: null, groupId: null, groupName: null, isGroup: true, groupOrder: 0, componentOrder: 0 },
      ...names.slice(0, 4).map((name, index) => ({ id: `${id}-customer-${index}`, name, status: "operational", sampledAt: null, groupId: groups[0].id, groupName: groups[0].name, groupOrder: 0, componentOrder: index + 1 })),
      { id: groups[1].id, name: groups[1].name, status: "operational", sampledAt: null, groupId: null, groupName: null, isGroup: true, groupOrder: 1, componentOrder: 5 },
      ...names.slice(4).map((name, index) => ({ id: `${id}-shared-${index}`, name, status: "operational", sampledAt: null, groupId: groups[1].id, groupName: groups[1].name, groupOrder: 1, componentOrder: index + 6 })),
    ];
    return {
      id, provider: "atlassian-statuspage", displayName, hostname,
      fetchedAt: "2026-11-05T12:00:00.000Z", freshness: "fresh", status: "operational",
      statusDescription: "All systems operational", groups, components, incidents: [],
      maintenance: [{ id: `${id}-maintenance`, name: "Sample flight-planning service v4.2.0 update", status: "scheduled", impact: "maintenance", updatedAt: "2026-11-05T11:45:00.000Z", scheduledFor: "2026-11-06T02:00:00.000Z" }],
    };
  };
  scenarios.push({ name: "office-statuspage-display", value: {
    width: base.width,
    height: base.height,
    sources: [
      officeSource("west", "West region services", "status-west.example.net", ["Flight search", "Booking API", "Check-in", "Payment service", "Public website", "Notifications"]),
      officeSource("north", "North region services", "status-north.example.net", ["Search API", "Booking API", "Mobile check-in", "Payment service", "Public website", "Messaging"]),
    ],
  } });
  const degraded = clone();
  degraded.sources[0].components[0].status = "degraded";
  degraded.sources[0].status = "degraded";
  scenarios.push({ name: "degraded-service", value: degraded });
  const down = clone();
  down.sources[2].components[0].status = "down";
  down.sources[2].status = "down";
  down.sources[2].incidents = [{ id: "incident-down", name: "Customer identity service unavailable", status: "identified", impact: "major", updatedAt: "2026-11-05T11:57:00.000Z" }];
  scenarios.push({ name: "service-down", value: down });
  const incident = clone();
  incident.sources[0].incidents = [{ id: "incident-active", name: "Elevated API response times", status: "investigating", impact: "minor", updatedAt: "2026-11-05T11:58:00.000Z" }];
  scenarios.push({ name: "active-incident", value: incident });
  const maintenance = clone();
  maintenance.sources[1].maintenance = [{ id: "maintenance-active", name: "Sample flight-planning service v4.2.0 update", status: "scheduled", impact: "maintenance", updatedAt: "2026-11-05T11:45:00.000Z", scheduledFor: "2026-11-06T02:00:00.000Z" }];
  maintenance.sources[1].components[0].status = "maintenance";
  scenarios.push({ name: "scheduled-maintenance", value: maintenance });
  const partial = clone();
  Object.assign(partial.sources.at(-1), { freshness: "unavailable", status: "stale", statusDescription: "Status source unavailable", error: "Status API request timed out.", groups: [], components: [], incidents: [], maintenance: [] });
  scenarios.push({ name: "partial-source-failure", value: partial });
  const unavailable = clone();
  for (const source of unavailable.sources) Object.assign(source, { freshness: "unavailable", status: "stale", statusDescription: "Status source unavailable", error: "Status API request timed out.", groups: [], components: [], incidents: [], maintenance: [] });
  scenarios.push({ name: "all-sources-unavailable", value: unavailable });
  const largeGroup = clone();
  largeGroup.sources = [largeGroup.sources[0]];
  largeGroup.sources[0].groups = [{ id: "edge", name: "Core network and application infrastructure services", order: 0 }];
  largeGroup.sources[0].components = Array.from({ length: 72 }, (_, index) => ({ id: `service-${index}`, name: `Synthetic monitored service ${index + 1}`, status: "operational", sampledAt: "2026-11-05T11:59:40.000Z", groupId: "edge", groupName: "Core network and application infrastructure services", groupOrder: 0, componentOrder: index }));
  scenarios.push({ name: "large-monitor-group", value: largeGroup });
  const longNames = clone();
  longNames.sources = [longNames.sources[0]];
  longNames.sources[0].displayName = "Synthetic customer identity and account provisioning platform across the western processing region";
  longNames.sources[0].groups = [{ id: "long-group", name: "Regional authentication, authorization and account lifecycle services", order: 0 }];
  longNames.sources[0].components = [{ id: "long-name", name: "Customer identity and account provisioning service across the regional transaction processing network", status: "degraded", sampledAt: "2026-11-05T11:59:30.000Z", groupId: "long-group", groupName: "Regional authentication, authorization and account lifecycle services", groupOrder: 0, componentOrder: 0 }];
  longNames.sources[0].status = "degraded";
  longNames.sources[0].incidents = [{ id: "long-incident", name: "Intermittent elevated response latency affecting identity verification", status: "investigating", impact: "minor", updatedAt: "2026-11-05T11:58:00.000Z" }];
  scenarios.push({ name: "long-component-names", value: longNames });
  scenarios.push({ name: "realistic-seven-source", value: base });
  return scenarios;
}

test("resvg WebAssembly and bundled font render under the Cloudflare Workers runtime", async (t) => {
  const port = 9867;
  const child = spawn(process.execPath, [wrangler, "dev", "--config", "wrangler.api-render-test.toml", "--local", "--port", String(port)], {
    cwd: root, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  t.after(() => child.kill("SIGTERM"));
  const data = JSON.parse(await readFile(new URL("./fixtures/realistic-seven-source.json", import.meta.url), "utf8"));
  let response: Response | null = null;
  let failure: unknown;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      response = await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      break;
    } catch (error) { failure = error; await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  assert.ok(response, `Worker did not become available: ${String(failure)}\n${logs}`);
  const scenarios = visualScenarios(data);
  const outputDirectory = join(root, "../../examples/api-dashboard/visual-samples");
  await mkdir(outputDirectory, { recursive: true });
  for (const scenario of scenarios) {
    response = await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(scenario.value) });
    assert.ok(response, `Worker did not become available for ${scenario.name}: ${String(failure)}\n${logs}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(response.status, 200, `${scenario.name}: ${new TextDecoder().decode(bytes)}\n${logs}`);
    assert.equal(response.headers.get("Content-Type"), "image/png");
    assert.equal(bytes[0], 137);
    assert.equal(String.fromCharCode(...bytes.slice(1, 4)), "PNG");
    assert.equal(new DataView(bytes.buffer, bytes.byteOffset).getUint32(16), 1920);
    assert.equal(new DataView(bytes.buffer, bytes.byteOffset).getUint32(20), 1080);
    assert.ok(bytes.byteLength < 32 * 1024 * 1024);
    await writeFile(join(outputDirectory, `${scenario.name}.png`), bytes);
    if (scenario.name === "realistic-seven-source") await writeFile(join(root, "../../examples/api-dashboard/status-dashboard.png"), bytes);
  }
  assert.equal(scenarios.length, 11);
});
