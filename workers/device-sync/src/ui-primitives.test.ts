import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { metricCard, scaleMeter } from "../public/admin/ui-primitives.ts";
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
