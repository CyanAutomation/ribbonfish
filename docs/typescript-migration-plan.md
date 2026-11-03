# TypeScript migration plan

Baseline: `origin/main` at `ee9d8db` (3 November 2026). This plan covers remaining handwritten JavaScript in the device-sync Worker, management UI, and tests. Preserve existing HTTP, database, queue, authentication, and asset contracts. The Go agent, SQL, and generated browser bundle are outside the conversion.

## Starting point

The migration is already underway. Shared Worker modules, capture orchestration, operational scripts, GitHub Actions scripts, and many tests are TypeScript. Strict, no-emit projects exist for Worker, browser, Node scripts, and tests. CI checks generated bindings, types, the admin build, tests, and both Wrangler dry-runs. Node 24 is pinned for device-sync.

The remaining tracked JavaScript comprises:

- Worker: `src/admin.js` (1,332 lines) and `src/index.js` (552 lines). Both Wrangler configurations use `src/index.js`.
- Browser: `public/admin/app.js` (1,437 lines). OpenUI integration and the other extracted UI modules are already TypeScript. The esbuild source entry is `app.js`; the published `/admin/app.js` URL and R2 key must remain stable.
- Nine `src/*.test.js` files covering the admin UI and API, entry point, capture workflow, enrollment, health, and asset maintenance. JEV tests are already TypeScript.

`npm run typecheck` checks converted tests against declarations emitted from the Worker via `scripts/typecheck-tests.ts`, separating Node globals from Worker globals. Browser-related tests and tests importing the remaining entry points need particular attention when extending this arrangement. The existing `.mts` automation is included by the scripts project; it does not need a second migration.

## Implementation progress

The shared HTTP error and object-key validators are now typed and used by both JavaScript Worker entry points. The management API client is extracted into TypeScript with focused tests. The three JavaScript entry points and nine JavaScript tests below still require conversion.

## Proposed sequence

1. **Record a reproducible baseline.** With Node 24, run `npm ci`, `npm run typecheck`, `npm run build:admin`, `npm test`, and `npm run check:config` in `workers/device-sync`; also run the `.github/scripts` test commands from their workflows. Record failures and test counts. On 3 November 2026, the baseline passed under Node 24.22.2: 210 Worker tests and seven workflow tests passed, along with typechecking, the admin build, skill validation, and both Wrangler dry-runs. Confirm the working tree is clean after checks and preserve the current test discovery count during each conversion.
2. **Convert the Worker entry points.** Convert `admin.js` and `index.js` in reviewable slices, starting with explicit types for bindings, request context, route inputs, D1 results, queue and scheduled handlers. Reuse existing domain types and generated management bindings, and narrow untrusted JSON and errors at boundaries. Update imports, both Wrangler `main` paths, and references in tests and documentation. Keep management access checks and `ADMIN_ENABLED` behavior unchanged. Verify the typecheck and both dry-runs, plus the existing admin, enrollment, health, capture, and entry-point tests.
3. **Convert the browser sources.** Convert `app.js` using the existing strict browser project and existing typed UI modules. Type OpenUI payloads, DOM elements and event handling, API responses, and UI state without changing behavior. Update the esbuild input and source-reading/importing tests; retain the output filename, published URL, and asset key. Run the admin build, UI and startup tests, and exercise representative navigation and management interactions locally.
4. **Convert remaining tests in batches.** Migrate the nine JavaScript tests by area, updating imports and source paths. Adapt the declaration-based test typecheck or add appropriately scoped projects for browser and Worker-facing tests; ensure every converted test is actually checked without mixing incompatible runtime globals. Run `node --test` under Node 24 and compare discovery and test counts against the baseline. Keep meaningful fixtures and runtime assertions intact; do not weaken contracts merely to satisfy types.
5. **Close and validate.** Search tracked files for remaining handwritten `.js`, `.mjs`, and `.cjs` and stale source references; distinguish the intentional generated `/admin/app.js` contract. Ensure all TypeScript, tests, and automation are covered by strict CI typechecks. Repeat the baseline checks and representative local management startup, enrollment/sync, capture queue/scheduler, and asset publication flows. Document any intentional exceptions and update developer instructions as needed.

Land each phase as a small, independently validated change. Avoid broad `any`, blanket suppressions, and unrelated behavior changes. Pay special attention to Cloudflare binding differences, D1 result shapes, Web Crypto, untrusted JSON, and DOM nullability. No database migration should be necessary solely for typing. Deployment workflows run after changes reach `main`; use local checks and Wrangler dry-runs during development and review deployment readiness before merging.

Done means no unaccounted-for handwritten JavaScript remains, all TypeScript sources and tests are typechecked in CI, test coverage and discovery are preserved, external contracts and the published admin asset remain compatible, and the checks and representative local flows pass.
