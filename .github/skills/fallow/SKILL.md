---
name: fallow
description: Run and interpret Fallow analysis for changed code, cleanup candidates, duplication, and TypeScript complexity in Ribbonfish.
tags: [ribbonfish, fallow, typescript, code-health, static-analysis]
relatedSkills: [cloudflare-worker-operations, cloudflare-management-console, github-actions-release]
---

# Fallow

Use this skill when reviewing changed JavaScript or TypeScript, finding unused code, checking duplication, or prioritizing complexity work in Ribbonfish.

## Scope and setup

- Fallow is installed as a dev dependency in `workers/device-sync/`; run it from that directory so it reads the package manifest, TypeScript projects, and installed dependencies.
- Fallow analyzes JavaScript and TypeScript. It does not analyze the Go agent or Python deployment tools. Use the Go and Raspberry Pi skills for those areas.
- The repository root has no `package.json`. A broader scan can use `npx fallow --root ../..`, but package resolution may be incomplete there. Treat the Worker package scan as authoritative for Worker dependencies.
- The Worker requires Node 24. Use the repository's Node 24 runtime for npm commands and tests.

## Choose the right analysis

From `workers/device-sync/`:

```sh
npx fallow --format json --quiet
npx fallow health --report-only --format json --quiet
npm run fallow:audit -- --base origin/main --format json --quiet
npx fallow dead-code --format json --quiet
npx fallow dupes --format json --quiet
npx fallow architecture --format json --quiet
npx fallow health --hotspots --targets --format json --quiet
```

For a coverage-aware audit, collect Node's V8 coverage while running the tests and pass that directory to Fallow:

```sh
coverage_dir=$(mktemp -d)
NODE_V8_COVERAGE="$coverage_dir" npm test
npx fallow audit --base origin/main --coverage "$coverage_dir"
```

- The default `fallow` run combines dead-code, architecture, duplication, and health analysis across the package.
- `fallow health` reports a repository health score, complexity findings, hotspots, and refactoring targets. It is a static estimate; CRAP values use estimated coverage unless real coverage data is supplied.
- `fallow audit` is a changed-file quality gate, not a full-repository health report. Pass the intended base explicitly when reviewing a branch. Its default `new-only` gate distinguishes introduced findings from inherited ones; a worsened inherited finding is a warning by default.
- Git diffs omit untracked files. If they are part of the review, provide an explicit `--diff-file` containing them; do not stage the user's real index just to run the audit.
- Use `--type-aware` for exact TypeScript symbol evidence when deciding whether a finding is safe to remove. It may report private-type leaks in addition to ordinary unused exports; inspect the finding's evidence and owning project before acting.

## Fix findings safely

- Treat unused files, exports, types, and dependencies as candidates. Check package scripts, Worker entry points, generated admin assets, HTML route paths, tests, documentation, and dynamic references before removing them.
- For a specific candidate, run `npx fallow dead-code --trace <path>:<symbol> --format json --quiet`. For dependencies, use `npx fallow dead-code --trace-dependency <name> --format json --quiet`.
- The Worker admin panel is built from `public/admin/app.ts` into generated assets. A root-relative asset URL such as `/admin/app.js` is resolved by the Worker at runtime and can look unresolved to a source-only scan.
- Add a dependency only when source imports it directly and the package needs it at build or runtime. A transitive install is not a substitute for a direct manifest entry.
- Refactor complexity findings by extracting cohesive helpers and preserving observable behavior. Do not lower a score by moving branching into unrelated functions or suppressing a finding without a documented reason.
- Fallow's duplicate groups and churn-based hotspots are review leads, not proof of a defect. Check that copies have the same behavior before consolidating them.
- Never apply `fallow fix` blindly. Preview its edits first, inspect each change, and retain or add regression tests for behavior that is being changed.

## Test-driven workflow

For a behavior-preserving refactor, identify existing tests for the affected path and add focused characterization tests for uncovered branches before changing the implementation. Keep tests in the existing `node:test` TypeScript layout. Run the focused test first, then `npm test` and `npm run typecheck` from `workers/device-sync/` for Worker changes. Run `npm run build:admin` when changing the admin panel.

For an unused-code cleanup, use trace evidence first and remove only the unreachable surface. Run the relevant tests and typecheck after the cleanup; do not delete an entry-point script merely because Fallow cannot see a human-invoked command.

## References

- [Worker setup and validation](../../../workers/device-sync/README.md)
- [Worker operations](../cloudflare-worker-operations/SKILL.md)
- [Management console](../cloudflare-management-console/SKILL.md)
- [Fallow quickstart](https://www.fallow.tools/docs/quickstart/)
- [Fallow audit reference](https://www.fallow.tools/docs/cli/audit/)
- [Fallow agent skills](https://www.fallow.tools/docs/integrations/agent-skills/)
