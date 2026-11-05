import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fetchSource } from "./adapters.ts";
import { kumaHealth, statuspageHealth } from "./model.ts";

const fixture = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const kumaConfig = { id: "kuma-a", provider: "uptime-kuma" as const, display_name: "Sample Production", enabled: true, hostname: "status.example.org", slug: "sample-prod" };
const allowed = "status.example.org,status-page.example.net";

test("Uptime Kuma maps latest heartbeat, group membership, latency, events and empty history", async () => {
  const [config, heartbeat] = await Promise.all([fixture("kuma-config.json"), fixture("kuma-heartbeat.json")]);
  const source = await fetchSource(kumaConfig, allowed, async (input) => new Response(JSON.stringify(String(input).includes("heartbeat") ? heartbeat : config), { headers: { "Content-Type": "application/json" } }), new Date("2026-01-02T03:05:00Z"));
  assert.equal(source.freshness, "fresh");
  assert.deepEqual(source.components.map(({ name, groupName, status, latencyMs }) => ({ name, groupName, status, latencyMs })), [
    { name: "Primary service", groupName: "First group", status: "operational", latencyMs: 87 },
    { name: "Secondary service", groupName: "First group", status: "unknown", latencyMs: undefined },
    { name: "Worker API", groupName: "Second group", status: "maintenance", latencyMs: 12 },
  ]);
  assert.equal(source.components[0].sampledAt, "2026-01-02T03:04:05.000Z");
  assert.equal(source.components[0].groupOrder, 0);
  assert.equal(source.components[0].componentOrder, 0);
  assert.equal(source.incidents.length, 1);
  assert.equal(source.maintenance.length, 1);
});

test("Atlassian Statuspage preserves groups and children without double-counting group relationships", async () => {
  const summary = await fixture("statuspage-summary.json");
  const source = await fetchSource({ id: "status-b", provider: "atlassian-statuspage", display_name: "Sample Status", enabled: true, hostname: "status-page.example.net" }, allowed,
    async () => new Response(JSON.stringify(summary), { headers: { "Content-Type": "application/json" } }));
  assert.equal(source.freshness, "fresh");
  assert.equal(source.components[0].isGroup, true);
  assert.equal(source.components[1].groupName, "Platform");
  assert.equal(source.components[1].status, "operational");
  assert.equal(source.components[2].status, "degraded");
  assert.equal(source.components[3].status, "unknown");
  assert.equal(source.incidents[0].name, "Elevated error rate");
  assert.equal(source.maintenance[0].name, "Database maintenance");
});

test("provider codes remain conservative for pending, unknown, and stale states", () => {
  assert.equal(kumaHealth(2), "pending");
  assert.equal(kumaHealth(0), "down");
  assert.equal(kumaHealth(99), "unknown");
  assert.equal(statuspageHealth("operational"), "operational");
  assert.equal(statuspageHealth("major_outage"), "down");
  assert.equal(statuspageHealth("new_value"), "unknown");
});

test("an empty host allowlist permits any valid public hostname", async () => {
  const [config, heartbeat] = await Promise.all([fixture("kuma-config.json"), fixture("kuma-heartbeat.json")]);
  const source = await fetchSource({ ...kumaConfig, hostname: "another-public.example.net" }, "", async (input) => new Response(JSON.stringify(String(input).includes("heartbeat") ? heartbeat : config), { headers: { "Content-Type": "application/json" } }), new Date("2026-01-02T03:05:00Z"));
  assert.equal(source.freshness, "fresh");
  assert.equal(source.components.length, 3);
});

test("a configured host allowlist restricts hosts and redirects are not followed", async () => {
  const blocked = await fetchSource(kumaConfig, "different-host.example.org", async () => { throw new Error("should not run"); });
  assert.equal(blocked.freshness, "unavailable");
  assert.match(blocked.error ?? "", /allowlist/);
  const redirected = await fetchSource(kumaConfig, allowed, async () => new Response(null, { status: 302, headers: { Location: "https://other.example" } }));
  assert.equal(redirected.freshness, "unavailable");
  assert.match(redirected.error ?? "", /redirect/);
});

test("Statuspage uses ETag validators and reuses cached normalized data on 304", async () => {
  const summary = await fixture("statuspage-summary.json");
  const config = { id: "status-c", provider: "atlassian-statuspage" as const, display_name: "Sample status", enabled: true, hostname: "status-page.example.net" };
  const first = await fetchSource(config, allowed, async () => new Response(JSON.stringify(summary), { headers: { "Content-Type": "application/json", ETag: '"sample-v1"' } }), new Date("2026-01-02T03:04:00Z"));
  assert.equal(first.etag, '"sample-v1"');
  let sentValidator = "";
  const second = await fetchSource(config, allowed, async (_input, init) => {
    sentValidator = new Headers(init?.headers).get("If-None-Match") ?? "";
    return new Response(null, { status: 304, headers: { ETag: '"sample-v1"' } });
  }, new Date("2026-01-02T03:05:00Z"), first);
  assert.equal(sentValidator, '"sample-v1"');
  assert.equal(second.components.length, first.components.length);
  assert.equal(second.fetchedAt, "2026-01-02T03:05:00.000Z");
});

test("old Kuma heartbeat samples are marked stale without becoming operational", async () => {
  const [config, heartbeat] = await Promise.all([fixture("kuma-config.json"), fixture("kuma-heartbeat.json")]);
  const source = await fetchSource(kumaConfig, allowed, async (input) => new Response(JSON.stringify(String(input).includes("heartbeat") ? heartbeat : config), { headers: { "Content-Type": "application/json" } }), new Date("2026-01-03T00:00:00Z"));
  assert.equal(source.freshness, "stale");
  assert.equal(source.status, "stale");
  assert.equal(source.components[0].status, "stale");
});
