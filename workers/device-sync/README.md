# Ribbonfish device sync and management Workers

The Worker serves one globally active playlist to enrolled devices. D1 stores
versioned playlists, the active-playlist pointer, legacy credential hashes,
approved device public keys, pending enrollment requests, last-poll timestamps,
management audit events, and scheduled webpage capture state. R2 stores private
content-addressed PNG assets shared by uploads, Browser Run screenshots and
API rendered dashboards.
Devices keep their own private key; the Worker stores only its public key.

## Workers and environments

`wrangler.toml` defines the production device-sync Worker at
`ribbonfish.scheimann.workers.dev`. It sets `ADMIN_ENABLED = "false"`, so
`/admin/` and `/admin/api/*` return 404. Device sync and `/healthz` remain
available.

`wrangler.management.toml` defines the production management Worker named
`ribbonfish-mgmt`. It uses the live `ribbonfish-devices` D1 database and
`ribbonfish-assets` R2 bucket, with `ADMIN_ENABLED = "true"` and
`ADMIN_ACCESS_REQUIRED = "true"`. Cloudflare Access protects the Worker, and
the admin routes fail closed unless the Worker receives an Access identity
whose email is present in the `ADMIN_ALLOWED_EMAILS` Worker secret. The secret
is a comma-separated list of exact email addresses, matched without case
sensitivity; a missing or empty value denies all management access. Keep the
Cloudflare Access policy restricted to the same administrator group. Management
audit events record the authenticated email as the actor.

Set the allowlist on the management Worker before enabling admin access:

```sh
npx wrangler secret put ADMIN_ALLOWED_EMAILS --config wrangler.management.toml
```

`CAPTURE_ALLOWED_HOSTS` in `wrangler.management.toml` is empty by default, allowing
any hostname that passes the public HTTPS URL checks. Set it to a comma-separated
list of exact hostnames (no wildcards) to restrict capture targets. The hostname
is revalidated immediately before Browser Run starts. Browser navigation can also
follow redirects and load subresources; this Worker code cannot constrain those
later browser requests, so captured sites still need to be safe for the configured
Browser Run network. Confirm that the deployed Browser Run environment blocks
private and metadata addresses across redirects and subresources before
enabling capture.

There is no deployed development Worker. Local console development uses
Wrangler's `--local` mode with the management config, which keeps D1 and R2 data
in the local Wrangler state directory. The local command overrides Access checks
for localhost only.

## Local development

Install the pinned Wrangler dependency and run the tests and configuration
checks:

```sh
npm ci
npm run typecheck
npm test
npm run check:config
```

The type check emits temporary Worker declarations and checks TypeScript tests against Node globals, so Worker-only globals do not silently appear in the Node test environment. Worker sources are checked separately against Cloudflare bindings.

The type check verifies that the generated management Worker bindings match `wrangler.management.toml`. After changing those bindings, regenerate them with `npx wrangler types src/management-bindings.d.ts --config wrangler.management.toml --env-interface ManagementBindings --include-runtime=false --strict-vars=false`.

Initialize local D1, then start the local Worker:

```sh
npm run init:local
npm run dev
```

`npm run dev` places the panel files in local R2 storage before starting the
Worker. It bundles the browser app before publishing those files. Open
`http://localhost:8787/admin/`. Upload PNG files through the panel, stage a
playlist, then activate the revision. These commands use local D1 and R2 only.

The overview uses deterministic fleet findings for missing playlists, device
health and sync issues, active playlist assets, failed captures, unreviewed
schedules, and pending enrollments. Each finding includes its evidence, the
latest available timestamp, and a link to the relevant management list. The
overview reports when its snapshot was generated. The former fleet-wide model
advisory has been removed because its broad labels did not explain the signals
or provide a useful next step.

