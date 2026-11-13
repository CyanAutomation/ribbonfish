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
import {
  createBrandLockup,
  createLoadingIndicator,
  createPageHeader,
  createRefreshCoordinator,
  createToolbar,
  setPageHeaderMetadata,
} from "../public/admin/ui-components.ts";
import { createSingleFlight } from "../public/admin/ui-utils.ts";
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

test("brand lockup is a reusable, accessible component with replaceable identity", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const lockup = createBrandLockup({
    brandName: "Ribbonfish",
    markSrc: "/admin/ribbonfish-mark.svg",
    orientation: "stacked",
    ownerDocument: dom.window.document,
  });
  dom.window.document.body.append(lockup);

  assert.equal(lockup.classList.contains("brand-lockup"), true);
  assert.equal(lockup.querySelector("img")?.getAttribute("src"), "/admin/ribbonfish-mark.svg");
  assert.equal(lockup.querySelector("img")?.getAttribute("alt"), "");
  assert.equal(lockup.querySelector(".brand-lockup__name")?.textContent, "Ribbonfish");
  assert.equal(lockup.classList.contains("brand-lockup--stacked"), true);
  dom.window.close();
});

test("loading indicator announces work, counts concurrent callers, and restores its previous label", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const loading = createLoadingIndicator({ ownerDocument: dom.window.document });
  dom.window.document.body.append(loading.element);
  const label = loading.element.querySelector<HTMLElement>(".loading-indicator__label");
  assert.equal(loading.element.hidden, true);
  assert.equal(loading.element.getAttribute("role"), "status");
  assert.equal(loading.element.getAttribute("aria-live"), "polite");
  assert.equal(loading.element.querySelector("img")?.getAttribute("alt"), "");

  const finishRefresh = loading.begin("Refreshing data…");
  const finishSave = loading.begin("Saving changes…");
  assert.equal(loading.element.hidden, false);
  assert.equal(label?.textContent, "Saving changes…");
  finishSave();
  assert.equal(label?.textContent, "Refreshing data…");
  finishRefresh();
  assert.equal(loading.element.hidden, true);
  finishRefresh();
  assert.equal(loading.element.hidden, true, "finishing the same operation twice is harmless");
  dom.window.close();
});

test("refresh coordinator keeps background work quiet and protects unsaved forms", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const loading = createLoadingIndicator({ ownerDocument: dom.window.document });
  let dirty = true;
  let confirmations = 0;
  let loads = 0;
  const refresh = createRefreshCoordinator({
    operation: async () => { loads += 1; },
    hasUnsavedChanges: () => dirty,
    confirmDiscard: () => { confirmations += 1; return false; },
    loading,
  });

  await refresh("background");
  await refresh("initial");
  assert.equal(loads, 0);
  assert.equal(confirmations, 0);
  assert.equal(loading.element.hidden, true);
  await refresh("action");
  assert.equal(confirmations, 1);
  assert.equal(loads, 0, "a declined discard does not refresh");
  dom.window.close();
});

test("refresh coordinator deduplicates background/manual work and always clears busy state", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const loading = createLoadingIndicator({ ownerDocument: dom.window.document });
  let calls = 0;
  let rejectLoad: ((error: Error) => void) | undefined;
  const refresh = createRefreshCoordinator({
    operation: () => {
      calls += 1;
      return new Promise<void>((_resolve, reject) => { rejectLoad = reject; });
    },
    hasUnsavedChanges: () => false,
    confirmDiscard: () => true,
    loading,
  });

  const background = refresh("background");
  await Promise.resolve();
  const manual = refresh("manual");
  assert.equal(calls, 1);
  assert.equal(loading.element.hidden, false);
  assert.equal(loading.element.querySelector(".loading-indicator__label")?.textContent, "Refreshing Ribbonfish…");
  rejectLoad?.(new Error("network unavailable"));
  await assert.rejects(Promise.all([background, manual]), /network unavailable/);
  assert.equal(loading.element.hidden, true);
  dom.window.close();
});

