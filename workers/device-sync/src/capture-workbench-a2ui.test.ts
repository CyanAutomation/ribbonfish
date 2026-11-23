import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  createCaptureWorkbenchA2uiMessage,
  parseCaptureWorkbenchAction,
  renderCaptureWorkbenchA2ui,
  renderCaptureWorkbenchA2uiMessage,
} from "../public/admin/capture-workbench-a2ui.ts";

const target = {
  capture_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Status page",
  display_url: "https://status.example/",
  next_due_at: 2_000,
  last_success_at: 1_000,
  screenshot_age_seconds: 120,
  recent_change_count: 1,
  unchanged_capture_streak: 2,
  recent_history: [{ captured_at: 1_000, changed: true }],
  duration_summary: {
    total_samples: 10,
    measured_sample_count: 8,
    reserve_estimated_sample_count: 2,
    measured_p50_ms: 2_000,
    measured_p90_ms: 4_000,
    reserve_estimated_p50_ms: 60_000,
    reserve_estimated_p90_ms: 60_000,
    failed_attempt_count: 1,
    retry_attempt_count: 2,
  },
};

test("capture workbench uses a fixed A2UI template and includes advisory history and duration facts", () => {
  const message = createCaptureWorkbenchA2uiMessage(target, {
    action: "capture",
    reason: "Keep the scheduled capture when evidence is insufficient.",
    suggestion: "skip_once",
    duration_review: "review_overestimate",
    risk: { score: 0, label: "Low" },
    observed_result: "changed",
    skip_eligibility: { eligible: true, due_at: 2_000 },
  });

  assert.equal(message.createSurface.catalogId, "https://ribbonfish.dev/a2ui/catalogs/management-v2.json");
  assert.deepEqual(message.createSurface.components.filter(({ component }) => component === "Button").map(({ id }) => id), [
    "assessButton", "confirmSkipButton",
  ]);
  assert.match(JSON.stringify(message.createSurface.dataModel), /measured: p50/i);
  assert.match(JSON.stringify(message.createSurface.dataModel), /estimated reserve duration: p50/i);
  assert.match(JSON.stringify(message.createSurface.dataModel), /changed/);
  assert.match(JSON.stringify(message.createSurface.dataModel), /reserve overestimate/i);
  assert.doesNotMatch(JSON.stringify(message), /sha256|screenshot bytes|last_error/);
});

test("capture workbench renders safe text and dispatches only the declared assessment event", async () => {
  const dom = new JSDOM("<div id='workbench'></div>");
  const container = dom.window.document.querySelector<HTMLElement>("#workbench");
  assert.ok(container);
  const actions: unknown[] = [];
  renderCaptureWorkbenchA2ui(container, { ...target, name: "<img src=x>" }, undefined, async (action) => {
    actions.push(action);
  });

  assert.equal(container.querySelector("img"), null);
  assert.match(container.textContent ?? "", /<img src=x>/);
  const button = container.querySelector<HTMLButtonElement>("button[data-a2ui-event='assess_capture']");
  assert.ok(button);
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(actions, [{
    name: "assess_capture",
    context: { capture_id: target.capture_id },
    sourceComponentId: "assessButton",
  }]);
  dom.window.close();
});

test("capture workbench rejects unknown actions and keeps the existing DOM on invalid input", () => {
  const dom = new JSDOM("<div id='workbench'><p>previous</p></div>");
  const container = dom.window.document.querySelector<HTMLElement>("#workbench");
  assert.ok(container);
  const message = structuredClone(createCaptureWorkbenchA2uiMessage(target));
  message.createSurface.dataModel.capture_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  assert.throws(() => renderCaptureWorkbenchA2uiMessage(container, target, message, () => {}), /must be rendered from the supplied target/i);
  assert.equal(container.textContent, "previous");
  const unsupported = structuredClone(createCaptureWorkbenchA2uiMessage(target));
  const button = unsupported.createSurface.components.find(({ component }) => component === "Button");
  assert.ok(button);
  button.action = { event: { name: "delete_device", context: { device_id: "pi-office" } } };
  assert.throws(() => renderCaptureWorkbenchA2uiMessage(container, target, unsupported, () => {}), /unsupported action/i);
  assert.equal(container.textContent, "previous");
  dom.window.close();
});

test("capture workbench action parser binds assessment and skip confirmation to current eligibility", () => {
  const eligible = {
    suggestion: "skip_once",
    skip_eligibility: { eligible: true, due_at: 2_000 },
  };
  assert.deepEqual(parseCaptureWorkbenchAction({
    name: "assess_capture", context: { capture_id: target.capture_id }, sourceComponentId: "assessButton",
  }, target, eligible), { kind: "assess" });
  assert.deepEqual(parseCaptureWorkbenchAction({
    name: "confirm_skip_once", context: { capture_id: target.capture_id, due_at: 2_000 }, sourceComponentId: "confirmSkipButton",
  }, target, eligible), { kind: "confirm_skip_once", due_at: 2_000 });
  assert.equal(parseCaptureWorkbenchAction({
    name: "confirm_skip_once", context: { capture_id: target.capture_id, due_at: 1_000 }, sourceComponentId: "confirmSkipButton",
  }, target, eligible), null);
  assert.equal(parseCaptureWorkbenchAction({
    name: "confirm_skip_once", context: { capture_id: target.capture_id, due_at: 2_000, extra: true }, sourceComponentId: "confirmSkipButton",
  }, target, eligible), null);
  assert.equal(parseCaptureWorkbenchAction({
    name: "confirm_skip_once", context: { capture_id: target.capture_id, due_at: 2_000 }, sourceComponentId: "confirmSkipButton",
  }, target, { ...eligible, suggestion: "capture_now" }), null);
});
