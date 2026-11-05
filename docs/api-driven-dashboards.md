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

In **Capture dashboards**, choose **Add an API status dashboard**. Add sources
with the structured editor, choose 1920 by 1080 or another supported resolution,
and select a one or five minute interval. The optional advanced JSON editor is
available for bulk edits. A source entry looks like:

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

Capture sites is reserved for Browser Run webpage screenshots. API dashboards
have a separate home tile and page. The structured editor validates fields as
you edit; saving preserves source IDs, order, enabled state and optional JSON
properties. Individual sources can be disabled without treating them as failed
or stale. A dashboard can be manually refreshed, enabled or disabled, removed,
and added to any playlist using the existing playlist editor. Playlist
assignment starts normal scheduled captures on the management Worker’s one
minute Cron.

## Providers and status rules

Uptime Kuma reads the public status page configuration and heartbeat JSON. It
keeps public group and monitor order, maps documented status codes, chooses the
latest valid heartbeat, and reports `ping` only when it is a valid non-negative
measurement. Missing histories are `Unknown`. Heartbeats older than 15 minutes
are marked stale. Statuspage reads the public summary endpoint, retains parent
group relationships, and excludes group components from leaf service health
aggregation.

Both adapters persist independent endpoint metadata and send `If-None-Match`
and/or `If-Modified-Since` on later polls when the prior response supplied those
validators. A valid 304 reuses the matching cached data. Kuma keeps separate
metadata for status-page configuration and heartbeat data; a 304 heartbeat
keeps its original sample times, so revalidation cannot make an old heartbeat
look current. `Cache-Control: no-store` disables validator reuse for that
endpoint. A validator is an optimization only: each endpoint is still
requested on every poll, even when its max-age has not elapsed. A source host or
Kuma slug change invalidates its prior cache. Missing validators cause a normal
fetch. An unsolicited 304 or a response without usable cached content is an
unavailable source, never a healthy one.

The code and tests cover ETag, Last-Modified, independent Kuma endpoint
validators, `no-store`, changed source configuration and unsolicited 304s. A
live probe of the seven public source hosts could not complete from the
development environment: its outbound proxy rejected HTTPS CONNECT with HTTP
403. Therefore validator support for those specific origins remains unverified;
the adapters use conditional fetching only when each origin advertises
validators.

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
renders ten synthetic 1920 by 1080 scenarios, validates their PNG headers, and
writes them to [`examples/api-dashboard/visual-samples/`](../examples/api-dashboard/visual-samples/).
The realistic seven-source image is also written to
[`examples/api-dashboard/status-dashboard.png`](../examples/api-dashboard/status-dashboard.png).
Scenarios cover operational, degraded, down, incident, maintenance, partial and
total source failure, a large monitor group, long names, and the seven-source
layout. They contain generic synthetic data, not captured customer data. The
test also covers deterministic PNG bytes in Node; the Workers runtime test is
the compatibility proof. PNGs are checked at native resolution and the main
sample is inspected at reduced display size as well.

Before these changes, the local baseline for one fixture was about 246 ms for
Node rendering and 1.8 seconds for Wrangler Worker startup plus rendering. These
are local wall-clock timings and include Wasm initialization; they are not
Cloudflare CPU time or production resource measurements. The new runtime test
renders ten samples in one Worker process to verify compatibility across the
scenarios. It does not claim a production CPU or peak-memory improvement.
No production deployment was performed.

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
Statuspage pages (one GET each): 12 upstream requests per poll before retries.
Conditional requests reduce transfer bytes only when a source supports them;
they do not reduce the request count. A dashboard must be in the active playlist
to receive recurring captures. The table is per active dashboard and assumes
no retries.

| Refresh interval | Upstream requests / day | Upstream requests / 30 days | Queue capture deliveries / day | Queue capture deliveries / 30 days |
| --- | ---: | ---: | ---: | ---: |
| 1 minute | 17,280 | 518,400 | 1,440 | 43,200 |
| 5 minutes | 3,456 | 103,680 | 288 | 8,640 |

The management Worker already runs a shared one-minute Cron for scheduling; the
queue-delivery counts above are the additional per-dashboard capture jobs. At
most one rasterization and one new content-addressed R2 object can occur per
capture cycle. In practice, the existing SVG content hash skips rasterization
when visible content is unchanged, and the PNG content digest reuses an already
stored object. Storage depends on PNG size and history retention, so this model
does not project GB-months from sample images. Browser Run use for an API-only
playlist is zero browser minutes.

Current published Cloudflare pricing is listed in the linked product pages;
this workload table is not an account bill estimate. Workers Paid Standard
includes 10 million Worker requests and 30 million CPU milliseconds per month,
then charges for excess requests and CPU. Workers Free limits are daily. R2
Standard includes 10 GB-month storage, 1 million Class A operations and 10
million Class B operations monthly. D1 Free includes 5 million rows read and
100,000 rows written daily; Paid includes 25 billion rows read and 50 million
rows written monthly. These are account-wide allowances, and actual plan,
account usage, API dashboard image changes and retries affect billing. See
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and
[R2 pricing](https://developers.cloudflare.com/r2/pricing/) for current terms.

## Efficiency measurements and baseline comparison

The dashboard management card exposes the latest successful capture, last image
change, latest PNG size and resolution, latest run timings, per-source freshness
and endpoint cache validators. Its expanded efficiency view summarizes at most
100 recent capture jobs in the last 30 days: successes and terminal failures,
retry attempts, partial/all-source failures, upstream requests and 304s,
response body bytes, API fetch/render and capture-work wall-time p50/p90,
render failures, content-hash render skips, and R2 asset reuse. Response body
bytes are counted after reading by the Worker; they are not compressed wire
bytes, and a 304 contributes no body bytes. Job measurements remain in the
existing capture job history; the summary adds no separate event store. Source
cache/freshness details show the last request data available in the normalized
snapshot.

| Measurement | Before | After |
| --- | --- | --- |
| Seven-source upstream requests | 12 per successful poll | Still 12; 304 can reduce response bytes where the origin supports validators |
| Kuma persisted validators | None | Independent ETag/Last-Modified metadata per endpoint |
| Unchanged visible dashboard | Existing content hash skipped PNG work | Still skips rendering; request and byte totals are now recorded |
| Worker render timing | Local wall-clock baseline only | Per-job fetch/render/capture-work wall duration, render failure count and p50/p90 summaries |
| Production Worker CPU/memory, D1 and R2 usage | Not available in app | Still requires Cloudflare Analytics; never inferred from wall time |

The local repeated-capture test measures one rasterization followed by a
content-hash match that skips rasterization and reuses the same R2 asset. No live
origin responses were available to measure byte savings, and no production CPU,
D1, R2 operations or billed cost was measured. Queue captures bypass Browser
Run and continue contributing zero Browser Run minutes.

## Migrations and validation

Migration `0017_api_dashboards.sql` widens the shared capture interval check,
adds API source/status/content hash fields and API job timing fields. Migration
`0018_api_dashboard_metrics.sql` adds per-job API counters and the index used
for recent summaries. Both preserve prior job data and existing
capture/playlist references. Apply pending migrations through the existing
management migration command:

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
