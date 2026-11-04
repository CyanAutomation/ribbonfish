# JEV shadow-mode data assessment

**As of:** 4 November 2026

**Source:** Read-only queries against the production `ribbonfish-devices` D1 database; implementation checked at `origin/main` (`18b3b74`).

## Summary

The shadow pipeline is running and has recorded 46 assessments across 9 capture targets from 2–4 November. This is not enough labelled data to judge whether JEV can safely identify screenshots to defer. There is only one `defer_once` suggestion, and it has no observed outcome. The single content-verified capture was reported as changed, but JEV had recommended keeping that capture.

The one deferral was made by the pre-confidence-gate production version. Under the current repository policy, none of these 46 stored decisions would qualify for a deferral: the candidate's two confidence values are below 0.8, and none of the 45 `capture_now` responses had risk confidence at or above 0.8. Keep the mode advisory and continue collecting labelled observations.

## Data

| Measure | Result |
| --- | ---: |
| Assessments | 46 |
| Distinct targets | 9 |
| JEV recommendation | 45 `capture_now`; 1 `skip_once` |
| Stored policy action | 45 `capture`; 1 `defer_once`; 0 errors |
| Content-verified outcomes | 1 changed; 0 unchanged |
| Non-content outcomes | 16 budget-deferred |
| Still unobserved | 29 (including the sole deferral suggestion) |
| Provider-reported usage | 25,492 input tokens; 2,346 output tokens; cost `0.001070664` |

All 46 records used `typesafe/jev-1.14-20261014`; all had provider usage metadata. The 46 assessments occurred on three calendar dates, so the 30-day retention window is not yet a 30-day evaluation history.

## Interpretation

- **No deferral quality estimate is possible.** The only `defer_once` has no `observed_result`; there are no labelled candidate deferrals to count as safe or unsafe. Do not interpret budget deferrals as evidence that content was unchanged.
- **The one candidate is legacy data.** It was assessed at 00:30 UTC on 3 Nov, with recommendation confidence `0.64` and risk confidence `0.49` (risk score `0.33`). Production Worker version 19 had been deployed at 19:52 UTC on 2 Nov. The 0.8 confidence gate was added to source at 20:12 UTC, and the next deployment was version 20 at 10:23 UTC on 3 Nov. The candidate therefore came from the pre-gate runtime and would be rejected by the current policy.
- **The current gate admits no skips in this sample.** Current code requires both answer confidences to be at least `0.8`, risk score at most `0.5`, and deterministic freshness, asset, hash-stability, and error safeguards to pass. No stored response meets both confidence thresholds. In particular, none of the 45 `capture_now` responses had risk confidence at least `0.8`.
- **The observed changed capture is directionally reassuring, but only one case.** Its stored policy action was `capture`; the record does not establish broader performance.
- **Shadow mode remains advisory.** The deployed management Worker is configured with `CAPTURE_ANALYSIS_MODE=shadow`; shadow actions do not change capture schedules.

## Recommendation

Continue shadow collection with the current confidence and deterministic safeguards. Do not use this sample to enable automatic deferrals or to lower the confidence threshold. Reassess after there are substantially more `skip_once` candidates with completed screenshot outcomes across different targets and content-change patterns. Track `changed` and `unchanged` screenshot results separately from budget deferrals, validator shortcuts, failures, and still-unobserved records.

## Method and limits

Queried the production D1 database through the Cloudflare API using read-only `SELECT` statements, restricted to the rolling 30-day window. Aggregated counts, dates, stored answer choices/confidences, usage, and observation labels; did not retrieve target URLs, names, screenshot pixels, or raw assessment state. Checked Worker deployment timestamps and the current source policy. This is an early operational snapshot, not a statistically meaningful model evaluation.

Implementation references: `workers/device-sync/src/capture-intelligence.ts` (policy and shadow collection), `workers/device-sync/src/capture-workflow.ts` (outcome labelling), `workers/device-sync/README.md` (mode and evaluation caveats), and `workers/device-sync/migrations/0013_capture_efficiency_audit.sql` (observation fields).

## Implementation follow-through

The management overview now reports deferred-candidate outcomes separately for changed screenshots, unchanged screenshots, validator-only results, Browser Run budget deferrals, failed captures, and outcomes not yet observed. The admin panel uses a tested presentation helper for that breakdown. The existing combined `unverified` API metric remains available for compatibility. The confidence gate and shadow-only scheduling behavior are unchanged.

These implementation changes are local to the assessment worktree and have not been deployed. Verification: all 229 package tests pass under Node 24, the admin bundle builds, and package typecheck passes.
