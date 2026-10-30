---
name: cloudflare-management-console
description: Change Ribbonfish's Cloudflare Access-protected management API and browser console while preserving operator authorization and auditability.
tags: [ribbonfish, cloudflare, management, access, admin-ui, audit]
relatedSkills: [cloudflare-device-sync-enrollment, cloudflare-worker-operations, cloudflare-asset-lifecycle, cloudflare-capture-design]
---

# Cloudflare Management Console

Use this skill for `workers/device-sync/src/admin.js`, `workers/device-sync/public/admin/`, management API routes, or operator workflows. Production management runs in the separate `ribbonfish-mgmt` Worker; the device-sync Worker must keep `ADMIN_ENABLED = "false"`.

## Authorization and audit rules

- Production management requires both Cloudflare Access identity and an exact email match in `ADMIN_ALLOWED_EMAILS`. Missing identity or an empty allowlist denies access.
- Keep the Cloudflare Access policy restricted to the same administrator group. Worker-side checks are an additional fail-closed boundary, not a replacement for Access.
- Check authorization on every management API and asset path, including errors and alternate methods. Do not make a UI-only check.
- Record the authenticated operator for state-changing actions. Audit metadata must not contain secrets, device private keys, legacy credentials, or raw request bodies.
- Validate identifiers, payload shape, bounds, and current state before mutations. Protect the active playlist and other documented invariants on the server.
- Treat enrollment approval, device disablement, token rotation, playlist activation/deletion, uploads, and capture requests as privileged audited operations.

## UI and API changes

- Keep the browser panel read-only where documented; do not wire generated OpenUI output to mutation tools or model-backed actions.
- Escape user-controlled content and preserve the restrictive content security policy. Avoid injecting HTML from device names, audit events, URLs, or Worker errors.
- Keep the UI's expectations aligned with the API response and error contracts. A UI affordance is not authorization.
- Use the local R2 asset publishing path for admin static assets; do not expose the private asset bucket publicly to simplify previews.

## Local development and checks

From `workers/device-sync/`:

```sh
npm ci
npm run dev
npm test
npm run check:config
```

Local development uses Wrangler local D1/R2 state and intentionally overrides Access only for localhost. It may use the remote Browser binding for Quick Actions; those calls consume the configured Cloudflare account's usage. Never mistake local data isolation for a production authorization test.

For API or UI changes, update or add tests covering unauthenticated requests, missing Access identity, identities outside the allowlist, allowed operators, method/path variations, audit attribution, and safe rendering of hostile strings. Use the `admin.test.js`, `admin-ui.test.js`, and `admin-enrollment.test.js` suites as nearby examples.

## References

- [Worker setup, API routes, and deployment notes](../../../workers/device-sync/README.md)
- [Device enrollment and sync](../cloudflare-device-sync-enrollment/SKILL.md)
- [Worker operations and migration sequencing](../cloudflare-worker-operations/SKILL.md)