The fleet summary still uses an internal, read-only OpenUI program backed by
the framework-independent `@openuidev/lang-core` package. The management panel
does not expose the editor or generation prompt. JEV decisions use a separate
server-side adapter and do not generate or parse OpenUI Lang. The optional
per-target screenshot assessment uses bounded operational metadata and recent
screenshot hash-change counts. A pre-due shadow assessment also receives
measured Browser Run duration summaries, reserve coverage, attempt failures, and
retry counts. It validates JEV's answer types, choices, probabilities,
confidence, and score ranges, then renders the skip recommendation, a
plain-language risk level, and the server-gated reserve-review cue. JEV cannot change capture settings or
scheduling. It can suggest an operator review of the accounting reserve only
when at least 20 measured samples, 80% measured-header coverage, measured p90
at most half the reserve, and JEV confidence of at least 0.8 support the cue.
An admin may confirm a single skip for an exact upcoming due time; that confirmation
expires five minutes after the due time, is audited, and the following capture
remains scheduled. The skip is rejected for missing or stale screenshots,
recent failures, or active jobs. Screenshot pixels, raw error details, device
identifiers, playlist identifiers, and URL query or fragment values are not
sent to JEV.
Duration metrics are usage evidence, not proof that visible page content was
complete. The JEV reserve suggestion never applies a new value.

Configure `OPENROUTER_API_KEY` as a secret on the management Worker before using
JEV. The key is read only by the Worker. Requests use the pinned
`~typesafe/jev-latest` model and send structured state objects with server-owned
question schemas. The OpenUI fleet snapshot remains
read-only and deterministic; no OpenUI generation provider is configured. The
native DOM adapter is bundled with esbuild; no OpenUI framework renderer is
installed.

Background capture assessment runs in shadow mode when `CAPTURE_ANALYSIS_MODE` is
`shadow` on the scheduled management Worker. It assesses up to three active
playlist targets per tick during the five minutes before they are due and
stores one decision per target and due time for 30 days. Its bounded state
includes up to 500 duration attempts from the trailing 30-day review window,
split by measured, reserve-estimated, and unknown source, with measured p50/p90,
failure and retry counts, and readiness mode. The duration API includes the exact
admin-configured selector for each attempt; JEV receives only whether a selector
was configured. Decisions do not alter the capture
schedule or settings; errors leave the normal capture in place. The latest
assessment appears in each target's schedule details. The stored record
contains the bounded input summary, provider response and model for evaluation;
no screenshot pixels are sent. Apply migrations `0010_capture_decisions.sql`
and `0015_capture_duration_samples.sql` before deploying this code. Shadow
suggestions are not validated incident detection, and should not be used to
suppress captures until representative, labelled histories have been evaluated.

Background recommendations also require both JEV answer confidences to be at
least 0.8 in addition to the existing freshness, hash-stability, asset, and
error checks. Each scheduled job records its due time so a completed screenshot
can label the matching shadow suggestion as followed by changed or unchanged
content. Validator shortcuts, failures, and budget deferrals are reported
separately because they do not verify screenshot content. This feedback remains
advisory and never changes the next capture time. The management panel has a
separate Capture efficiency and Browser Run usage module that reports these
outcomes alongside daily accounted Browser Run time and total durations
across retries, separated between `X-Browser-Ms-Used` and the reserve estimate.
The module now also shows per-site measured p50/p90 and header coverage,
reserve-estimated totals, failure/retry counts, current reserve, readiness mode,
and a possible-overestimate review cue. The cue requires at least 20 measured
samples, 80% header coverage, and measured p90 at most half the configured
reserve. It is not an automatic reserve change. Existing jobs have no
per-attempt timing rows and remain unavailable to the duration API. Apply
migrations `0013_capture_efficiency_audit.sql` and
`0015_capture_duration_samples.sql` before deploying these changes.

Migration `0011_interval_defaults.sql` sets existing capture targets to 24 hours
and playlist rotations to 90 seconds. It assigns the active playlist a new
revision token so agents fetch the migrated rotation interval.

`init:local` is only for a fresh local database. It applies `schema.sql` and
records the migrations already represented by that schema. Production schema
changes use `npm run migrate:management`.
Migrations `0006_asset_reconciliation.sql` and `0007_capture_validators.sql` add
the asset registry and sweep cursors, then nullable source-validator metadata.
Apply migrations with `npm run migrate:management` before deploying code that
uses those features.

