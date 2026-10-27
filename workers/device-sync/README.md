# Ribbonfish device sync and management Worker

The Worker serves one globally active playlist to enrolled devices. D1 stores
versioned playlists, the active-playlist pointer, device credential hashes,
one-time enrollment codes, last-poll timestamps, and development management
events. R2 stores private content-addressed PNG assets. Devices receive only
their application credential; they never receive a Cloudflare account token.

## Status and environments

`wrangler.toml` points to the existing fleet Worker and its D1/R2 resources. It
sets `ADMIN_ENABLED = "false"`, so `/admin/` and `/admin/api/*` return 404.
Device sync and `/healthz` remain available.

`wrangler.dev.toml` points to separate development D1 and R2 resources and sets
`ADMIN_ENABLED = "true"`. The panel has no administrator authentication yet and
is available through a public Workers URL when deployed. Use only development
data there. Audit rows use `actor_id = "anonymous"`; they record actions but do
not identify who performed them. Add administrator authentication and an
attributable actor before enabling the API against production fleet data. The
panel files live in the private development R2 bucket and are returned only by
the Worker's fixed `/admin/` routes.

The existing GitHub `docker` environment is reserved for the Docker Hub image
publisher. Worker deployment uses the separate `cloudflare-dev` environment and
requires a `CLOUDFLARE_API_TOKEN` secret. The account ID and development resource
IDs are in the Wrangler configurations; no Cloudflare credential is stored in
the repository.

## Local development

Install the pinned Wrangler dependency and run the tests and configuration
checks:

```sh
npm ci
npm test
npm run check:config
```

Initialize local D1, then start the local development Worker:

```sh
npm run init:dev-local
npm run dev
```

`npm run dev` places the panel files in the local R2 emulator before starting
the Worker. It bundles the browser app before publishing those files. Open
`http://localhost:8787/admin/`. Upload PNG files through the panel, stage a
playlist, then activate the revision.

The panel's OpenUI Lang view uses only the framework-independent
`@openuidev/lang-core` package. Its custom-view editor can parse and preview
OpenUI programs and copy a generated prompt for use with an external model. The
view exposes only the read-only fleet overview query; it does not execute
OpenUI mutations or actions. The native DOM adapter is bundled with esbuild;
no OpenUI framework renderer is installed.

For a fresh remote development database, initialize its schema and migration
ledger once, then upload the bundled default playlist:

```sh
npm run init:dev-remote
npm run seed:dev-remote
```

`init:dev-local` and `init:dev-remote` are bootstrap commands for a fresh
 database. They apply `schema.sql` and record the migrations already represented
by that schema. For an existing database, use `npm run migrate:dev-remote` or
apply the migration files in order with Wrangler.

Deploy the isolated development Worker from a local authenticated Wrangler
session with `npm run deploy:dev`; this uploads the panel files to development
R2 before deploying the Worker. Or run the manual **Cloudflare device sync
Worker** GitHub workflow. For the workflow, create the `cloudflare-dev` GitHub
environment and add its `CLOUDFLARE_API_TOKEN` secret. The workflow runs tests
and configuration validation before deploying only `wrangler.dev.toml`.

The default `wrangler.toml` config is the existing fleet environment. Do not
use `npm run deploy:production` until administrator authentication and a
production rollout plan are in place.

## Management API

All management routes require `ADMIN_ENABLED = "true"`. They are intentionally
unauthenticated during pre-production and must stay on the isolated development
Worker.

| Method and path | Behavior |
| --- | --- |
| `GET /admin/` | Browser management panel |
| `GET /admin/api/overview` | Devices, playlist revisions, current pointer, missing active assets, and recent audit events |
| `POST /admin/api/enrollment-codes` | Create a one-time code; body: `{"expires_in_minutes":30}`; plaintext code is returned once |
| `PATCH /admin/api/devices/{device_id}` | Enable or disable a device; body: `{"enabled":false}` |
| `POST /admin/api/devices/{device_id}/rotate` | Replace a device token and return the new token once; body: `{}` |
| `POST /admin/api/assets` | Upload one PNG body with `Content-Type: image/png`; returns its SHA-256 and byte size |
| `POST /admin/api/playlists` | Stage an immutable playlist revision; body includes `id`, `rotation_interval`, and ordered `{sha256,size}` asset references |
| `PUT /admin/api/active-playlist` | Activate or roll back to an existing revision; body: `{"playlist_id":"operations","revision":"r-…"}` |
| `GET /healthz` | Minimal readiness check; returns 503 if the active playlist or any referenced R2 object is missing |

Playlist staging verifies every referenced object exists in R2 with the declared
size. Activation updates the single global pointer only after a revision exists.
The UI uses text-only DOM rendering and applies a restrictive content security
policy. Enrollment codes and rotated device tokens are never written to audit
metadata.

Device sync remains:

- `POST /v1/enroll` exchanges a one-time enrollment code for a random device token.
- `GET /v2/playlist` returns the active playlist with conditional ETags.
- `GET /v2/assets/{sha256}` returns an asset only when it is in the active playlist.

Playlist polling updates `devices.last_seen_at`. This is a timestamp of the most
recent poll, not a persistent connection or a precise online/offline signal.

## Playlist publishing

The panel can stage and activate playlist revisions. A trusted Wrangler script
is also available for scripted releases:

```sh
node scripts/publish-playlist.mjs defaults/default-playlist.json --activate \
  --config wrangler.dev.toml \
  --database ribbonfish-management-dev \
  --bucket ribbonfish-management-dev
```

The script calculates SHA-256 hashes and sizes, uploads immutable objects under
`assets/<sha256>`, and records a new D1 revision before moving the active
pointer. Older revisions and objects are retained; playlist asset garbage
collection is not implemented.

## Existing fleet provisioning

For the existing fleet environment, apply the current migration after the
previous migrations have been recorded:

```sh
npx wrangler --config wrangler.toml d1 migrations apply ribbonfish-devices --remote
```

The new migration adds last-poll telemetry and the management audit table. The
production management API remains disabled by the checked-in configuration.

To issue or revoke a device manually, use the development panel. For existing
fleet operations, keep the D1 database private and do not paste enrollment
codes or device tokens into logs, issues, or chat.
