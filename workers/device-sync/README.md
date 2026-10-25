# Ribbonfish device sync Worker

This Worker serves device-scoped manifests and private image objects from a bound R2 bucket. Device token hashes and one-time enrollment code hashes live in D1. The Pi receives only an application credential; it never receives an R2 or Cloudflare API credential.

## Development

Run the Worker unit tests with Node.js (no package install is required):

```sh
npm test
```

Create the Cloudflare resources, update `wrangler.toml` with the D1 database ID, and apply the schema:

```sh
npx wrangler r2 bucket create ribbonfish-assets
npx wrangler d1 create ribbonfish-devices
npx wrangler d1 execute ribbonfish-devices --remote --file=schema.sql
npx wrangler deploy
```

The Worker has no write endpoint for R2. Publish images and manifests through Wrangler or a separate trusted release process. Image keys are `assets/<lowercase-sha256>` and manifests are `devices/<device-id>/manifest.json`.

For a Pi 4 device, upload the sample content with:

```sh
for file in ../../agent/defaults/assets/*.png; do
  digest=$(sha256sum "$file" | cut -d ' ' -f 1)
  npx wrangler r2 object put "ribbonfish-assets/assets/$digest" --file "$file"
done
npx wrangler r2 object put ribbonfish-assets/devices/pi-office/manifest.json --file examples/manifest.pi4.json
```

The manifest is a complete snapshot. Its display IDs must match the selected local Pi profile. Asset digests are checked by the Pi before activation; the Worker also checks the object size against the manifest and only serves hashes assigned to the authenticated device.

## Enroll and revoke devices

Generate a one-time code and insert only its hash into D1:

```sh
node scripts/make-enrollment-code.mjs 30
npx wrangler d1 execute ribbonfish-devices --remote --command "INSERT INTO enrollments (code_hash, expires_at) VALUES ('<printed-hash>', <printed-expiry-ms>);"
```

Deliver the printed code privately to that Pi. On the Pi, set `RIBBONFISH_SYNC_URL`, `RIBBONFISH_DEVICE_ID`, and `RIBBONFISH_NETWORK_MODE=bridge`, then exchange the code through stdin:

```sh
read -r -s -p 'One-time code: ' enrollment_code
printf '\n'
printf '%s' "$enrollment_code" | docker compose run --rm -T agent -enroll
unset enrollment_code
```

The agent writes the returned random token to `/var/lib/ribbonfish/device-token` with mode `0600` in its persistent state volume. The Worker stores only the token hash. After enrollment, set `RIBBONFISH_SYNC_URL` and `RIBBONFISH_DEVICE_ID` in `.env`, leave the token in the named state volume, and restart the service.

Revoke a device by disabling its row:

```sql
UPDATE devices SET enabled = 0 WHERE device_id = 'pi-office';
```

Keep enrollment codes, device tokens, and the D1 database private. A device can fetch only its own manifest and the image hashes listed in that manifest. The Worker has no `PUT`, `DELETE`, list, or arbitrary object-key route.