Migration `0008_device_health.sql` adds latest device reports, five-minute
history samples, and health transition events. Apply it with
`npm run migrate:management` before deploying device-health reporting.

Migration `0009_capture_skip_approvals.sql` adds one-time, due-time-bound
operator approvals for screenshot skips. Apply it with
`npm run migrate:management` before deploying code that confirms screenshot
skips.

Migration `0012_site_schedule_review.sql` records whether each site schedule
has been reviewed, while preserving existing sites as reviewed. Apply it with
`npm run migrate:management` before deploying the site-first admin flow.

Migration `0015_capture_duration_samples.sql` stores per-attempt Browser Run
duration, source, reserve snapshot, elapsed times, outcome, and readiness mode
for 90 days. Apply it with `npm run migrate:management` before deploying the
duration API, Capture Efficiency summary, or JEV duration advisory.

Migration `0016_capture_intervals.sql` adds the 3-hour and 12-hour screenshot
schedules while preserving existing capture targets and their related records.
Apply it with `npm run migrate:management` before deploying code that accepts
the expanded interval set.

API driven dashboards use the shared capture queue, target/history records, R2
asset store and playlist delivery flow. Uptime Kuma and Atlassian Statuspage
sources normalize into a common model and render to PNG with resvg WebAssembly
inside the management Worker. These captures bypass Browser Run budgets and
duration accounting. `API_STATUS_ALLOWED_HOSTS` is empty by default, allowing
hostnames that pass the adapter's syntax checks; a nonempty comma-separated
list restricts sources to those exact hostnames. The management Worker keeps
Cloudflare's `global_fetch_strictly_public` compatibility flag enabled for
public Internet routing. Apply
`0017_api_dashboards.sql` before deploying dashboard support. Setup, request
volume, source rules, rendering proof and limitations are in
[`docs/api-driven-dashboards.md`](../../docs/api-driven-dashboards.md).

The management config uses a remote Browser binding so screenshot Quick Actions
can run during local development. Queue messages and D1/R2 state remain local,
but Browser Run requests consume the configured Cloudflare account's usage.
The capture placeholder image is included when management assets are published.

The **Cloudflare Worker validation** GitHub workflow builds the console, runs
tests, and dry-runs both production Worker configurations. When Worker code,
management assets, Wrangler settings, or deployment build inputs are merged
into `main`, the **Deploy Ribbonfish Workers** GitHub workflow runs
automatically. It validates the production build, then deploys both Workers and
publishes the management panel to R2. It uses the repository secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; the deploy job only runs
from the protected default branch. You can also deploy explicitly from a
trusted local checkout with `npm run deploy:production` and
`npm run deploy:management`.

`npm run deploy:management` publishes the management panel to the production R2
bucket and deploys `wrangler.management.toml`. GitHub Actions does not apply D1
migrations. The deployment checks the production migration ledger and fails if repository migrations are pending or the ledger cannot be read. The Cloudflare token therefore needs D1 query access. The push to protected `main` deploys the Workers automatically, so
apply `npm run migrate:management` before merging code that depends on a new
migration. The Access policy is configured on the Worker in Cloudflare and must
stay enabled; `ADMIN_ACCESS_REQUIRED` also blocks `/admin/` and
`/admin/api/*` if an Access identity is missing.

Before the first capture deployment, create both production queues in the
Cloudflare account:

```sh
npx wrangler queues create ribbonfish-captures --config wrangler.management.toml
npx wrangler queues create ribbonfish-capture-dead-letter --config wrangler.management.toml
```

Then apply migrations `0005_webpage_capture.sql`, `0006_asset_reconciliation.sql`,
`0007_capture_validators.sql`, `0011_interval_defaults.sql`, and
`0016_capture_intervals.sql`, `0017_api_dashboards.sql`,
`0018_api_dashboard_metrics.sql`, and `0019_capture_queue_recovery.sql` with
`npm run migrate:management` before deploying code that depends on them. For a
new environment, enable captures only after the Browser Run binding, queues,
host allowlist, and account quotas are ready.

