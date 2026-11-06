import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fetchSource } from "./adapters.ts";
import { kumaHealth, statuspageHealth } from "./model.ts";

const fixture = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const kumaConfig = { id: "kuma-a", provider: "uptime-kuma" as const, display_name: "Sample Production", enabled: true, hostname: "status.example.org", slug: "sample-prod" };
const allowed = "status.example.org,status-page.example.net";

test("Uptime Kuma accepts up to 8,000 heartbeat records and explains when the limit is exceeded", async () => {
  const config = await fixture("kuma-config.json");
  const makeFetcher = (recordCount: number): typeof fetch => async (input) => {
    const heartbeat = { heartbeatList: { unused: Array.from({ length: recordCount }, () => ({ status: 1, time: "2026-01-02T03:04:05Z" })) } };
    return new Response(JSON.stringify(String(input).includes("heartbeat") ? heartbeat : config), { headers: { "Content-Type": "application/json" } });
  };

  const atLimit = await fetchSource(kumaConfig, allowed, makeFetcher(8_000), new Date("2026-01-02T03:05:00Z"));
  assert.equal(atLimit.freshness, "fresh");

  const overLimit = await fetchSource(kumaConfig, allowed, makeFetcher(8_001), new Date("2026-01-02T03:05:00Z"));
  assert.equal(overLimit.freshness, "unavailable");
  assert.match(overLimit.error ?? "", /8,001 heartbeat records; dashboard limit is 8,000/i);
  assert.match(overLimit.error ?? "", /reduce monitor history or count/i);
});

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
  assert.equal(source.components[0].statusChangedAt, "2026-01-02T03:04:05.000Z");
  assert.deepEqual(source.components[0].history, [
    { at: "2026-01-02T03:03:00.000Z", status: "down" },
    { at: "2026-01-02T03:04:05.000Z", status: "operational" },
  ]);
  assert.equal(source.components[0].groupOrder, 0);
  assert.equal(source.components[0].componentOrder, 0);
  assert.equal(source.incidents.length, 1);
  assert.equal(source.maintenance.length, 1);
});

test("Kuma state-change time is the first heartbeat in the current consecutive state run", async () => {
  const [config, heartbeat] = await Promise.all([fixture("kuma-config.json"), fixture("kuma-heartbeat.json")]);
  heartbeat.heartbeatList["101"] = [
    { status: 0, time: "2026-01-02T03:01:00Z", ping: null },
    { status: 1, time: "2026-01-02T03:02:00Z", ping: 80 },
    { status: 0, time: "2026-01-02T03:03:00Z", ping: null },
    { status: 1, time: "2026-01-02T03:04:00Z", ping: 87 },
    { status: 1, time: "2026-01-02T03:04:30Z", ping: 89 },
  ];
  const source = await fetchSource(kumaConfig, allowed, async (input) => new Response(JSON.stringify(String(input).includes("heartbeat") ? heartbeat : config), { headers: { "Content-Type": "application/json" } }), new Date("2026-01-02T03:05:00Z"));
  assert.equal(source.components[0].sampledAt, "2026-01-02T03:04:30.000Z");
  assert.equal(source.components[0].statusChangedAt, "2026-01-02T03:04:00.000Z");
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
  assert.equal(source.maintenance[0].updatedAt, "2026-01-02T03:00:00.000Z");
  assert.equal(source.maintenance[0].scheduledFor, "2026-01-02T05:00:00.000Z");
});

test("provider codes remain conservative for pending, unknown, and stale states", () => {
  assert.equal(kumaHealth(2), "pending");
  assert.equal(kumaHealth(0), "down");
  assert.equal(kumaHealth(99), "unknown");
  assert.equal(statuspageHealth("operational"), "operational");
  assert.equal(statuspageHealth("major_outage"), "down");
  assert.equal(statuspageHealth("new_value"), "unknown");
});

