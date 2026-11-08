import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  beginButtonBusy,
  createFormField,
  createSettingsGroup,
  metricCard,
  scaleMeter,
} from "../public/admin/ui-primitives.ts";
import { requiredElement, requiredElements, requiredFormControl } from "../public/admin/dom.ts";

function requiredMatch<T extends Element>(root: ParentNode, selector: string): T {
  const match = root.querySelector<T>(selector);
  if (!match) throw new Error(`Expected test markup matching ${selector}`);
  return match;
}

test("metric cards render labels and values as text in a reusable semantic component", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const document = dom.window.document;
  const card = metricCard("<img src=x onerror=alert(1)>", "10m 0s", "600000ms remaining", document);
  document.body.append(card);

  assert.equal(card.tagName, "ARTICLE");
  assert.equal(requiredMatch<HTMLElement>(card, ".metric-card__label").textContent, "<img src=x onerror=alert(1)>");
  assert.equal(requiredMatch<HTMLElement>(card, ".metric-card__value").textContent, "10m 0s");
  assert.equal(card.querySelector("img"), null, "label text is not parsed as markup");
  dom.window.close();
});

test("scale meters clamp fills and markers and describe the scale to assistive technology", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const document = dom.window.document;
  const meter = scaleMeter({
    label: "Forecast per day",
    value: 120,
    valueLabel: "2m 0s",
    max: 100,
    maxLabel: "1m 40s",
    markers: [
      { label: "Ribbonfish budget", value: 50, valueLabel: "50s", tone: "ribbonfish" },
      { label: "Cloudflare account allowance", value: 150, valueLabel: "2m 30s", tone: "cloudflare", quotaMarker: "free-plan" },
    ],
    ownerDocument: document,
  });
  document.body.append(meter);

  assert.equal(meter.getAttribute("role"), "img");
  assert.match(meter.getAttribute("aria-label") ?? "", /Forecast per day: 2m 0s/);
  assert.match(meter.getAttribute("aria-label") ?? "", /Cloudflare account allowance: 2m 30s/);
  assert.equal(requiredMatch<HTMLElement>(meter, ".scale-meter__fill").style.width, "100%");
  assert.deepEqual([...meter.querySelectorAll<HTMLElement>(".scale-meter__marker")].map((marker) => marker.style.left), ["50%", "100%"]);
  assert.equal(meter.querySelector("[data-quota-marker='free-plan']") !== null, true);
  dom.window.close();
});

test("scale meters can draw labelled site segments on the shared scale", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const meter = scaleMeter({
    label: "Forecast per day",
    value: 175,
    valueLabel: "2m 55s",
    max: 100,
    maxLabel: "1m 40s",
    segments: [
      { value: 25, captureId: "site-a", className: "site--a" },
      { value: 150, captureId: "site-b", className: "site--b" },
    ],
    ownerDocument: dom.window.document,
  });
  const stack = requiredMatch<HTMLElement>(meter, ".scale-meter__stack");
  const segments = [...meter.querySelectorAll<HTMLElement>(".scale-meter__segment")];

  assert.equal(stack.style.width, "100%", "the segment stack spans the track so percentage widths can resolve");
  assert.deepEqual(segments.map((segment) => segment.style.width), ["25%", "100%"]);
  assert.deepEqual(segments.map((segment) => segment.dataset.captureId), ["site-a", "site-b"]);
  dom.window.close();
});

test("requiredElement returns a typed match and explains missing required markup", () => {
  const dom = new JSDOM("<!doctype html><html><body><form id='site'><input name='name' value='Ada'><input name='choice' value='one'><input name='choice' value='two'></form><form id='other'></form></body></html>");
  const form = requiredElement<HTMLFormElement>(dom.window.document, "#site");
  assert.equal(form.tagName, "FORM");
  assert.throws(() => requiredElement(dom.window.document, "#missing"), /Required element not found: #missing/);
  assert.deepEqual(requiredElements<HTMLFormElement>(dom.window.document, "form").map((item) => item.id), ["site", "other"]);
  const input = requiredFormControl<HTMLInputElement>(form, "name");
  assert.equal(input.value, "Ada");
  assert.throws(() => requiredFormControl<HTMLInputElement>(form, "missing"), /Required form control not found: missing/);
  assert.throws(() => requiredFormControl<HTMLInputElement>(form, "choice"), /Required form control not found: choice/);
  dom.window.close();
});

test("form field components connect labels, help text, and recoverable errors", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const { document } = dom.window;
  const input = document.createElement("input");
  input.type = "text";
  const field = createFormField("Hostname", input, {
    id: "source-hostname",
    description: "Enter the public hostname for this status source.",
    ownerDocument: document,
  });
  document.body.append(field.element);

  assert.equal(field.element.tagName, "DIV");
  assert.equal(field.element.classList.contains("form-field"), true);
  assert.equal(field.element.querySelector("label")?.htmlFor, "source-hostname");
  assert.equal(field.control, input);
  assert.equal(input.getAttribute("aria-describedby"), "source-hostname-help");
  assert.equal(field.element.querySelector("#source-hostname-help")?.textContent,
    "Enter the public hostname for this status source.");

  field.setError("Enter a valid public hostname.");
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.equal(input.getAttribute("aria-describedby"), "source-hostname-help source-hostname-error");
  assert.equal(field.element.querySelector("#source-hostname-error")?.textContent,
    "Enter a valid public hostname.");

  field.setError();
  assert.equal(input.hasAttribute("aria-invalid"), false);
  assert.equal(input.getAttribute("aria-describedby"), "source-hostname-help");
  dom.window.close();
});

test("settings groups provide a labelled section and a reusable content slot", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const group = createSettingsGroup("Schedule and settings", {
    description: "Controls shared by playlists that use this site.",
    headingLevel: "h4",
    id: "site-schedule",
    ownerDocument: dom.window.document,
  });
  group.content.append(dom.window.document.createElement("select"));
  dom.window.document.body.append(group.element);

  assert.equal(group.element.tagName, "SECTION");
  assert.equal(group.element.getAttribute("aria-labelledby"), "site-schedule-title");
  assert.equal(group.element.querySelector("h4")?.textContent, "Schedule and settings");
  assert.equal(group.element.querySelector("#site-schedule-description")?.textContent,
    "Controls shared by playlists that use this site.");
  assert.equal(group.content.children.length, 1);
  dom.window.close();
});

test("busy button state disables duplicate actions and restores the original label", () => {
  const dom = new JSDOM("<!doctype html><html><body><button>Save changes</button><p role='status'></p></body></html>");
  const button = requiredMatch<HTMLButtonElement>(dom.window.document, "button");
  const status = requiredMatch<HTMLElement>(dom.window.document, "[role=status]");
  const finish = beginButtonBusy(button, "Saving changes…", status);

  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "Saving changes…");
  assert.equal(status.textContent, "Saving changes…");
  finish();
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Save changes");
  assert.equal(status.textContent, "");
  dom.window.close();
});
