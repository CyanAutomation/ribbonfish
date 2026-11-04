import test from "node:test";
import assert from "node:assert/strict";
import { callJevDecision, validateAnswers, JEVRequestError } from "./jev.ts";
import {
  buildCaptureAssessmentState,
  captureAssessmentQuestions,
  durationReviewRecommendation,
} from "./jev-use-cases.ts";

const sampleAnswers = {
  duration_review: {
    type: "choice",
    choice: "review_duration",
    probabilities: { keep_current: 0.2, review_duration: 0.8 },
    confidence: 0.8,
  },
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
  const requests: Array<{ url: string; options: RequestInit; body: Record<string, unknown> }> = [];
  const result = await callJevDecision({ OPENROUTER_API_KEY: "server-secret" }, {
    state: JSON.stringify({ summary: "compact state" }),
    questions: captureAssessmentQuestions,
    fetcher: async (url, options) => {
      assert.ok(options);
      assert.ok(typeof options.body === "string");
      requests.push({ url: String(url), options, body: JSON.parse(options.body) });
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

  const requested = requests[0];
  assert.ok(requested);
  assert.equal(requested.url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(new Headers(requested.options.headers).get("Authorization"), "Bearer server-secret");
  assert.equal(requested.body.model, "~typesafe/jev-latest");
  assert.deepEqual(requested.body.state, { summary: "compact state" });
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
    state: JSON.stringify({ summary: "state" }), questions: captureAssessmentQuestions,
    fetcher: async () => new Response("provider down", { status: 503 }),
  }), /provider request failed/);
  await assert.rejects(callJevDecision({ OPENROUTER_API_KEY: "key" }, {
    state: JSON.stringify({ summary: "state" }), questions: captureAssessmentQuestions,
    fetcher: async () => Response.json({ answers: { recommendation: { type: "choice", choice: "skip_once" } } }),
  }), /invalid decision answers/);
  await assert.rejects(callJevDecision({ OPENROUTER_API_KEY: "key" }, {
    state: JSON.stringify({ summary: "state" }), questions: captureAssessmentQuestions, timeoutMs: 1,
    fetcher: (_url, options) => new Promise((_, reject) => {
      assert.ok(options?.signal);
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error(), { name: "AbortError" })));
    }),
  }), /timed out/);
  await assert.rejects(callJevDecision({ OPENROUTER_API_KEY: "key" }, {
    state: JSON.stringify({ summary: "state" }), questions: captureAssessmentQuestions,
    fetcher: async () => new Response("x".repeat(33 * 1024)),
  }), /response was too large/);
});

