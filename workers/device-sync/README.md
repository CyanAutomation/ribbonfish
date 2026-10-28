# Ribbonfish device sync and management Workers

The Worker serves one globally active playlist to enrolled devices. D1 stores
versioned playlists, the active-playlist pointer, legacy credential hashes,
approved device public keys, pending enrollment requests, last-poll timestamps,
management audit events, and scheduled webpage capture state. R2 stores private
content-addressed PNG assets shared by uploads and Browser Run screenshots.
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

Capture targets also fail closed unless their exact hostnames are listed in
`CAPTURE_ALLOWED_HOSTS` in `wrangler.management.toml` (comma-separated, with no
wildcards). The checked hostname is revalidated immediately before Browser Run
starts. The list is empty by default. Browser navigation can also follow
redirects and load subresources; this Worker code cannot constrain those later
browser requests, so allowlisted sites still need to be safe for the configured
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
npm test
npm run check:config
```

Initialize local D1, then start the local Worker:

```sh
npm run init:local
npm run dev
```

`npm run dev` places the panel files in local R2 storage before starting the
Worker. It bundles the browser app before publishing those files. Open
`http://localhost:8787/admin/`. Upload PNG files through the panel, stage a
playlist, then activate the revision. These commands use local D1 and R2 only.

The panel's OpenUI Lang view uses only the framework-independent
`@openuidev/lang-core` package. Its custom-view editor can parse and preview
OpenUI programs and copy a generated prompt for use with an external model. The
view exposes only the read-only fleet overview query; it does not execute
OpenUI mutations or actions. The native DOM adapter is bundled with esbuild;
no OpenUI framework renderer is installed.

`init:local` is only for a fresh local database. It applies `schema.sql` and
records the migrations already represented by that schema. Production schema
changes use `npm run migrate:management`.
Migrations `0006_asset_reconciliation.sql` and `0007_capture_validators.sql` add
the asset registry and sweep cursors, then nullable source-validator metadata.
Apply migrations with `npm run migrate:management` before deploying code that
uses those features.

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
migrations. The push to protected `main` deploys the Workers automatically, so
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
and `0007_capture_validators.sql` with `npm run migrate:management` before
deploying the corresponding code. This implementation has not been deployed to
production; enable capture only after the Browser Run binding and account quotas
are available.

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
| `GET /admin/api/overview` | Devices, playlist revisions, current pointer, missing active assets, unresolved asset integrity issues, and recent audit events |
| `GET /admin/api/enrollment-requests` | List unexpired pending device requests, including the physical fingerprint |
| `POST /admin/api/enrollment-requests/{request_id}/approve` | Approve the exact pending public key; body: `{}` |
| `POST /admin/api/enrollment-requests/{request_id}/reject` | Reject the exact pending request; body: `{}` |
| `POST /admin/api/enrollment-codes` | Legacy provisioning API; create a one-time code with `{"expires_in_minutes":30}` |
| `PATCH /admin/api/devices/{device_id}` | Enable or disable a device; body: `{"enabled":false}` |
| `POST /admin/api/devices/{device_id}/rotate` | Replace a legacy device token and return it once; key-based devices use a new approval to change identity |
| `POST /admin/api/assets` | Upload one PNG body with `Content-Type: image/png`; returns its SHA-256 and byte size |
| `GET /admin/api/assets/{sha256}` | Preview a PNG that is referenced by a playlist revision |
| `POST /admin/api/playlists` | Stage an immutable playlist revision with PNG assets and/or webpage captures |
| `POST /admin/api/captures/{capture_id}/run` | Queue a capture now; normal queue, rate, and budget controls still apply |
| `GET /admin/api/playlists/{playlist_id}/{revision}` | Read a revision and its ordered image and capture references for editing |
| `DELETE /admin/api/playlists/{playlist_id}` | Delete all revisions of an inactive playlist and its D1 image references; the active playlist is protected |
| `PUT /admin/api/active-playlist` | Activate or roll back to an existing revision; body: `{"playlist_id":"operations","revision":"r-…"}` |
| `GET /healthz` | Minimal readiness check; returns 503 if the active playlist or any referenced R2 object is missing |

Playlist staging verifies every referenced object exists in R2 with the declared
size. A webpage slot references a reusable URL/viewport capture target and
starts with a bundled holding PNG. The first scheduled capture runs after the
playlist is activated. The Worker only schedules targets referenced by the
active playlist. Capture settings accept public HTTPS URLs without embedded
credentials, intervals from 60 seconds to 30 days, and viewports up to
3840×2160. Authenticated pages and browser interaction are not supported.

Activation updates the single global pointer only after a revision exists.
Editing a revision creates a new immutable revision. You can keep or remove its
existing images and webpage items, then add uploads or URLs; the source
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
seconds, and applies a daily browser-time budget (9 minutes by default,
reserving 45 seconds for a capture when Browser Run usage is unavailable).
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

Device sync remains:

- `POST /v1/enrollment-requests` verifies a request signed by the device's
  Ed25519 key and creates or polls a pending approval. It grants no content
  access. Pending requests expire after 24 hours; the device retries with the
  same identity. Enrollment requests are rate limited to 30 per minute per
  source IP as an abuse-control measure.
- `GET /v2/playlist` returns the active playlist with conditional ETags.
- `GET /v2/assets/{sha256}` returns an asset only when it is in the active playlist.

Playlist polling updates device `last_seen_at` at most once every five minutes.
For static playlists, a matching ETag is checked from the active playlist row
and capture-slot existence before loading the asset lists; dynamic capture
playlists still resolve their current screenshot state before returning `304`.

Capture targets can avoid Browser Run when a source has a validator that is known
to represent the rendered screenshot. Add exact hostnames to the comma-separated
`CAPTURE_VALIDATOR_HOSTS` Worker variable to opt those sources in. The Worker
sends a bounded `HEAD` request with saved ETag/Last-Modified validators and skips
Browser Run only on an unchanged response while the current R2 image is present.
Unapproved hosts, redirects, errors, missing validators, and changed validators
fall back to a screenshot. Only opt in sources whose owners guarantee those
headers track screenshot changes; this is disabled by default.

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
node scripts/publish-playlist.mjs defaults/default-playlist.json --activate \
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
