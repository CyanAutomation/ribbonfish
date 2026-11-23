import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createScreenshotQualityReview } from "../public/admin/ui-components.ts";

test("screenshot quality review is a reusable accessible control for the three review labels", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const saved: string[] = [];
  const control = createScreenshotQualityReview({
    value: "uncertain",
    ownerDocument: dom.window.document,
    onSave: async (quality) => { saved.push(quality); },
  });
  dom.window.document.body.append(control);

  const select = control.querySelector<HTMLSelectElement>("select[aria-label='Screenshot completeness']");
  assert.ok(select);
  assert.deepEqual([...select.options].map((option) => option.value), ["", "complete", "incomplete", "uncertain"]);
  assert.equal(select.value, "uncertain");
  select.value = "complete";
  control.querySelector<HTMLButtonElement>("button")?.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(saved, ["complete"]);
  assert.match(control.textContent ?? "", /review saved/i);
  dom.window.close();
});

test("screenshot quality review requires a choice and announces save failures", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  let saves = 0;
  const control = createScreenshotQualityReview({
    ownerDocument: dom.window.document,
    onSave: async () => { saves += 1; throw new Error("review failed"); },
  });
  const button = control.querySelector<HTMLButtonElement>("button");
  const status = control.querySelector<HTMLElement>("[role='status']");
  assert.ok(button);
  assert.ok(status);
  button.click();
  assert.equal(saves, 0);
  assert.match(status.textContent ?? "", /choose/i);

  const select = control.querySelector<HTMLSelectElement>("select");
  assert.ok(select);
  select.value = "incomplete";
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(status.getAttribute("role"), "alert");
  assert.match(status.textContent ?? "", /review failed/);
  dom.window.close();
});
