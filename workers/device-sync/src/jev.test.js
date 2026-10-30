import test from "node:test";
import assert from "node:assert/strict";
import { callJevDecision, validateAnswers } from "./jev.js";
import {
  buildCaptureAssessmentState,
  buildFleetAnalysisState,
  captureAssessmentQuestions,
  fleetAnalysisQuestions,
} from "./jev-use-cases.js";

const sampleAnswers = {
  recommendation: {
    type: "choice",
    choice: "skip_once",
    probabilities: { capture_now: 0.2, skip_once: 0.8 },
    confidence: 0.8,
  },
  risk: {
    type: "score",
    score: 0.2,
    legend: { "0": "Low", "1": "Moderate", "2": "High" },
    probabilities: { "0": 0.8, "1": 0.2, "2": 0 },
    confidence: 0.8,
  },
};

test("JEV decision primitive sends a typed decision request and returns validated answers", async () => {
  let requested;
  const result = await callJevDecision({ OPENROUTER_API_KEY: "server-secret" }, {
    state: "compact state",
    questions: captureAssessmentQuestions,
    fetcher: async (url, options) => {
      requested = { url: String(url), options, body: JSON.parse(options.body) };
      return Response.json({
        model: "typesafe/jev-1.13",
        answers: {
          ...sampleAnswers,
          recommendation: { ...sampleAnswers.recommendation, provider_debug: "must not reach the caller" },
          risk: { ...sampleAnswers.risk, private_context: "must not reach the caller" },
        },
        usage: { cost: 0.00001 },
        id: "decision-1",
      });
    },
  });

  assert.equal(requested.url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(requested.options.headers.Authorization, "Bearer server-secret");
  assert.equal(requested.body.model, "~typesafe/jev-latest");
  assert.equal(requested.body.state, "compact state");
  assert.deepEqual(result.answers, sampleAnswers);
  assert.doesNotMatch(JSON.stringify(result.answers), /provider_debug|private_context/);
  assert.equal(result.id, "decision-1");
});

test("JEV decision primitive rejects missing secrets, oversized input, provider failures, and invalid answers", async () => {
  await assert.rejects(callJevDecision({}, {
    state: "state", questions: captureAssessmentQuestions, fetcher: async () => assert.fail("must not fetch"),
  }), /not configured/);
  await assert.rejects(callJevDecision({ OPENROUTER_API_KEY: "key" }, {
    state: "x".repeat(16_385), questions: captureAssessmentQuestions, fetcher: async () => assert.fail("must not fetch"),
  }), /state is too large/);
  await assert.rejects(callJevDecision({ OPENROUTER_API_KEY: "key" }, {
    state: "state", questions: captureAssessmentQuestions,
    fetcher: async () => new Response("provider down", { status: 503 }),
  }), /provider request failed/);
  await assert.rejects(callJevDecision({ OPENROUTER_API_KEY: "key" }, {
    state: "state", questions: captureAssessmentQuestions,
    fetcher: async () => Response.json({ answers: { recommendation: { type: "choice", choice: "skip_once" } } }),
  }), /invalid decision answers/);
  await assert.rejects(callJevDecision({ OPENROUTER_API_KEY: "key" }, {
    state: "state", questions: captureAssessmentQuestions, timeoutMs: 1,
    fetcher: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error(), { name: "AbortError" })))),
  }), /timed out/);
  await assert.rejects(callJevDecision({ OPENROUTER_API_KEY: "key" }, {
    state: "state", questions: captureAssessmentQuestions,
    fetcher: async () => new Response("x".repeat(33 * 1024)),
  }), /response was too large/);
});

