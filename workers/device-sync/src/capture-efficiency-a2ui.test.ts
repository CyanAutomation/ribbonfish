import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { a2uiMetricCardComponents } from "../public/admin/a2ui-components.ts";
import {
  createCaptureEfficiencyA2uiMessage,
  renderCaptureEfficiencyA2ui,
  renderCaptureEfficiencyA2uiMessage,
} from "../public/admin/capture-efficiency-a2ui.ts";

const efficiency = {
  last_30_days: {
    browser_run_ms: { response_header: 120_000, reserve: 60_000 },
    jev_shadow_assessments: 8,
    jev_candidate_deferrals: 3,
    jev_candidate_changed: 1,
    jev_candidate_unchanged: 1,
    jev_candidate_validator_unchanged: 1,
    jev_candidate_failed: 0,
    jev_candidate_budget_deferred: 0,
    jev_candidate_unobserved: 0,
    jev_candidate_quality_reviews: { complete: 1, incomplete: 1, uncertain: 0, total: 2 },
    screenshot_quality_reviews: { complete: 4, incomplete: 2, uncertain: 1 },
  },
};

test("shared A2UI metric card primitive builds a bound, reusable card subtree", () => {
  assert.deepEqual(a2uiMetricCardComponents("runtime", 2), [
    { id: "runtimeCard", component: "Card", child: "runtimeContent" },
    { id: "runtimeContent", component: "Column", children: ["runtimeLabel", "runtimeValue", "runtimeDetail"] },
    { id: "runtimeLabel", component: "Text", variant: "caption", text: { "@path": "/metrics/2/label" } },
    { id: "runtimeValue", component: "Text", variant: "body", text: { "@path": "/metrics/2/value" } },
    { id: "runtimeDetail", component: "Text", variant: "caption", text: { "@path": "/metrics/2/detail" } },
  ]);
});

test("Capture Efficiency summarizes usage, JEV outcomes, reviewed candidate quality, and reserve cues", () => {
  const message = createCaptureEfficiencyA2uiMessage([
    { duration_summary: { reserve_review: "possible_overestimate" } },
    { duration_summary: { reserve_review: "possible_underestimate" } },
    { duration_summary: { reserve_review: "insufficient_data" } },
    { capture_type: "api-dashboard", duration_summary: { reserve_review: "possible_overestimate" } },
  ], efficiency);

  assert.equal(message.createSurface.surfaceId, "captureEfficiency");
  assert.equal(message.createSurface.sendDataModel, false);
  assert.deepEqual(message.createSurface.dataModel.metrics, [
    {
      label: "Browser Run time sources",
      value: "Measured 2m 0s · reserve-estimated 1m 0s",
      detail: "Last 30 days. Measured and reserve-estimated time are reported separately.",
    },
    {
      label: "JEV capture advice",
      value: "8 assessments · 3 skip suggestions",
      detail: "Changed 1 · unchanged 1 · validator-only 1 · failed 0 · budget-deferred 0 · unobserved 0. Schedule changes: none.",
    },
    {
      label: "Reviewed JEV suggestions",
      value: "2 reviewed screenshots",
      detail: "Complete 1 · incomplete 1 · uncertain 0. These labels belong to screenshots captured for a JEV skip suggestion.",
    },
    {
      label: "Screenshot quality reviews",
      value: "Complete 4 · incomplete 2 · uncertain 1",
      detail: "Human reviews recorded in the last 30 days.",
    },
    {
      label: "Reserve review cues",
      value: "1 possible overestimate · 1 possible underestimate",
      detail: "1 site needs more measured data; 0 sites are not flagged. Cues do not change settings.",
    },
  ]);
  assert.equal(message.createSurface.components.filter((component) => component.component === "Card").length, 5);
});

test("Capture Efficiency honors an explicit zero reviewed total and falls back only when total is absent", () => {
  const explicitZero = createCaptureEfficiencyA2uiMessage([], {
    last_30_days: { jev_candidate_quality_reviews: { total: 0, complete: 1 } },
  }).createSurface.dataModel.metrics[2];
  const missingTotal = createCaptureEfficiencyA2uiMessage([], {
    last_30_days: { jev_candidate_quality_reviews: { complete: 1 } },
  }).createSurface.dataModel.metrics[2];

  assert.equal(explicitZero.value, "No reviewed screenshots from JEV skip suggestions yet");
  assert.equal(missingTotal.value, "1 reviewed screenshot");
});

test("Capture Efficiency A2UI renders as safe, read-only text and keeps an empty evidence state clear", () => {
  const dom = new JSDOM("<div id='summary'><p>previous</p></div>");
  const container = dom.window.document.querySelector<HTMLElement>("#summary");
  assert.ok(container);
  const message = createCaptureEfficiencyA2uiMessage([], {});
  message.createSurface.dataModel.metrics[1].detail = "<img src=x onerror=alert(1)>";

  renderCaptureEfficiencyA2ui(container, [], {});
  renderCaptureEfficiencyA2uiMessage(container, message);

  assert.equal(container.querySelector("img"), null);
  assert.match(container.textContent ?? "", /<img src=x onerror=alert\(1\)>/);
  assert.equal(container.querySelectorAll("button").length, 0);
  assert.match(container.textContent ?? "", /No reviewed screenshots from JEV skip suggestions yet/);
  assert.match(container.querySelector(".capture-efficiency-a2ui")?.getAttribute("aria-label") ?? "", /capture efficiency/i);
  dom.window.close();
});

test("Capture Efficiency A2UI renderer preserves the existing panel when its surface contract is invalid", () => {
  const dom = new JSDOM("<div id='summary'><p>previous</p></div>");
  const container = dom.window.document.querySelector<HTMLElement>("#summary");
  assert.ok(container);
  const message = createCaptureEfficiencyA2uiMessage([], efficiency);
  message.createSurface.components.push({ id: "unsafe", component: "Button" });

  assert.throws(() => renderCaptureEfficiencyA2uiMessage(container, message), /unsupported component/i);
  assert.equal(container.textContent, "previous");
  dom.window.close();
});
