# Ribbonfish device sync and management Workers

The Worker serves one globally active playlist to enrolled devices. D1 stores
versioned playlists, the active-playlist pointer, device credential hashes,
one-time enrollment codes, last-poll timestamps, and management audit events.
R2 stores private content-addressed PNG assets. Devices receive only
their application credential; they never receive a Cloudflare account token.

## Workers and environments

`wrangler.toml` defines the production device-sync Worker at
`ribbonfish.scheimann.workers.dev`. It sets `ADMIN_ENABLED = "false"`, so
`/admin/` and `/admin/api/*` return 404. Device sync and `/healthz` remain
available.

`wrangler.management.toml` defines the production management Worker named
`ribbonfish-mgmt`. It uses the live `ribbonfish-devices` D1 database and
`ribbonfish-assets` R2 bucket, with `ADMIN_ENABLED = "true"` and
`ADMIN_ACCESS_REQUIRED = "true"`. Cloudflare Access protects the Worker, and
the admin routes fail closed unless the Worker receives an Access identity.
Management audit events record the authenticated email as the actor.

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

The **Cloudflare Worker validation** GitHub workflow builds the console, runs
tests, and dry-runs both production Worker configurations. It does not deploy.
Deploy the Workers explicitly with `npm run deploy:production` and
`npm run deploy:management`.

`npm run deploy:management` publishes the management panel to the production R2
bucket and deploys `wrangler.management.toml`. Run `npm run migrate:management`
before deployment when migrations change. The Access policy is configured on
the Worker in Cloudflare and must stay enabled; `ADMIN_ACCESS_REQUIRED` also
blocks `/admin/` and `/admin/api/*` if an Access identity is missing.

## Management API

All management routes require `ADMIN_ENABLED = "true"`. The production
management Worker additionally requires a Cloudflare Access identity for every
`/admin/` and `/admin/api/*` request. Its Access policy is limited to members of
the Cloudflare account. The local Worker disables that check only while running
in Wrangler's local mode.

| Method and path | Behavior |
| --- | --- |
| `GET /admin/` | Browser management panel |
| `GET /admin/api/overview` | Devices, playlist revisions, current pointer, missing active assets, and recent audit events |
| `POST /admin/api/enrollment-codes` | Create a one-time code; body: `{"expires_in_minutes":30}`; plaintext code is returned once |
| `PATCH /admin/api/devices/{device_id}` | Enable or disable a device; body: `{"enabled":false}` |
| `POST /admin/api/devices/{device_id}/rotate` | Replace a device token and return the new token once; body: `{}` |
| `POST /admin/api/assets` | Upload one PNG body with `Content-Type: image/png`; returns its SHA-256 and byte size |
| `GET /admin/api/assets/{sha256}` | Preview a PNG that is referenced by a playlist revision |
| `POST /admin/api/playlists` | Stage an immutable playlist revision; body includes `id`, `rotation_interval`, and ordered `{sha256,size}` asset references |
| `GET /admin/api/playlists/{playlist_id}/{revision}` | Read a revision and its ordered image references for editing |
| `DELETE /admin/api/playlists/{playlist_id}` | Delete all revisions of an inactive playlist and its D1 image references; the active playlist is protected |
| `PUT /admin/api/active-playlist` | Activate or roll back to an existing revision; body: `{"playlist_id":"operations","revision":"r-…"}` |
| `GET /healthz` | Minimal readiness check; returns 503 if the active playlist or any referenced R2 object is missing |

Playlist staging verifies every referenced object exists in R2 with the declared
size. Activation updates the single global pointer only after a revision exists.
Editing a revision creates a new immutable revision. You can keep or remove its
existing images and add uploaded PNGs; the source revision stays unchanged.
Deleting a playlist removes its revisions and image references from D1, while
content-addressed PNG objects remain in R2 for reuse. The UI uses text-only DOM
rendering and applies a restrictive content security policy. Enrollment codes
and rotated device tokens are never written to audit metadata.

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
  --config wrangler.management.toml \
  --database ribbonfish-devices \
  --bucket ribbonfish-assets
```

The script calculates SHA-256 hashes and sizes, uploads immutable objects under
`assets/<sha256>`, and records a new D1 revision before moving the active
pointer. Older revisions and objects are retained; playlist asset garbage
collection is not implemented.

## Existing fleet provisioning

For the existing fleet environment, apply the current migration after the
previous migrations have been recorded:

```sh
npx wrangler --config wrangler.management.toml d1 migrations apply ribbonfish-devices --remote
```

The new migration adds last-poll telemetry and the management audit table. The
sync Worker keeps management routes disabled; the production management Worker
enables them behind Cloudflare Access.

To issue or revoke a device manually, use the production management panel. Keep
the D1 database private and do not paste enrollment codes or device tokens into
logs, issues, or chat.
