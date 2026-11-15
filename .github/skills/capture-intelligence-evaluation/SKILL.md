---
name: capture-intelligence-evaluation
description: Evaluate Ribbonfish capture duration evidence and JEV shadow recommendations without confusing usage estimates, schedule outcomes, or screenshot quality.
tags: [ribbonfish, cloudflare, capture, analytics, jev, evaluation]
relatedSkills: [cloudflare-capture-design, cloudflare-worker-operations, cloudflare-management-console]
---

# Capture Intelligence Evaluation

Use this skill for capture duration samples and summaries, the Capture Efficiency view, JEV assessment inputs or recommendations, outcome labeling, or proposals to tune capture readiness or budget policy. Use [Cloudflare Capture Design](../cloudflare-capture-design/SKILL.md) for queue and Browser Run execution mechanics.

## Interpret evidence carefully

- Keep Browser Run measured time, reserve-estimated usage, capture-operation elapsed time, navigation/readiness policy, and unknown samples distinct. Measured percentiles exclude estimated and unknown samples; a reserve is a budget accounting value, not a page wait.
- Keep attempt rows, retry counts, failures, validator hits, budget deferrals, and completed screenshot outcomes separately labeled. A budget deferral, failed attempt, or validator-only shortcut does not establish screenshot completeness.
- A changed or unchanged content hash alone is not a quality label. Quality conclusions require a reviewed screenshot or a content-specific validation outcome; retain uncertain and unobserved outcomes as such.
- Use bounded, retention-aware queries and the documented sample coverage thresholds. Report the sample count, measured-header coverage, date window, target coverage, and missing outcomes with any comparison.
- Treat production assessment snapshots as time-bound evidence. Recheck current code, mode, migrations, and operational data before applying an old recommendation.

## Keep JEV advisory and bounded

- JEV receives a bounded summary; do not send screenshot pixels, target URLs, or selector text unless the approved contract explicitly changes.
- Model output is a suggestion, not policy. Deterministic server-side checks, approved policy IDs, confidence/evidence thresholds, current asset availability, schedule validity, and failure safeguards must bound any prospective action.
- Shadow decisions must not change schedules or settings. Provider failure, stale or insufficient evidence, mixed outcomes, or low confidence leaves the existing policy in effect.
- Do not enable automated deferrals or readiness changes from shadow metrics alone. Require labeled outcomes across representative targets, then a reversible, audited canary with a cooldown and rollback criteria before considering automation.
- Keep per-target readiness changes separate from global reserve changes; global reserve affects fleet-wide budget preflight and accounting.

## Validation and references

From `workers/device-sync/`:

```sh
npm test
npm run typecheck
npm run check:config
```

Review `capture-duration.test.ts`, `capture-intelligence.test.ts`, `capture-forecast.test.ts`, and `capture-workflow.test.ts` for evidence classification, confidence gates, outcome recording, and failure behavior. Changes to schema-backed samples require an ordered migration and the production rollout sequence in [Cloudflare Worker Operations](../cloudflare-worker-operations/SKILL.md).

- [Capture duration evidence and evaluation plan](../../../docs/capture-duration-intelligence-plan.md)
- [JEV shadow-mode evidence assessment](../../../docs/jev-shadow-mode-assessment-2026-11-04.md)
- [Worker capture implementation](../../../workers/device-sync/README.md)
- [Capture queue and Browser Run constraints](../cloudflare-capture-design/SKILL.md)