test("provider errors retain upstream status separately from the client-facing status", async () => {
  for (const upstreamStatus of [401, 429, 503]) {
    await assert.rejects(callJevDecision({ OPENROUTER_API_KEY: "key" }, {
      state: "{}", questions: captureAssessmentQuestions,
      fetcher: async () => new Response("private provider details", { status: upstreamStatus }),
    }), (error) => {
      assert.ok(error instanceof JEVRequestError);
      assert.equal(error.status, 502);
      assert.equal(error.upstreamStatus, upstreamStatus);
      assert.doesNotMatch(error.message, /private provider details/);
      return true;
    });
  }
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

test("capture assessment state includes only allowlisted metadata and no private URL parts", () => {
  const input = {
    url: "https://user:pass@example.com/private?token=secret#fragment",
    capture_interval_seconds: 300,
    last_success_at: 1_000,
    next_due_at: 10_000,
    failure_count: 2,
    last_error: "Raw stack trace",
    job_status: "queued",
    history: [
      { browser_ms: 1000, browser_ms_source: "reserve", sha256: "a", captured_at: 8000 },
      { browser_ms: 3000, browser_ms_source: "response_header", sha256: "a", captured_at: 9000 },
      { browser_ms: 2000, browser_ms_source: "response_header", sha256: "b", captured_at: 9500 },
    ],
    duration_summary: {
      total_samples: 25,
      measured_sample_count: 20,
      reserve_estimated_sample_count: 3,
      unknown_sample_count: 2,
      failed_attempt_count: 1,
      retry_attempt_count: 2,
      capture_attempt_failure_rate: 0.04,
      retry_attempt_rate: 0.08,
      measured_header_coverage: 0.8,
      measured_p50_ms: 10_000,
      measured_p90_ms: 18_000,
      measured_average_ms: 11_000,
      reserve_estimated_total_ms: 180_000,
      configured_reserve_ms: 60_000,
      conservative_review: "review" as const,
    },
  };
  const state = buildCaptureAssessmentState(input, 10_000);
  assert.deepEqual(JSON.parse(state), {
    screenshot_age_seconds: 9,
    configured_interval_seconds: 300,
    seconds_until_due: 0,
    consecutive_failures: 2,
    recent_job: "queued",
    recent_error_present: true,
    recent_capture_count: 3,
    browser_duration_sample_count: 2,
    median_browser_ms: 2500,
    capture_duration: {
      total_samples: 25,
      measured_sample_count: 20,
      reserve_estimated_sample_count: 3,
      unknown_sample_count: 2,
      failed_attempt_count: 1,
      retry_attempt_count: 2,
      capture_attempt_failure_rate: 0.04,
      retry_attempt_rate: 0.08,
      measured_header_coverage: 0.8,
      measured_p50_ms: 10_000,
      measured_p90_ms: 18_000,
      measured_average_ms: 11_000,
      reserve_estimated_total_ms: 180_000,
      configured_reserve_ms: 60_000,
      conservative_review: "review",
    },
    readiness_mode: "domcontentloaded",
    recent_content_change_count: 1,
    unchanged_capture_streak: 1,
  });
  assert.doesNotMatch(state, /example\.com|user|pass|private|token|secret|Raw stack/);
});

test("JEV duration review remains bounded by server-side evidence and confidence", () => {
  const eligible = {
    conservative_review: "review" as const,
  } as import("./capture-duration.ts").CaptureDurationSummary;
  assert.equal(durationReviewRecommendation({ duration_review: { choice: "review_duration", confidence: 0.9 } }, eligible), "review");
  assert.equal(durationReviewRecommendation({ duration_review: { choice: "review_duration", confidence: 0.79 } }, eligible), "keep_current");
  assert.equal(durationReviewRecommendation({ duration_review: { choice: "keep_current", confidence: 0.99 } }, eligible), "keep_current");
  assert.equal(durationReviewRecommendation({ duration_review: { choice: "review_duration", confidence: 0.99 } }, {
    ...eligible, conservative_review: "insufficient_data",
  }), "insufficient_data");
});

test("JEV state must be a bounded JSON object and the requested model cannot be overridden", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const env = { OPENROUTER_API_KEY: "key", JEV_MODEL: "attacker/model" };
  await callJevDecision(env, {
    state: JSON.stringify({ safe: true }),
    questions: captureAssessmentQuestions,
    fetcher: async (_url, options) => {
      assert.ok(typeof options?.body === "string");
      bodies.push(JSON.parse(options.body));
      return Response.json({ answers: sampleAnswers });
    },
  });
  const body = bodies[0];
  assert.ok(body);
  assert.equal(body.model, "~typesafe/jev-latest");
  assert.deepEqual(body.state, { safe: true });
  await assert.rejects(callJevDecision({ OPENROUTER_API_KEY: "key" }, {
    state: "not json", questions: captureAssessmentQuestions,
    fetcher: async () => assert.fail("invalid state must not reach provider"),
  }), /state must be a JSON object/);
  await assert.rejects(callJevDecision({ OPENROUTER_API_KEY: "key" }, {
    state: "[]", questions: captureAssessmentQuestions,
    fetcher: async () => assert.fail("array state must not reach provider"),
  }), /state must be a JSON object/);
});

test("fixed JEV schemas declare expected answer keys", () => {
  assert.deepEqual(Object.keys(captureAssessmentQuestions), ["duration_review", "recommendation", "risk"]);
});