test("answer validation enforces choices, types, probabilities, confidence, and score bounds", () => {
  assert.equal(validateAnswers(sampleAnswers, captureAssessmentQuestions), true);
  assert.equal(validateAnswers({ ...sampleAnswers, recommendation: { ...sampleAnswers.recommendation, choice: "delete" } }, captureAssessmentQuestions), false);
  assert.equal(validateAnswers({ ...sampleAnswers, risk: { ...sampleAnswers.risk, score: 4 } }, captureAssessmentQuestions), false);
  assert.equal(validateAnswers({ ...sampleAnswers, risk: { ...sampleAnswers.risk, confidence: 1.2 } }, captureAssessmentQuestions), false);
  assert.equal(validateAnswers({ ...sampleAnswers, risk: { ...sampleAnswers.risk, probabilities: { "0": 1.4, "1": 0, "2": 0 } } }, captureAssessmentQuestions), false);
  assert.equal(validateAnswers({ ...sampleAnswers, extra: { type: "noul", noul: 1 } }, captureAssessmentQuestions), false);
  assert.equal(validateAnswers({ ...sampleAnswers, recommendation: { ...sampleAnswers.recommendation, probabilities: undefined } }, captureAssessmentQuestions), false);
  assert.equal(validateAnswers({ ...sampleAnswers, risk: { ...sampleAnswers.risk, legend: { 0: "Wrong", 1: "Moderate", 2: "High" } } }, captureAssessmentQuestions), false);
});

test("fleet analysis state contains bounded operational signals without sensitive identifiers or URLs", () => {
  const state = buildFleetAnalysisState({
    devices: [
      { device_id: "private-name", enabled: 1, health: { status: "healthy", reported_state: "ready", sync_status: "ok", applied_playlist_id: "private-list", applied_revision: "secret-revision" } },
      { device_id: "another-name", enabled: 1, health: { status: "degraded", reported_state: "degraded", sync_status: "failed", applied_playlist_id: "private-list", applied_revision: "old-revision" } },
      { device_id: "disabled", enabled: 0, health: { status: "disabled" } },
    ],
    playlists: [{ active: 1 }, { active: 0 }],
    active_playlist: { playlist_id: "private-list", revision: "secret-revision" },
    asset_health: { missing: [{ sha256: "secret-digest" }], integrity_issues: [{ issue_type: "size_mismatch" }] },
    capture_targets: [{ display_url: "https://secret.example/private", job_status: "queued", last_error: "raw failure" }],
  });
  assert.deepEqual(JSON.parse(state), {
    devices: { healthy: 1, degraded: 1, stale: 0, offline: 0, unknown: 0, disabled: 1 },
    agent_states: { ready: 1, starting: 0, degraded: 1, startup_failed: 0, stopping: 0, unknown: 0 },
    sync: { ok: 1, failed: 1, unknown: 0 },
    playlist: { active: true, inactive_versions: 1, device_sync: { current: 1, behind: 1, unknown: 0 } },
    assets: { missing_active: 1, integrity_issues: 1 },
    screenshots: { total: 1, queued_or_running: 1, with_recent_errors: 1 },
  });
  assert.doesNotMatch(state, /private-name|secret|https|raw failure/);
  assert.equal(JSON.parse(state).screenshots.with_recent_errors, 1);
  assert.ok(fleetAnalysisQuestions.analysis_status);
});

test("capture assessment state includes only allowlisted metadata and no private URL parts", () => {
  const state = buildCaptureAssessmentState({
    url: "https://user:pass@example.com/private?token=secret#fragment",
    capture_interval_seconds: 300,
    last_success_at: 1_000,
    next_due_at: 10_000,
    failure_count: 2,
    last_error: "Raw stack trace",
    job_status: "queued",
    history: [{ browser_ms: 1000 }, { browser_ms: 3000 }],
  }, 10_000);
  assert.deepEqual(JSON.parse(state), {
    screenshot_age_seconds: 9,
    configured_interval_seconds: 300,
    seconds_until_due: 0,
    consecutive_failures: 2,
    recent_job: "queued",
    recent_error_present: true,
    recent_capture_count: 2,
    median_browser_ms: 2000,
  });
  assert.doesNotMatch(state, /example\.com|user|pass|private|token|secret|Raw stack/);
  assert.ok(fleetAnalysisQuestions.analysis_status);
});

test("fixed JEV schemas declare expected answer keys", () => {
  assert.deepEqual(Object.keys(fleetAnalysisQuestions), ["analysis_status", "focus", "urgency"]);
  assert.deepEqual(Object.keys(captureAssessmentQuestions), ["recommendation", "risk"]);
});