Capture application retries and interrupted queue deliveries are staged in D1
with bounded backoff, then published by the once-per-minute scheduled dispatcher
to `ribbonfish-captures`. The dead-letter queue consumer only records recovery
state; it never renders or captures. Keep the main consumer at batch size one
and concurrency one so scheduled, manual, and recovered work all use the same
serial capture path. The management dashboard marks captures stale after two
missed intervals and shows pending recovery attempts.

## Management API

All management routes require `ADMIN_ENABLED = "true"`. The production
management Worker additionally requires a Cloudflare Access identity for every
`/admin/` and `/admin/api/*` request, and the identity email must appear in
`ADMIN_ALLOWED_EMAILS`. Restrict the external Access policy to the intended
administrators as well. The local Worker disables that check only while running
in Wrangler's local mode.

| Method and path | Behavior |
| --- | --- |
| `GET /admin/` | Browser management panel |
| `GET /admin/api/overview` | Devices, playlist revisions, current pointer, missing active assets, unresolved asset integrity issues, recent audit events, and capture usage forecast |
| `GET /admin/api/capture-forecast` | Current daily Ribbonfish Browser Run usage, free-plan quota, and per-site forecast; read-only |
| `GET /admin/api/captures/{capture_id}/duration-samples` | Bounded per-attempt Browser Run duration samples and source-separated summary; read-only |
| `GET /admin/api/intervals` | Supported screenshot and rotation interval values and defaults |
| `GET /admin/api/devices/{device_id}/health` | Latest validated report, current derived health status, and up to 50 recent health transitions |
| `GET /admin/api/devices/{device_id}/health-history?limit=100&since={unix_ms}` | Five-minute health samples and health transitions; default window is 30 days, maximum 500 rows per stream |
| `GET /admin/api/enrollment-requests` | List unexpired pending device requests, including the physical fingerprint |
| `POST /admin/api/enrollment-requests/{request_id}/approve` | Approve the exact pending public key; body: `{}` |
| `POST /admin/api/enrollment-requests/{request_id}/reject` | Reject the exact pending request; body: `{}` |
| `POST /admin/api/enrollment-codes` | Legacy provisioning API; create a one-time code with `{"expires_in_minutes":30}` |
| `PATCH /admin/api/devices/{device_id}` | Enable or disable a device; body: `{"enabled":false}` |
| `DELETE /admin/api/devices/{device_id}` | Permanently remove a device and its health history; pending enrollment requests for its ID are rejected |
| `POST /admin/api/devices/{device_id}/rotate` | Replace a legacy device token and return it once; key-based devices use a new approval to change identity |
| `POST /admin/api/assets` | Upload one PNG body with `Content-Type: image/png`; returns its SHA-256 and byte size |
| `GET /admin/api/assets/{sha256}` | Preview a PNG that is referenced by a playlist revision |
| `POST /admin/api/capture-sites` | Register a URL and viewport independently; new sites start with the default daily schedule pending review |
| `DELETE /admin/api/captures/{capture_id}` | Remove a site from management and stop queued or future screenshots; existing playlist images and capture history remain |
| `POST /admin/api/playlists` | Stage an immutable playlist revision with PNG assets and/or reviewed capture site IDs |
| `POST /admin/api/captures/{capture_id}/run` | Queue a capture now; normal queue, rate, and budget controls still apply |
| `PATCH /admin/api/captures/{capture_id}` | Review or change a target schedule; body: `{"capture_interval_seconds":21600}` |
| `PATCH /admin/api/captures/{capture_id}/readiness` | Set or clear an optional CSS readiness selector without changing its schedule; body: `{"wait_for_selector":"main .ready"}` |
| `GET /admin/api/playlists/{playlist_id}/{revision}` | Read a revision and its ordered image and capture references for editing |
| `DELETE /admin/api/playlists/{playlist_id}` | Delete all revisions of an inactive playlist and its D1 image references; the active playlist is protected |
| `PUT /admin/api/active-playlist` | Activate or roll back to an existing revision; body: `{"playlist_id":"operations","revision":"r-…"}` |
| `GET /healthz` | Minimal readiness check; returns 503 if the active playlist or any referenced R2 object is missing |

