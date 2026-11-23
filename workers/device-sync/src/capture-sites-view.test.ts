import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createCaptureTargetRenderer } from "../public/admin/capture-sites-view.ts";

test("capture workbench actions call the advisory route, then confirm an eligible one-time skip", async () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <button id="add-capture-site"></button>
    <dialog id="capture-site-dialog"><h2 id="capture-site-dialog-title"></h2>
      <form id="capture-site-form"></form>
      <form id="capture-site-edit-form"><input name="name"><select name="capture_interval_seconds"></select>
        <input name="wait_for_selector"><button data-save-site-changes></button><p id="capture-site-schedule-note"></p>
        <p id="capture-site-edit-feedback"></p></form>
      <section id="capture-site-assessment-result"><div id="capture-site-assessment-content"></div></section>
    </dialog>
    <div id="capture-site-view-toggle"><button data-capture-view="cards"></button><button data-capture-view="list"></button></div>
    <p id="capture-site-counts"></p>
    <div id="capture-site-filters">
      <button data-capture-filter="all"><span data-capture-count></span></button>
      <button data-capture-filter="attention"><span data-capture-count></span></button>
      <button data-capture-filter="ready"><span data-capture-count></span></button>
    </div>
    <div id="capture-target-list"></div><div id="capture-filter-empty"></div>
  </body></html>`, { url: "https://admin.test/" });
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });

  const requests: Array<{ url: string; body: unknown }> = [];
  const dueAt = Date.now() + 60_000;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const url = String(input);
    requests.push({ url, body });
    if (url === "/admin/api/jev/capture-assessment") return Response.json({
      suggestion: "skip_once",
      risk: { score: 0, label: "Low", confidence: 0.9 },
      skip_eligibility: { eligible: true, due_at: dueAt },
    });
    return Response.json({ ok: true });
  };

  try {
    let confirmations = 0;
    let refreshes = 0;
    const messages: string[] = [];
    const render = createCaptureTargetRenderer({
      getCaptureIntervalOptions: () => [{ label: "5 minutes", value: 300 }],
      filterCaptureTargets: () => {},
      showMessage: (message) => { messages.push(message); },
      refresh: async () => { refreshes += 1; },
      showConfirmDialog: async () => { confirmations += 1; return true; },
    });
    render([{
      capture_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      capture_type: "browser-screenshot",
      name: "Status page",
      display_url: "https://status.example/",
      sha256: "a".repeat(64),
      viewport: { width: 1280, height: 720 },
      capture_interval_seconds: 300,
      last_success_at: 1_000,
      screenshot_age_seconds: 1,
      next_due_at: dueAt,
      schedule_reviewed: true,
    }]);

    const assessment = document.querySelector<HTMLButtonElement>("[data-a2ui-event='assess_capture']");
    assert.ok(assessment);
    assessment.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(requests[0]?.url, "/admin/api/jev/capture-assessment");
    assert.deepEqual(requests[0]?.body, { capture_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const skip = document.querySelector<HTMLButtonElement>("[data-a2ui-event='confirm_skip_once']");
    assert.ok(skip, `${messages.join(" ")} | ${document.querySelector("#capture-target-list")?.textContent}`);
    skip.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(confirmations, 1);
    assert.equal(requests[1]?.url, "/admin/api/captures/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/skip-once");
    assert.deepEqual(requests[1]?.body, { due_at: dueAt });
    assert.equal(refreshes, 1);
    assert.match(messages.join(" "), /schedule is unchanged|skip is confirmed/i);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    dom.window.close();
  }
});
