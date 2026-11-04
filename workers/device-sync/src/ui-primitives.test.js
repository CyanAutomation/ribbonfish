import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { metricCard, scaleMeter } from "../public/admin/ui-primitives.ts";

test("metric cards render labels and values as text in a reusable semantic component", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const document = dom.window.document;
  const card = metricCard("<img src=x onerror=alert(1)>", "10m 0s", "600000ms remaining", document);
  document.body.append(card);

  assert.equal(card.tagName, "ARTICLE");
  assert.equal(card.querySelector(".metric-card__label").textContent, "<img src=x onerror=alert(1)>");
  assert.equal(card.querySelector(".metric-card__value").textContent, "10m 0s");
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
  assert.match(meter.getAttribute("aria-label"), /Forecast per day: 2m 0s/);
  assert.match(meter.getAttribute("aria-label"), /Cloudflare account allowance: 2m 30s/);
  assert.equal(meter.querySelector(".scale-meter__fill").style.width, "100%");
  assert.deepEqual([...meter.querySelectorAll(".scale-meter__marker")].map((marker) => marker.style.left), ["50%", "100%"]);
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
  const segments = [...meter.querySelectorAll(".scale-meter__segment")];

  assert.deepEqual(segments.map((segment) => segment.style.width), ["25%", "100%"]);
  assert.deepEqual(segments.map((segment) => segment.dataset.captureId), ["site-a", "site-b"]);
  dom.window.close();
});
