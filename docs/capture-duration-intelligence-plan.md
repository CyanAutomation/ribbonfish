# Capture duration intelligence plan

**As of:** 4 November 2026

## Assessment

Ribbonfish currently records three different things that should stay distinct:

| Signal | Current meaning | What it can tell us |
| --- | --- | --- |
| Screenshot readiness | Browser Run waits for `domcontentloaded`, then optionally for a configured CSS selector. | When the current request is allowed to take the screenshot. |
| Measured browser time | `X-Browser-Ms-Used` from a Browser Run Quick Action response. | Browser Run usage for that request; it is not a direct measure of whether page content was complete. |
| Reserve estimate | `CAPTURE_BUDGET_RESERVE_MS`, currently 60 seconds. Used for budget preflight and when the response has no measured duration. | A conservative accounting value, not a page wait or measured runtime. |

`gotoOptions.timeout` is a 45-second navigation failure ceiling. It does not set a 45-second wait. The optional readiness selector is added after `domcontentloaded`, so it can ensure relevant content is present but does not currently let a capture proceed before that event.

The current configuration has no adjustable post-navigation delay: its generic baseline is already `domcontentloaded`. JEV cannot make a capture faster by lowering a wait value that does not exist. Safe savings currently come from trusted validator hits or reducing the source page's work; any earlier Browser Run readiness condition must first be confirmed as supported and checked against reviewed screenshots.

Before this work, the read-only `/admin/api/capture-forecast` and overview API exposed per-site averages and counts, but the forecast averaged successful history rows across measured, reserve-estimated, and older unknown sources. The overview exposed source totals only across the fleet. There was no API for individual duration samples. Screenshot history retains at most 10 successful capture records per target within a 30-day age window, and `capture_jobs` stores Browser Run time totals across retries rather than one row per attempt.

JEV already has a pre-due shadow path. It evaluates up to three targets within five minutes of their due time, receives a bounded summary with a median of measured samples and recent screenshot hashes, and can suggest a one-time skip. It does not receive screenshot pixels or quality labels. Deterministic checks keep it advisory. The current production assessment has 46 assessments across 9 targets, one unobserved skip suggestion, and too few labelled outcomes to support automatic changes; see [jev-shadow-mode-assessment-2026-11-04.md](jev-shadow-mode-assessment-2026-11-04.md).

The existing conditional ETag/Last-Modified check can reuse a valid cached screenshot and avoid Browser Run when the server confirms the resource is unchanged. This is useful only when those validators track all changes that affect the rendered page.

## Design decisions

1. Treat page readiness policy and Browser Run budget accounting as separate controls. Do not present the reserve as a wait duration.
2. Keep measured, reserve-estimated, and unknown samples separate in APIs, analysis, and the Capture Efficiency page.
3. Let JEV recommend only among server-defined, admin-approved policy IDs. It must not supply arbitrary timeouts, CSS selectors, or browser code.
4. Use shadow recommendations and labelled outcomes before enabling automatic per-target changes. A changed screenshot hash is not evidence that a screenshot is complete or incomplete.
5. Keep current settings when evidence is missing, stale, or mixed, or when JEV is unavailable.

## Updated implementation plan

### Implemented in this change

- Added `GET /admin/api/captures/{capture_id}/duration-samples`. It pages through per-attempt rows, clamps queries to 90-day retention, and returns source-separated p50/p90, sample coverage, reserve totals, failure and retry counts. Summary work is capped at 50,000 rows.
- Added one sample for each attempt that started Browser Run, including failed attempts. Rows record measured versus reserve-estimated usage, reserve snapshot, attempt number, elapsed Browser Run and capture operation time, result, readiness mode, and the exact configured selector. Validator hits and budget deferrals do not create a Browser Run attempt row. JEV receives the readiness mode but not the selector text.
- Added a trailing-30-day per-site summary to the overview API and Capture Efficiency page. It separates measured p50/p90 and coverage from reserve estimates, reports failures/retries and readiness mode, and flags a possible reserve overestimate only after 20 measured attempts, 80% measured-header coverage, and p90 at most half the configured reserve.
- Extended the existing pre-due JEV shadow assessment with the latest 500 duration attempts from the trailing 30-day review window. It can recommend `review_duration`; the server returns that recommendation only when the deterministic evidence rule passes and JEV confidence is at least 0.8. It cannot change reserve, readiness settings, screenshot scheduling, or queue behavior.
- Added migration `0015_capture_duration_samples.sql`; apply it before deploying the Worker and management assets.