test("disabled sources are identified without making an upstream request", async () => {
  let requests = 0;
  const source = await fetchSource({ ...kumaConfig, enabled: false }, allowed, async () => {
    requests += 1;
    throw new Error("disabled source must not be requested");
  });
  assert.equal(requests, 0);
  assert.equal(source.disabled, true);
  assert.equal(source.status, "unknown");
  assert.equal(source.requestStats?.requestCount, 0);
});

test("management Worker routes global fetches strictly over the public Internet", async () => {
  const config = await readFile(new URL("../../wrangler.management.toml", import.meta.url), "utf8");
  assert.match(config, /^compatibility_flags\s*=\s*\["global_fetch_strictly_public"\]\s*$/m);
});

test("an empty host allowlist permits any hostname that passes syntax checks", async () => {
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

test("Uptime Kuma validators are independent for configuration and heartbeats", async () => {
  const [config, heartbeat] = await Promise.all([fixture("kuma-config.json"), fixture("kuma-heartbeat.json")]);
  const first = await fetchSource(kumaConfig, allowed, async (input) => new Response(JSON.stringify(String(input).includes("heartbeat") ? heartbeat : config), {
    headers: { "Content-Type": "application/json", ETag: String(input).includes("heartbeat") ? '"beat-v1"' : '"config-v1"' },
  }), new Date("2026-01-02T03:05:00Z"));
  let configValidator = "";
  let heartbeatValidator = "";
  const second = await fetchSource(kumaConfig, allowed, async (input, init) => {
    const url = String(input);
    const validator = new Headers(init?.headers).get("If-None-Match") ?? "";
    if (url.includes("/heartbeat/")) {
      heartbeatValidator = validator;
      return new Response(null, { status: 304, headers: { ETag: '"beat-v1"' } });
    }
    configValidator = validator;
    return new Response(null, { status: 304, headers: { ETag: '"config-v1"' } });
  }, new Date("2026-01-02T03:20:00Z"), first);
  assert.equal(configValidator, '"config-v1"');
  assert.equal(heartbeatValidator, '"beat-v1"');
  assert.equal(second.components[0].sampledAt, first.components[0].sampledAt, "304 keeps original monitor sample time");
  assert.equal(second.components[0].status, "stale", "revalidation never refreshes monitor health timestamps");
  assert.deepEqual(second.components[0].history, first.components[0].history, "304 keeps the prior heartbeat history");
  assert.equal(second.freshness, "stale");
  assert.equal(second.fetchedAt, "2026-01-02T03:20:00.000Z");
});

test("Kuma source changes invalidate both endpoint validators", async () => {
  const [config, heartbeat] = await Promise.all([fixture("kuma-config.json"), fixture("kuma-heartbeat.json")]);
  const first = await fetchSource(kumaConfig, allowed, async (input) => new Response(JSON.stringify(String(input).includes("heartbeat") ? heartbeat : config), {
    headers: { "Content-Type": "application/json", ETag: '"v1"' },
  }), new Date("2026-01-02T03:05:00Z"));
  const validators: string[] = [];
  await fetchSource({ ...kumaConfig, slug: "other-page" }, allowed, async (input, init) => {
    validators.push(new Headers(init?.headers).get("If-None-Match") ?? "");
    return new Response(JSON.stringify(String(input).includes("heartbeat") ? heartbeat : config), { headers: { "Content-Type": "application/json" } });
  }, new Date("2026-01-02T03:06:00Z"), first);
  assert.deepEqual(validators, ["", ""]);
});

test("Kuma records request counts, response sizes, and independent cache metadata", async () => {
  const [config, heartbeat] = await Promise.all([fixture("kuma-config.json"), fixture("kuma-heartbeat.json")]);
  const source = await fetchSource(kumaConfig, allowed, async (input) => new Response(JSON.stringify(String(input).includes("heartbeat") ? heartbeat : config), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=0, must-revalidate",
      ...(String(input).includes("heartbeat") ? { "Last-Modified": "Fri, 02 Jan 2026 03:04:00 GMT" } : { ETag: '"config-v1"' }),
    },
  }), new Date("2026-01-02T03:05:00Z"));
  assert.deepEqual(source.requestStats && {
    requestCount: source.requestStats.requestCount,
    notModifiedCount: source.requestStats.notModifiedCount,
    failedRequestCount: source.requestStats.failedRequestCount,
  }, { requestCount: 2, notModifiedCount: 0, failedRequestCount: 0 });
  assert.ok((source.requestStats?.responseBytes ?? 0) > 0);
  assert.equal(source.cache?.statusPage?.etag, '"config-v1"');
  assert.equal(source.cache?.heartbeat?.lastModified, "Fri, 02 Jan 2026 03:04:00 GMT");
  assert.equal(source.cache?.statusPage?.cacheControl, "public, max-age=0, must-revalidate");
});