`GET /admin/api/capture-forecast` returns `generated_at`, `plan`, `quota_scope`,
`other_account_usage_included`, `daily_usage`, and a `forecast` object. The
forecast includes a daily total, completeness flag, quota and Worker-budget
limits, and one entry per reviewed site in the active playlist. Each entry
reports its interval, expected captures per day, runtime estimate, sample count,
runtime source, and predicted milliseconds per day. The runtime is the average
of that site's retained successful screenshot samples (up to 10 per site and
30 days). Sites without samples use the active sites' weighted runtime average;
the forecast stays incomplete until some active site has a sample. Changing a
site interval through `PATCH /admin/api/captures/{capture_id}` changes the next
forecast response. The overview API includes the same projection under
`capture_efficiency.forecast`.

The free-plan allowance is 600,000 ms per UTC day. The reported `daily_usage`
and projection cover Ribbonfish's captures only; Cloudflare shares browser
hours across the account, and usage from other Browser Run workloads is not
included. The projection assumes every scheduled capture starts Browser Run;
trusted unchanged validators may reduce real usage, while manual runs and
failures can increase it. Cloudflare's Browser Run dashboard remains the
account-wide source of actual usage.

`GET /admin/api/captures/{capture_id}/duration-samples` accepts `since` as Unix
milliseconds, `limit` from 1 to 100, and the paired pagination cursor
`before` plus `before_sample_id`. `since` is clamped to the retained 90-day
window. The response includes one row for every attempt that started Browser
Run, including failed attempts, measured or reserve-estimated milliseconds,
the reserve value in force, Browser Run and capture elapsed time, readiness
mode and configured selector, and outcome. Validator hits and budget deferrals
do not start Browser Run and therefore do not create duration rows. Its source-separated summary is
capped at 50,000 rows and reports whether the cap was reached. The overview's
per-site duration summary covers the most recent 30 days.

`browser_ms` is the Browser Run usage header or the configured reserve fallback.
`browser_run_elapsed_ms` is Worker-measured wall time around the Quick Action;
`capture_elapsed_ms` also includes receiving and storing the screenshot. Neither
includes queue wait, and none of these timing values proves that important page
content had finished rendering. To establish a safe faster readiness policy,
compare repeated candidate screenshots with a reviewed settled screenshot and
check the page-specific content that must be visible.

`GET /admin/api/intervals` returns the seven supported values and defaults:
capture values are 900, 1800, 3600, 10800, 21600, 43200, and 86400 seconds (default 86400);
rotation values are `30s`, `60s`, `90s`, `120s`, and `5m` (default `90s`).
Playlist staging accepts `rotation_interval` and defaults it to `90s` when
omitted. Register a site first with `POST /admin/api/capture-sites`, then review
or amend its schedule with `PATCH /admin/api/captures/{capture_id}`; saving the
default interval confirms the schedule. Playlist staging accepts existing
`capture_id` values only after their schedules have been reviewed. The target is
shared by every playlist revision that references the same canonical URL and
screenshot size, so changing its interval changes that shared schedule. The
shortest supported interval is 15 minutes
(up to 96 captures per target per day); frequent schedules share the daily
browser runtime budget and queue capacity. To change rotation, stage a new
playlist revision with the desired value and activate it with
`PUT /admin/api/active-playlist`. Read current values through the overview,
playlist revision, or device playlist APIs.

Each site can optionally set a CSS selector that Browser Run waits for before
taking the screenshot. Leave it blank to keep the existing
`domcontentloaded` behavior. Use a selector only when it marks the content that
must be visible; waiting for that element does not change the capture interval.