The existing daily forecast still uses its successful-history average, which can include legacy and reserve-estimated rows. The new per-site duration section and API expose the source mix for analysis; splitting the forecast projection by source remains follow-up work.

### 1. Add queryable duration evidence

- [x] Add a read-only admin API with bounded date and page-size filters.
- [x] Return per-attempt outcomes, retry number, source, reserve snapshot, elapsed durations, and readiness mode; measured percentiles exclude reserve and unknown samples.
- [x] Retain compact timing rows for 90 days independently of screenshot asset retention.
- [x] Document the endpoint and distinguish Browser Run usage, capture operation elapsed time, and page readiness.

### 2. Expand Capture Efficiency

- [x] Show source-separated per-target p50/p90, sample counts, header coverage, failure/retry counts, readiness mode, and configured reserve.
- [x] Add a possible-overestimate review cue; it does not change the reserve and does not infer measured runtime for headerless attempts.
- [ ] Split the daily forecast projection into measured and reserve-estimated source totals.

### 3. Calibrate readiness settings with reviewed captures

- [x] Record the readiness mode and exact admin-authored selector with each timing sample; keep JEV input limited to the readiness mode.
- [x] Keep selectors admin-authored and target-specific.
- Confirm and benchmark the options supported by the deployed Browser Run Quick Actions version. The current `domcontentloaded` policy is already an early generic condition; `networkidle0`/`networkidle2` can wait longer. Do not lower the navigation timeout as a speed optimization: that can turn slow successes into failures without making successful captures faster.
- Build a small reviewed set of screenshots for each candidate policy. Mark whether key visible content is complete, incomplete, or uncertain; compare the candidate with a reviewed settled view and representative content changes. Use visual comparison or page-specific content markers. Hash equality alone is insufficient.
- Only retain a faster policy for a target when repeated reviewed captures show the same required visible content and no new failure or placeholder pattern.

### 4. Extend JEV pre-capture advice, then add readiness recommendations

- [x] Extend the pre-due JEV schema with an advisory to keep the current reserve or request operator review. Include measured timing distribution, source coverage, attempt failures/retries, and readiness mode; omit URLs, selectors, and screenshot pixels.
- [x] Save the advisory with the existing due-time shadow decision; low confidence, insufficient evidence, or provider failure leaves settings and schedule unchanged.
- [ ] Collect reviewed screenshot completeness outcomes before asking JEV to advise page-readiness policy.
- [ ] Only compare recommendations with completed, content-verified or human-reviewed outcomes; validator-only skips, budget deferrals, and failures do not verify screenshot quality.

### 5. Enable bounded canary tuning, then automation

- After the API and page expose enough evidence, allow an administrator to apply one recommended policy to one target as a reversible canary.
- Compare browser-time distributions and reviewed quality outcomes before and after the canary. Require a meaningful duration improvement with no increase in incomplete captures, failures, or stale screenshots.
- Enable automatic per-target policy changes only after representative shadow and canary evidence meets documented thresholds. Apply one bounded change at a time, use a cooldown, audit it, and roll back to the last known-good policy on quality or reliability regression.
- Keep global reserve changes separate. Adjust the reserve only from measured coverage and budget-overrun analysis because it affects preflight deferrals and accounting for every target; JEV should not tune it directly.

## Acceptance criteria

- [x] The duration API returns raw samples with unambiguous source labels and a recorded reserve; its measured percentiles exclude estimated and unknown values.
- [x] Capture Efficiency shows which targets have meaningful measured coverage and which high values are reserve estimates.
- [x] JEV reserve-review suggestions require a bounded evidence threshold and confidence; they do not alter reserve or readiness settings.
- [ ] A page-readiness recommendation cannot alter a target without reviewed quality evidence and a valid, bounded policy ID; failures fall back to the existing setting.
- Shadow and canary evaluations separately report screenshot-quality outcomes, validator shortcuts, budget deferrals, failures, and unobserved captures.
- Production automation remains disabled until reviewed outcomes demonstrate both a duration reduction and stable screenshot completeness.