test("single-flight calls share work, clear after rejection, and allow a later retry", async () => {
  let resolveTask: ((value: string) => void) | undefined;
  let calls = 0;
  const run = createSingleFlight(() => {
    calls += 1;
    return new Promise<string>((resolve) => { resolveTask = resolve; });
  });
  const first = run();
  const second = run();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  resolveTask?.("shared result");
  assert.deepEqual(await Promise.all([first, second]), ["shared result", "shared result"]);
  await Promise.resolve();

  let attempts = 0;
  const retryable = createSingleFlight(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary failure");
    return "recovered";
  });
  await assert.rejects(retryable(), /temporary failure/);
  assert.equal(await retryable(), "recovered");
  assert.equal(attempts, 2);
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

test("page headers render a named title, associated description, metadata, and actions", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const { document } = dom.window;
  const action = document.createElement("a");
  action.href = "#capture-site-editor";
  action.textContent = "Add site";
  const header = createPageHeader({
    eyebrow: "Sites",
    title: "Capture sites",
    titleLevel: "h2",
    titleId: "sites-title",
    description: "Register pages and review their screenshot schedules.",
    metadata: ["12 sites", "Updated just now"],
    actions: [action],
    actionsLabel: "Capture site actions",
    ownerDocument: document,
  });
  document.body.append(header);

  const title = requiredMatch<HTMLHeadingElement>(header, "h2");
  const description = requiredMatch<HTMLElement>(header, ".page-header__description");
  const actions = requiredMatch<HTMLElement>(header, ".page-header__actions");
  assert.equal(header.tagName, "HEADER");
  assert.equal(title.textContent, "Capture sites");
  assert.equal(title.id, "sites-title");
  assert.equal(title.getAttribute("aria-describedby"), description.id);
  assert.match(description.textContent, /review their screenshot schedules/);
  assert.deepEqual([...header.querySelectorAll(".page-header__meta span")].map((item) => item.textContent), ["12 sites", "Updated just now"]);
  assert.equal(actions.getAttribute("role"), "group");
  assert.equal(actions.getAttribute("aria-label"), "Capture site actions");
  assert.equal(actions.querySelector("a"), action, "the caller's native action remains intact");
  dom.window.close();
});

test("toolbars group labeled native controls without imposing composite toolbar keyboard behavior", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const { document } = dom.window;
  const search = document.createElement("label");
  search.textContent = "Search sites";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  search.append(searchInput);
  const status = document.createElement("label");
  status.textContent = "Status";
  const statusSelect = document.createElement("select");
  status.append(statusSelect);
  const toolbar = createToolbar({
    label: "Capture site filters",
    groups: [
      { label: "Site search", items: [search] },
      { label: "Site status", items: [status] },
    ],
    className: "capture-filters",
    ownerDocument: document,
  });

  assert.equal(toolbar.getAttribute("role"), "group");
  assert.equal(toolbar.getAttribute("aria-label"), "Capture site filters");
  assert.notEqual(toolbar.getAttribute("role"), "toolbar", "ordinary controls do not claim composite toolbar behavior");
  assert.deepEqual([...toolbar.querySelectorAll(".toolbar__group")].map((group) => group.getAttribute("aria-label")), ["Site search", "Site status"]);
  assert.deepEqual([...toolbar.querySelectorAll("input, select")], [searchInput, statusSelect]);
  assert.equal(toolbar.classList.contains("toolbar"), true);
  assert.equal(toolbar.classList.contains("capture-filters"), true);
  dom.window.close();
});

test("page header status can be updated and cleared without rebuilding its title", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const header = createPageHeader({ title: "Devices", ownerDocument: dom.window.document });
  const metadata = requiredMatch<HTMLElement>(header, ".page-header__meta");
  assert.equal(metadata.hidden, true);
  assert.equal(metadata.getAttribute("role"), "status");
  assert.equal(metadata.getAttribute("aria-live"), "polite");

  setPageHeaderMetadata(header, ["10 devices", "2 awaiting approval"]);
  assert.equal(metadata.hidden, false);
  assert.deepEqual([...metadata.querySelectorAll("span")].map((item) => item.textContent), ["10 devices", "2 awaiting approval"]);
  assert.equal(header.querySelector("h1")?.textContent, "Devices");

  setPageHeaderMetadata(header, []);
  assert.equal(metadata.hidden, true);
  assert.equal(metadata.children.length, 0);
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