The Sites section manages page URLs and schedules independently. Playlist
editing selects from reviewed sites in that library. Registering a site does
not start scheduled captures; the Worker schedules targets referenced by the
active playlist. Removing a site disables its scheduler and hides it from the
library while retaining saved playlist images and capture history. Registering
the same URL and screenshot size again restores the site and its existing
schedule.

Playlist staging verifies every referenced object exists in R2 with the declared
size. A webpage slot references a reusable URL/viewport capture target and
starts with a bundled holding PNG. The first scheduled capture runs after the
playlist is activated. The Worker only schedules targets referenced by the
active playlist. Capture settings accept public HTTPS URLs without embedded
credentials, intervals of 900, 1800, 3600, 10800, 21600, 43200, or 86400 seconds, and viewports up to
3840×2160. Authenticated pages and browser interaction are not supported.

Activation updates the single global pointer only after a revision exists.
Editing a revision creates a new immutable revision. You can keep or remove its
existing images and webpage items, then add uploads or reviewed sites; the source
revision stays unchanged. Uploads, holding images, and screenshots share the
same PNG validation, SHA-256 naming, size limit, and R2 storage helper. When a
capture succeeds, the playlist slot points at the new digest, so devices receive
a changed playlist ETag and download the screenshot through their existing
asset route. Failed captures keep displaying the last successful image. Each
target retains at most 10 images for up to 30 days, then returns to its holding
image.

Cron runs each minute and queues due captures from D1. Leased, cursor-based asset
reconciliation checks up to 40 R2 objects and 40 distinct D1 references per
pass, then resumes from the saved cursors on the next minute until both
inventories are scanned. After a complete scan it waits 15 minutes before
starting another by default (`ASSET_RECONCILIATION_INTERVAL_SECONDS`); history
cleanup runs when a scan completes. Set the variable to `0` to scan continuously.
This reduces repeated full-inventory work when the bucket is small while keeping
large scans moving one bounded page per minute. It checks
all playlist revisions plus holding/current images and capture history. Untracked
legacy objects get a 24-hour grace period; unattached uploads are staged for up
to seven days. Missing current screenshots are cleared, a missing holding PNG is
restored when the published source matches its recorded hash and size, and
missing playlist images appear as integrity issues without changing immutable
revisions. It handles up to three missing D1 references per pass and resumes
before any remaining issues. R2 deletion failures remain claimed and are retried
on later passes.
The consumer uses one message and one concurrent capture, coalesces each target
to one open job, caps pending jobs at 100, spaces Browser Run requests by 10
seconds, and applies a daily browser-time budget (10 minutes by default,
reserving 60 seconds for a capture when Browser Run usage is unavailable).
Transient errors retry at
60 and 180 seconds; budget/rate deferrals wait for a later Cron tick. Check
current account Browser Run quotas before enabling production capture.
Deleting a playlist removes its revisions and image references from D1, while
content-addressed PNG objects remain in R2 for reuse. The UI uses text-only DOM
rendering and applies a restrictive content security policy. The approval UI
shows the complete device fingerprint and asks the operator to compare it with
the code physically displayed by that device. Approval binds that exact key to
the device ID, disables any previous token for that device, and records an
audit event. Rejection leaves the device unable to sync. Secrets and raw public
keys are never returned by management APIs or written to audit metadata.

Device sync and health reporting use the following device API:

- `POST /v1/enrollment-requests` verifies a request signed by the device's
  Ed25519 key and creates or polls a pending approval. It grants no content
  access. Pending requests expire after 24 hours; the device retries with the
  same identity. Enrollment requests are rate limited to 30 per minute per
  source IP as an abuse-control measure.
- `GET /v2/playlist` returns the active playlist with conditional ETags.
- `GET /v2/assets/{sha256}` returns an asset only when it is in the active playlist.
- `POST /v1/telemetry` accepts an authenticated, schema-versioned health report up to 8 KiB. Reports include agent lifecycle/version, sync status and applied revision, per-display connector and last-frame status, and optional host uptime, one-minute load, available memory, state-volume free space, and CPU temperature. Error fields use a fixed code list; reports never include logs, credentials, or raw error text.

