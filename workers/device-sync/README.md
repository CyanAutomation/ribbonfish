# Ribbonfish playlist sync Worker

The Worker serves one globally active playlist to every enrolled device. D1
stores versioned playlists, one active playlist pointer, device token hashes,
and one-time enrollment code hashes. The R2 bucket stores private,
content-addressed image objects. The agent receives only its application
credential; it never receives a Cloudflare account credential.

## Development

Run the Worker unit tests with Node.js (no package install is required):

```sh
npm test
```

Create the Cloudflare resources and apply the current schema:

```sh
npx wrangler r2 bucket create ribbonfish-assets
npx wrangler d1 create ribbonfish-devices
npx wrangler d1 execute ribbonfish-devices --remote --file=schema.sql
node scripts/publish-playlist.mjs defaults/default-playlist.json --activate
npx wrangler deploy
```

For an existing database created by the earlier device-manifest Worker, apply
the migrations in order. Skip a migration if its change is already present:

```sh
npx wrangler d1 execute ribbonfish-devices --remote --file=migrations/0001_add_enrollment_claim_id.sql
npx wrangler d1 execute ribbonfish-devices --remote --file=migrations/0002_global_playlists.sql
```

## Publish and activate playlists

The Worker has no playlist write endpoint. Playlist releases use the trusted
Wrangler process in `scripts/publish-playlist.mjs`. The repository ships a
default playlist containing all four bundled sample images. The setup command
above uploads the starter images and makes that playlist active before deploy.

To publish another playlist, create a JSON file with an ID, rotation interval,
and ordered paths to image files. Paths are relative to the JSON file:

```json
{
  "id": "operations",
  "rotation_interval": "20s",
  "assets": [
    { "path": "./images/overview.png" },
    { "path": "./images/service-health.png" }
  ]
}
```

Publish a staged revision without changing what devices display:

```sh
node scripts/publish-playlist.mjs playlists/operations.json
```

When it is ready, activate it by publishing a fresh revision with `--activate`:

```sh
node scripts/publish-playlist.mjs playlists/operations.json --activate
```

For a single-step release, run the command with `--activate` once. Each command
creates a new immutable playlist revision. The script calculates SHA-256 hashes
and sizes, uploads immutable images to `assets/<lowercase-sha256>`, and stores a
new revision in D1. With `--activate`, it then updates the single active pointer.
Content is stored before the active pointer changes. Re-publishing an existing
playlist ID creates a new revision; older revisions remain in D1 and their
content-addressed objects remain in R2. All enrolled devices see the new active
revision on their next poll.
Use `--database NAME` and `--bucket NAME` when publishing to a different
Wrangler environment.

Agent polls use `GET /v2/playlist`, conditional ETags, and
`X-Ribbonfish-Device-ID`. The playlist response contains the playlist ID,
rotation interval, and ordered image hashes and sizes. The Worker serves an
image only if its hash appears in the active playlist revision. If the active
playlist changes during a download, the agent rejects the incomplete candidate,
keeps its last-good playlist, and retries against the new active revision.

## Enroll and revoke devices

Generate a one-time code and insert only its hash into D1:

```sh
node scripts/make-enrollment-code.mjs 30
npx wrangler d1 execute ribbonfish-devices --remote --command "INSERT INTO enrollments (code_hash, expires_at) VALUES ('<printed-hash>', <printed-expiry-ms>);"
```

Deliver the printed code privately to the Pi. Set `RIBBONFISH_SYNC_URL`,
`RIBBONFISH_DEVICE_ID`, and `RIBBONFISH_NETWORK_MODE=bridge`, then exchange the
code through stdin:

```sh
read -r -s -p 'One-time code: ' enrollment_code
printf '\n'
printf '%s' "$enrollment_code" | docker compose run --rm -T agent -enroll
unset enrollment_code
```

The agent writes the returned random token to
`/var/lib/ribbonfish/device-token` with mode `0600`. The Worker stores only the
token hash. After enrollment, configure the Worker URL and device ID, leave the
token in the named state volume, and restart the service.

Revoke a device by disabling its row:

```sql
UPDATE devices SET enabled = 0 WHERE device_id = 'pi-office';
```

Keep enrollment codes, device tokens, and the D1 database private. Playlist
publishing is a trusted release operation; the Worker exposes no playlist
write, `PUT`, `DELETE`, list, or arbitrary object-key endpoint.
