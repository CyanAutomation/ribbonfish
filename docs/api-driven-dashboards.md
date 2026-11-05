# API driven status dashboards

API dashboards use the existing Ribbonfish capture queue, D1 capture targets,
capture history, R2 content addressed asset store, and playlist capture slots.
They do not use Browser Run, a browser binding, a separate image service, or a
second device delivery path. The Raspberry Pi agent receives the generated PNG
as an ordinary playlist asset.

## Configure

`API_STATUS_ALLOWED_HOSTS` on the management Worker is an optional comma
separated list of exact hostnames. When it is empty or unset, any hostname that
passes the adapter's hostname syntax checks is accepted. As soon as one or
more hostnames are listed, they form an exact-match allowlist. Keep any
configured list in Worker settings or local environment configuration rather
than source control. Requests use HTTPS, manual redirect handling, an 8 second
timeout, a 1 MB response limit, and schema/workload caps. The adapters reject
IP addresses, single-label hosts, and local or reserved host suffixes.

The management Worker enables Cloudflare's `global_fetch_strictly_public`
compatibility flag. This routes global `fetch()` requests as public Internet
requests instead of using a zone's origin-routing path; the Worker has no
private-network VPC binding. Keep this flag enabled when the host allowlist is
empty. The empty list is intentionally permissive for hostnames; populate it
when administrators should be limited to a known set of source hosts. See
[Cloudflare's compatibility flag documentation](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public).
No API credentials are supported or needed.

In **Capture sites**, choose **Add an API status dashboard**. Paste a source
array in the editor, choose 1920 by 1080 or another supported resolution, and
select a one or five minute interval. A source entry looks like:

```json
{
  "id": "region-a",
  "provider": "uptime-kuma",
  "display_name": "Production region A",
  "enabled": true,
  "hostname": "monitor.example.org",
  "slug": "production-a"
}
```

Atlassian Statuspage sources use `"provider": "atlassian-statuspage"` and a
`hostname`; they do not need a slug. See
[`examples/api-dashboard/config.example.json`](../examples/api-dashboard/config.example.json)
for a generic seven source configuration. Replace example hostnames and slugs
with the values managed by your organization. Source names, actual hostnames,
and customer identifiers are deliberately absent from this repository.

The configured source JSON is validated and can also be edited in the dashboard
card. Individual sources can be disabled. A dashboard can be manually refreshed,
enabled or disabled, removed, and added to any playlist using the existing
playlist editor. Playlist assignment starts normal scheduled captures on the
management Worker’s one minute Cron.

## Providers and status rules

Uptime Kuma reads the public status page configuration and heartbeat JSON. It
keeps public group and monitor order, maps documented status codes, chooses the
latest valid heartbeat, and reports `ping` only when it is a valid non-negative
measurement. Missing histories are `Unknown`. Heartbeats older than 15 minutes
are marked stale. Statuspage reads the public summary endpoint, retains parent
group relationships, and excludes group components from leaf service health
aggregation. Statuspage ETags are sent with `If-None-Match` when available;
304 responses reuse the previous normalized source snapshot. The Kuma endpoints
do not currently have persisted conditional request handling.

Both providers map into the same normalized component, group, health, incident,
maintenance, fetch-time and freshness model. Unknown status strings stay
`Unknown`; pending is not healthy; failed sources are unavailable. No uptime
percentages or missing response times are inferred. A partial source failure is
rendered alongside successful sources. When every source fails, Ribbonfish
keeps the prior image, records source errors and retries through the queue; an
all-failed poll cannot publish a healthy-looking replacement. The management
card makes source freshness and errors visible. A device continues displaying
the last playlist image until a newer successful capture is available.

Queue retries apply to transient request failures (timeouts, HTTP 408, 425, 429,
and 5xx responses) and unexpected rendering or storage failures. Invalid stored
configuration, disabled sources, provider schema errors, and configured
workload-limit violations fail without immediate queue retries. Individual
source failures remain visible in a partial dashboard and are polled again at
the next configured interval.

## Rendering and runtime proof

The renderer builds escaped, deterministic SVG and converts it to PNG with
`@resvg/resvg-wasm` inside the management Worker runtime. It embeds a 53 KB
subset of DejaVu Sans and loads no external fonts or decorative assets. The
renderer rejects resolutions outside 640 by 360 through 3840 by 2160, images
above the existing 32 MiB asset limit, more than 30 sources, or more than 2,000
components. Long names are shortened to fit each service row. Output has no
cosmetic current-time stamp, so an unchanged status image is byte stable.

`npm test` runs a `wrangler dev --local` integration test against Wrangler’s
Cloudflare Workers runtime. It initializes the bundled Wasm module and font,
renders a generic seven source dashboard, validates its 1920 by 1080 PNG header,
and writes [`examples/api-dashboard/status-dashboard.png`](../examples/api-dashboard/status-dashboard.png)
for visual review. The test also covers deterministic PNG bytes in Node, but the
Workers runtime test is the compatibility proof. In this environment the
generic PNG is about 122 KB and local Worker startup plus rendering completed in
about 1.7 seconds; this is not a production CPU or peak-memory benchmark.
Cloudflare CPU and memory limits should be observed after enabling the feature
for representative source sizes. No production deployment was performed.

## Scheduling, traffic, and Browser Run cost

API captures share the existing serial capture queue and history retention. The
default is five minutes; one minute is available because the management Cron
already runs every minute. Existing browser screenshot intervals are unchanged.
API jobs bypass screenshot validators, Browser Run request throttling and daily
browser-budget deferrals. They do not call Browser Run, add browser duration
samples, or contribute to Browser Run usage and forecasts. API fetch and render
milliseconds, last successful source fetch, last changed image time, source
freshness, and asset reuse are recorded separately and shown in management.

The seven source example contains five Kuma pages (two GETs each) and two
Statuspage pages (one GET each): 12 requests per poll before any retries.

| Refresh interval | Requests per hour | Requests per 24 hours |
| --- | ---: | ---: |
| 1 minute | 720 | 17,280 |
| 5 minutes | 144 | 3,456 |

The adapters fetch only the two required Kuma endpoints and one required
Statuspage summary endpoint. Statuspage conditional responses reduce payload
work when the origin supports ETags. Each render is content hashed; unchanged
normalized visible content skips rasterization and the existing R2 object is
reused. Browser Run use for an API only playlist is zero browser minutes.

## Migrations and validation

Migration `0017_api_dashboards.sql` widens the shared capture interval check,
adds API source/status/content hash fields and API job timing fields, and
preserves capture history, playlist references, advisory records and asset
registry triggers. Apply it through the existing management migration command:

```sh
cd workers/device-sync
npm ci
npm run migrate:management
npm run typecheck
npm test
npm run check:config
```

The migration changes the D1 schema only; deploying Worker code remains a
separate operation. The standalone rendering runtime test is:

```sh
node --test src/api-dashboard/render-worker.test.ts
```

Troubleshooting details appear in the dashboard source list and latest job
state. Check hostname syntax and, if configured, the exact host allowlist,
then confirm public API access from the management Worker, and review whether
a source’s heartbeat data is older than the 15 minute freshness threshold.
Browser screenshot diagnostics and JEV
recommendations remain scoped to browser targets.