Agents send a report at startup, after a health transition, once every five minutes, and
at shutdown when they can reach the Worker. The management Worker timestamps
receipt, keeps the latest report, records at most one sample per five-minute
bucket, and stores transition/restart events. Samples and events older than 30
days are removed by the hourly scheduled cleanup. Dashboard health is derived
from server receipt time: a report is stale after 15 minutes and offline after 25
minutes; reported output or sync failures show as degraded. Disabled devices
show as disabled, and devices that have never reported show as unknown.
The one-minute scheduled pass records stale/offline transitions and the next
report records recovery in that same event history.

Playlist polling updates device `last_seen_at` at most once every five minutes.
For static playlists, a matching ETag is checked from the active playlist row
and capture-slot existence before loading the asset lists; dynamic capture
playlists still resolve their current screenshot state before returning `304`.

Before every capture, the Worker sends a bounded `HEAD` request to the recorded
target URL with its saved ETag and Last-Modified validators. Any recorded target
whose URL passes `CAPTURE_ALLOWED_HOSTS` is checked; no separate validator-host
configuration is required. Browser Run is skipped only when the response says
the resource is unchanged and the current R2 image is present and intact.
Redirects, errors, missing validators, changed validators, and missing or
inconsistent cached images fall back to a screenshot. A validator may not track
all changes that affect a rendered page, so validator-only results are reported
separately from screenshot-verified outcomes.

The management UI uses private browser caching: HTML is fresh for 60 seconds,
JavaScript and CSS for five minutes, and the holding image for one hour. Each
asset has an R2 ETag; stale browser entries can revalidate with a metadata-only
R2 `HEAD` and receive `304` without reading the object body. API responses remain
`no-store`, and private assets are not shared through a public edge cache.

New devices enroll automatically when `RIBBONFISH_SYNC_URL` and
`RIBBONFISH_DEVICE_ID` are configured and no legacy device token exists. The
agent creates a persistent Ed25519 identity in `/var/lib/ribbonfish/device-key`
with mode `0600`, displays the device ID and grouped fingerprint on its output,
and retries the signed request if the Worker is temporarily unreachable. An
operator opens the production console, compares the complete fingerprint with
the physical display, then approves or rejects the request. After approval the
device begins polling and downloads the active playlist. Existing token-based
devices continue to work with their token file. If an existing device has lost
that file, its new key request is marked as a replacement in the console, and
approval replaces the token with key-based authentication. Legacy
`POST /v1/enroll` remains available for devices already provisioned with
one-time codes.

The rate-limit binding uses Cloudflare's per-location rate limiter, which is
approximate rather than a globally exact quota. It complements signature
validation and the approval step.

Playlist polling updates `devices.last_seen_at`. This is a timestamp of the most
recent poll, not a persistent connection or a precise online/offline signal.

## Playlist publishing

The panel can stage and activate playlist revisions. A trusted Wrangler script
is also available for scripted releases:

```sh
node scripts/publish-playlist.ts defaults/default-playlist.json --activate \
  --config wrangler.management.toml \
  --database ribbonfish-devices \
  --bucket ribbonfish-assets
```

The script calculates SHA-256 hashes and sizes, uploads immutable objects under
`assets/<sha256>`, and records a new D1 revision before moving the active
pointer. Objects stay available while any revision references them. The
scheduled asset sweep removes an object after its final D1 reference is removed.

## Existing fleet provisioning

For the existing fleet environment, apply the current migration after the
previous migrations have been recorded:

```sh
npx wrangler --config wrangler.management.toml d1 migrations apply ribbonfish-devices --remote
```

Migration `0004_pending_device_enrollment.sql` adds public-key device auth and
the pending-request table while preserving existing token-authenticated
devices. Apply it before deploying the code. The sync Worker keeps management
routes disabled; the production management Worker enables them behind
Cloudflare Access.

To issue or revoke a device manually, use the production management panel. Keep
the D1 database private and do not paste enrollment codes or device tokens into
logs, issues, or chat.
