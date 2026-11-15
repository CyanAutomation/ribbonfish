---
name: api-status-dashboard
description: Implement or diagnose Ribbonfish API status dashboards, provider adapters, safe polling, deterministic rendering, and dashboard capture behavior.
tags: [ribbonfish, cloudflare, status-dashboard, api, rendering, security]
relatedSkills: [cloudflare-capture-design, cloudflare-worker-operations, cloudflare-management-console, cloudflare-asset-lifecycle]
---

# API Status Dashboards

Use this skill for `workers/device-sync/src/api-dashboard/`, API dashboard source configuration or UI, provider polling, SVG/PNG rendering, and API dashboard capture jobs. API dashboards use public status APIs and the existing capture queue; they do not use Browser Run. Use [Cloudflare Capture Design](../cloudflare-capture-design/SKILL.md) for browser screenshot capture scheduling and Browser Run quotas.

## Safe source polling

- Support only the documented providers and public JSON endpoints. Requests use HTTPS, manual redirects, an eight-second timeout, and a one-megabyte response body limit. Redirect responses are rejected and never followed.
- Validate source IDs, hostnames, slugs, and payload schemas before use. Reject IP addresses, single-label hosts, and local or reserved suffixes. `API_STATUS_ALLOWED_HOSTS` optionally restricts hosts by exact match; when unset or empty, syntactically valid public hostnames are accepted. Do not describe the optional list as mandatory.
- Keep `global_fetch_strictly_public` enabled on the management Worker. Do not add credentials, arbitrary URLs, private-network fetches, or a second outbound-fetch mechanism.
- Bound provider workload and displayed strings. Unknown, pending, stale, malformed, or unavailable data must not be presented as healthy. Partial source failure may coexist with successful sources; if every source fails, preserve the last-known-good image.
- Treat ETag and Last-Modified as transfer optimizations. Keep independent endpoint validators where a provider has multiple endpoints; honor `no-store`; never advance source freshness or heartbeat sample time solely because a response was revalidated with 304.

## Rendering and publication

- Normalize provider responses into the shared status, group, incident, maintenance, and freshness model before rendering.
- Keep SVG output escaped and deterministic. Do not load external fonts or decorative assets at render time. Validate output dimensions, PNG size, and source/component limits before publication.
- Reuse the existing content-addressed asset and playlist capture path. Verify a new image before updating capture state; preserve the previous image on poll, render, or storage failure.
- Keep API polling metrics and freshness separate from Browser Run usage, screenshot duration samples, and screenshot forecasts. Conditional requests can reduce bytes but do not reduce request counts.
- Distinguish local Node rendering checks from the Wrangler Workers runtime compatibility test. Neither establishes production CPU, memory, cost, or live-origin behavior.

## Validation and references

From `workers/device-sync/`:

```sh
npm test
npm run typecheck
npm run check:config
node --test src/api-dashboard/render-worker.test.ts
```

Review adapter tests for redirects, configured host allowlists, size/time limits, malformed schemas, conditional requests, and unavailable-source behavior. Review renderer tests and synthetic visual samples at native and reduced display size. Local dashboard polling does not prove every public provider supports validators or that production resource usage is within budget.

- [API dashboard implementation and operational guide](../../../docs/api-driven-dashboards.md)
- [Worker setup and deployment](../../../workers/device-sync/README.md)
- [Capture scheduling and Browser Run](../cloudflare-capture-design/SKILL.md)
- [Private asset lifecycle](../cloudflare-asset-lifecycle/SKILL.md)
