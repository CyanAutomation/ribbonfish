# TypeScript migration plan

Planning snapshot: `origin/main` at `9f68a4a` (4 November 2026). This plan covers the handwritten JavaScript in the device-sync Worker, management UI, and tests. Preserve existing HTTP, database, queue, authentication, and asset contracts. The Go agent, SQL, and generated browser bundle are outside the conversion.

## Starting point before this implementation

At the start, the migration was already underway. Shared Worker modules, capture orchestration, operational scripts, GitHub Actions scripts, and many tests were TypeScript. Strict, no-emit projects existed for Worker, extracted browser modules, and Node scripts. CI checked generated bindings, types, the admin build, tests, and both Wrangler dry-runs. Node 24 was pinned for device-sync.

The remaining tracked JavaScript comprises:

- Worker: `src/admin.js` and `src/index.js`. Both Wrangler configurations use `src/index.js`.
- Browser: `public/admin/app.js`. OpenUI integration and the other extracted UI modules are already TypeScript. The esbuild source entry is `app.js`; the published `/admin/app.js` URL and R2 key must remain stable.
- Eleven `src/*.test.js` files covering the admin UI and API, entry point, capture workflow, enrollment, health, and asset maintenance. JEV tests are already TypeScript.

The Node test typechecker emits Worker declarations and checks tests marked `@typecheck-node-test`, keeping Node globals separate from Worker globals. Existing strict Node tests and the new validation test opt in; dynamic legacy fixtures are verified by runtime tests. The new browser DOM primitive tests use a separate DOM type project. The large legacy page controller has a no-emit transition check with `noImplicitAny` and `strictNullChecks` disabled. The existing `.mts` automation is included by the scripts project; it does not need a second migration.

## Implementation progress

The Worker entry points and all eleven remaining JavaScript tests are now TypeScript. The migration adds typed Worker binding and SQL row boundaries, string validation and required DOM/form lookup primitives with tests, and keeps the generated admin bundle output at `app.js`. Both Wrangler entry paths and the esbuild input point to TypeScript source. HTTP routes, D1 schema, queue messages, and the published `/admin/app.js` asset contract are unchanged.

## Proposed sequence

1. **Baseline and Worker conversion — complete.** The baseline was run under Node 24.21.0. Both Worker entry points now use explicit binding, request context, SQL result, queue, and scheduled handler types. Their Wrangler entry paths use TypeScript, and untrusted JSON is narrowed at route boundaries.
2. **Browser conversion — complete with a transition check.** The page controller and DOM/form lookups are TypeScript. The extracted UI modules and new DOM primitive tests are strict checked; the large legacy controller has a no-emit check with null and implicit-any transitions disabled. The bundle still emits `app.js` at the original route and storage key.
3. **Test conversion — complete.** All eleven remaining JavaScript tests are TypeScript. Existing strict Node tests and the new validation test use the declaration-based Node checker. The new DOM tests use their own strict browser type project. The dynamically shaped legacy fixtures remain covered by runtime tests and can opt into static checking as fixture types are added.
4. **Close and validate — complete.** No handwritten `.js`, `.mjs`, or `.cjs` files remain in the project; remaining `.js` references are generated or published admin asset contracts. Node 24.21.0 passed typecheck, all 264 tests, the admin bundle build, and both Wrangler dry-runs. No database migration was needed.

The typecheck has no blanket suppressions. SQL uses a documented untyped raw-row boundary while query results receive concrete shapes. The legacy page controller's implicit-any and null checks are a documented migration transition; all converted behavior tests continue to run in CI. Deployment workflows run after changes reach `main`; review deployment readiness before merging. No database migration was needed solely for typing.

Done means no unaccounted-for handwritten JavaScript remains, production TypeScript and migration primitives are checked, all tests run in CI with existing coverage and discovery, external contracts and the published admin asset remain compatible, and the checks pass. Follow-up work can add static types to dynamic fixtures and tighten strictness for the legacy controller.