test("Kuma uses Last-Modified independently when ETag is absent", async () => {
  const [config, heartbeat] = await Promise.all([fixture("kuma-config.json"), fixture("kuma-heartbeat.json")]);
  const first = await fetchSource(kumaConfig, allowed, async (input) => new Response(JSON.stringify(String(input).includes("heartbeat") ? heartbeat : config), {
    headers: { "Content-Type": "application/json", ...(String(input).includes("heartbeat") ? { ETag: '"beat-v1"' } : { "Last-Modified": "Fri, 02 Jan 2026 03:04:00 GMT" }) },
  }), new Date("2026-01-02T03:05:00Z"));
  const sent: string[] = [];
  const second = await fetchSource(kumaConfig, allowed, async (input, init) => {
    const headers = new Headers(init?.headers);
    sent.push(`${headers.get("If-None-Match") ?? ""}|${headers.get("If-Modified-Since") ?? ""}`);
    const url = String(input);
    if (url.includes("heartbeat")) return new Response(null, { status: 304, headers: { ETag: '"beat-v1"' } });
    return new Response(null, { status: 304, headers: { "Last-Modified": "Fri, 02 Jan 2026 03:04:00 GMT" } });
  }, new Date("2026-01-02T03:06:00Z"), first);
  assert.deepEqual(sent, ["|Fri, 02 Jan 2026 03:04:00 GMT", '"beat-v1"|']);
  assert.equal(second.requestStats?.notModifiedCount, 2);
  assert.equal(second.freshness, "fresh");
});

test("Kuma does not cache no-store responses or trust unsolicited 304 responses", async () => {
  const [config, heartbeat] = await Promise.all([fixture("kuma-config.json"), fixture("kuma-heartbeat.json")]);
  const first = await fetchSource(kumaConfig, allowed, async (input) => new Response(JSON.stringify(String(input).includes("heartbeat") ? heartbeat : config), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ETag: '"must-not-reuse"' },
  }), new Date("2026-01-02T03:05:00Z"));
  const sent: string[] = [];
  await fetchSource(kumaConfig, allowed, async (_input, init) => {
    sent.push(new Headers(init?.headers).get("If-None-Match") ?? "");
    return new Response(JSON.stringify(config), { headers: { "Content-Type": "application/json" } });
  }, new Date("2026-01-02T03:06:00Z"), first);
  assert.deepEqual(sent, ["", ""]);
  const unsolicited = await fetchSource(kumaConfig, allowed, async () => new Response(null, { status: 304 }), new Date("2026-01-02T03:07:00Z"));
  assert.equal(unsolicited.freshness, "unavailable");
  assert.match(unsolicited.error ?? "", /304 without cached/);
});

test("old Kuma heartbeat samples are marked stale without becoming operational", async () => {
  const [config, heartbeat] = await Promise.all([fixture("kuma-config.json"), fixture("kuma-heartbeat.json")]);
  const source = await fetchSource(kumaConfig, allowed, async (input) => new Response(JSON.stringify(String(input).includes("heartbeat") ? heartbeat : config), { headers: { "Content-Type": "application/json" } }), new Date("2026-01-03T00:00:00Z"));
  assert.equal(source.freshness, "stale");
  assert.equal(source.status, "stale");
  assert.equal(source.components[0].status, "stale");
});
