---
name: cloudflare-worker-operations
description: Develop, migrate, validate, and deploy Ribbonfish Workers with safe Wrangler environments and production rollout sequencing.
tags: [ribbonfish, cloudflare, workers, wrangler, d1, deployment, operations]
relatedSkills: [cloudflare-device-sync-enrollment, cloudflare-management-console, cloudflare-asset-lifecycle, cloudflare-capture-design]
---

# Cloudflare Worker Operations

Use this skill for `workers/device-sync/wrangler*.toml`, D1 migrations, Worker bindings, secrets, deployment scripts, or GitHub Actions under `.github/workflows/` that validate or deploy Workers.

## Environment boundaries

- `wrangler.toml` is the device-sync Worker. It keeps management routes disabled.
- `wrangler.management.toml` is the Access-protected management Worker and uses the shared production D1/R2 resources.
- Local console development uses Wrangler's local D1/R2 state. There is no public development Worker. Avoid commands that accidentally select `--remote` during local development.
- The management config's Browser binding can be remote during local development. Capture actions can consume account usage even while D1 and R2 are local.
- Keep production secrets out of config, source, shell history, and logs. Use Wrangler secrets and GitHub Actions secrets as documented.

## Database rollout

- Treat migrations as ordered, forward-only production changes. Review the current schema, migration files, and tests before editing.
- Update `schema.sql` and migration ledger/bootstrap behavior consistently when appropriate; distinguish fresh local database initialization from upgrades to an existing database.
- The GitHub deploy workflow validates and deploys Workers but does **not** apply D1 migrations. Apply the management migration before merging/deploying code that requires it, following the repository's release procedure.
- Make deploy compatibility explicit: avoid deploying code that expects new columns or tables before migration completion. Make cleanup or contract removal a separate safe rollout where needed.

## Validation and deployment

From `workers/device-sync/`:

```sh
npm ci
npm test
npm run build:admin
npm run check:config
```

Inspect `.github/workflows/device-sync.yml` for pull request validation and `.github/workflows/deploy-device-sync.yml` for production deployment. Deploys run from protected `main` after validation; the deploy job uses the `production` environment and serializes production deploys.

Before production changes, verify the target config, binding names, migration state, Access policy, required secrets, queue/bucket/database prerequisites, and rollback path. Never enable management routes on the device-sync Worker or enable capture before its documented queues, migrations, allowlist, and account limits are ready. Current provider limits and quotas must be checked against Cloudflare's active documentation.

## References

- [Worker setup and migration/deployment procedure](../../../workers/device-sync/README.md)
- [Worker validation and deploy workflows](../../workflows/device-sync.yml)
- [Production deployment workflow](../../workflows/deploy-device-sync.yml)
- [Device sync and enrollment](../cloudflare-device-sync-enrollment/SKILL.md)
- [Capture prerequisites](../cloudflare-capture-design/SKILL.md)
