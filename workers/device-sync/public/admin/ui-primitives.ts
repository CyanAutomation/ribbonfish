/** Small DOM primitives shared by the management views. Text is always inserted safely. */
export function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: unknown,
  className?: string,
  ownerDocument: Document = document,
): HTMLElementTagNameMap[K] {
  const element = ownerDocument.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

export function button(text: string, variant = "primary"): HTMLButtonElement {
  const element = node("button", text, "button button--" + variant);
  element.type = "button";
  return element;
}

export function linkButton(
  href: string,
  text: string,
  variant = "secondary",
  ownerDocument: Document = document,
): HTMLAnchorElement {
  const element = node("a", text, `button button--${variant}`, ownerDocument);
  element.href = href;
  return element;
}

export function statusBadge(text: string, tone = "success", ownerDocument: Document = document): HTMLElement {
  return node("span", text, tone === "success" ? "badge" : "badge badge--" + tone, ownerDocument);
}

export interface InlineCodeOptions {
  className?: string;
  ownerDocument?: Document;
}

/** Render an opaque identifier as text inside a reusable code element. */
export function inlineCode(value: string | number, options: InlineCodeOptions = {}): HTMLElement {
  const ownerDocument = options.ownerDocument ?? document;
  return node("code", value, ["inline-code", options.className].filter(Boolean).join(" "), ownerDocument);
}

export type DefinitionListValue = string | number | Node | null | undefined;

export interface DefinitionListItem {
  label: string;
  value: DefinitionListValue;
}

export interface DefinitionListOptions {
  className?: string;
  ownerDocument?: Document;
}

function appendDefinitionValue(target: HTMLElement, value: DefinitionListValue, ownerDocument: Document): void {
  const NodeConstructor = ownerDocument.defaultView?.Node;
  if (NodeConstructor && value instanceof NodeConstructor) {
    target.append(value as Node);
    return;
  }
  target.textContent = value === null || value === undefined ? "—" : String(value);
}

/** Render labelled operational data with the browser's native definition-list semantics. */
export function createDefinitionList(items: DefinitionListItem[], options: DefinitionListOptions = {}): HTMLDListElement {
  const ownerDocument = options.ownerDocument ?? document;
  const className = ["definition-list", options.className].filter(Boolean).join(" ");
  const list = node("dl", undefined, className, ownerDocument);
  items.forEach(({ label, value }) => {
    const item = node("div", undefined, undefined, ownerDocument);
    const term = node("dt", label, undefined, ownerDocument);
    const description = node("dd", undefined, undefined, ownerDocument);
    appendDefinitionValue(description, value, ownerDocument);
    item.append(term, description);
    list.append(item);
  });
  return list;
}

export interface DisclosureOptions {
  className?: string;
  contentClassName?: string;
  open?: boolean;
  ownerDocument?: Document;
}

/** Compose native, keyboard-accessible progressive disclosure from a label and content nodes. */
export function createDisclosure(
  label: string,
  contentNodes: HTMLElement[],
  options: DisclosureOptions = {},
): HTMLDetailsElement {
  const ownerDocument = options.ownerDocument ?? document;
  const className = ["disclosure", options.className].filter(Boolean).join(" ");
  const details = node("details", undefined, className, ownerDocument);
  details.open = options.open ?? false;
  const summary = node("summary", label, "disclosure__summary", ownerDocument);
  const content = node("div", undefined,
    ["disclosure__content", options.contentClassName].filter(Boolean).join(" "), ownerDocument);
  content.append(...contentNodes);
  details.append(summary, content);
  return details;
}

export type StatusNoticeTone = "success" | "info" | "error";

/** Set the visible text and assistive-technology semantics of a status notice. */
export function setStatusNotice(
  notice: HTMLElement,
  textElement: HTMLElement,
  message: string,
  tone: StatusNoticeTone,
): void {
  textElement.textContent = message;
  notice.classList.toggle("alert--success", tone === "success");
  notice.classList.toggle("alert--info", tone === "info");
  notice.classList.toggle("alert--error", tone === "error");
  notice.setAttribute("role", tone === "error" ? "alert" : "status");
  notice.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
  notice.hidden = false;
}

export interface FormFieldOptions {
  id?: string;
  description?: string;
  className?: string;
  controlFirst?: boolean;
  ownerDocument?: Document;
}

export interface FormFieldComponent {
  element: HTMLElement;
  control: HTMLElement;
  setError(message?: string): void;
}

let generatedFieldID = 0;

/** Build a labelled field with associated help and inline error text. */
export function createFormField(
  labelText: string,
  control: HTMLElement,
  options: FormFieldOptions = {},
): FormFieldComponent {
  const ownerDocument = options.ownerDocument ?? control.ownerDocument;
  const id = (options.id ?? control.id) || `management-field-${++generatedFieldID}`;
  control.id = id;

  const field = node("div", undefined, "form-field" + (options.className ? ` ${options.className}` : ""), ownerDocument);
  const label = node("label", undefined, "form-field__label", ownerDocument);
  label.htmlFor = id;
  const labelTextNode = node("span", labelText, "form-field__label-text", ownerDocument);
  if (options.controlFirst) label.append(control, labelTextNode);
  else label.append(labelTextNode, control);
  field.append(label);

  const helpID = `${id}-help`;
  if (options.description) {
    const help = node("p", options.description, "field-hint form-field__help", ownerDocument);
    help.id = helpID;
    field.append(help);
  }

  const error = node("p", undefined, "field-error form-field__error", ownerDocument);
  error.id = `${id}-error`;
  error.hidden = true;
  error.setAttribute("role", "alert");
  field.append(error);

  const setDescribedBy = (includeError: boolean) => {
    const descriptions = [options.description ? helpID : "", includeError ? error.id : ""].filter(Boolean);
    if (descriptions.length) control.setAttribute("aria-describedby", descriptions.join(" "));
    else control.removeAttribute("aria-describedby");
  };
  setDescribedBy(false);

  return {
    element: field,
    control,
    setError(message?: string) {
      const hasError = Boolean(message);
      error.textContent = message ?? "";
      error.hidden = !hasError;
      if (hasError) control.setAttribute("aria-invalid", "true");
      else control.removeAttribute("aria-invalid");
      setDescribedBy(hasError);
    },
  };
}

export interface SettingsGroupOptions {
  description?: string;
  headingLevel?: "h2" | "h3" | "h4";
  id?: string;
  className?: string;
  ownerDocument?: Document;
}

export interface SettingsGroupComponent {
  element: HTMLElement;
  content: HTMLElement;
  heading: HTMLHeadingElement;
}

let generatedGroupID = 0;

/** Create a named settings section whose controls can be composed by each view. */
export function createSettingsGroup(
  title: string,
  options: SettingsGroupOptions = {},
): SettingsGroupComponent {
  const ownerDocument = options.ownerDocument ?? document;
  const id = options.id ?? `management-settings-${++generatedGroupID}`;
  const group = node("section", undefined, "settings-group" + (options.className ? ` ${options.className}` : ""), ownerDocument);
  const heading = node(options.headingLevel ?? "h3", title, "settings-group__heading", ownerDocument);
  heading.id = `${id}-title`;
  group.setAttribute("aria-labelledby", heading.id);
  group.append(heading);

  if (options.description) {
    const description = node("p", options.description, "settings-group__description", ownerDocument);
    description.id = `${id}-description`;
    group.setAttribute("aria-describedby", description.id);
    group.append(description);
  }

  const content = node("div", undefined, "settings-group__content", ownerDocument);
  group.append(content);
  return { element: group, content, heading };
}

/** Disable a submitted action, announce progress, and restore it after the operation. */
export function beginButtonBusy(
  buttonElement: HTMLButtonElement,
  busyLabel: string,
  status?: HTMLElement,
): () => void {
  const originalLabel = buttonElement.textContent ?? "";
  const wasDisabled = buttonElement.disabled;
  const originalStatus = status?.textContent ?? "";
  const wasStatusHidden = status?.hidden ?? false;
  let finished = false;

  buttonElement.disabled = true;
  buttonElement.textContent = busyLabel;
  if (status) {
    status.textContent = busyLabel;
    status.hidden = false;
  }

  return () => {
    if (finished) return;
    finished = true;
    buttonElement.disabled = wasDisabled;
    buttonElement.textContent = originalLabel;
    if (status?.textContent === busyLabel) {
      status.textContent = originalStatus;
      status.hidden = wasStatusHidden;
    }
  };
}

/** Group infrequent actions behind a native keyboard-accessible disclosure. */
export function actionDisclosure(label: string, actions: HTMLElement[]): HTMLDetailsElement {
  return createDisclosure(label, actions, {
    className: "action-disclosure",
    contentClassName: "action-disclosure__content",
  });
}

/** A reusable, consistently labelled value card for compact dashboard summaries. */
export function metricCard(label: string, value: string, detail?: string, ownerDocument: Document = document): HTMLElement {
  const card = node("article", undefined, "metric-card", ownerDocument);
  card.append(node("span", label, "metric-card__label", ownerDocument));
  card.append(node("strong", value, "metric-card__value", ownerDocument));
  if (detail) card.append(node("span", detail, "metric-card__detail", ownerDocument));
  return card;
}

export interface MetricGridItem {
  label: string;
  value: string | number;
  detail?: string;
}

/** Compose a responsive set of reusable metric cards for readiness and dashboard summaries. */
export function createMetricGrid(
  items: MetricGridItem[],
  options: { className?: string; ownerDocument?: Document } = {},
): HTMLElement {
  const ownerDocument = options.ownerDocument ?? document;
  const grid = node("div", undefined, ["metric-grid", options.className].filter(Boolean).join(" "), ownerDocument);
  items.forEach(({ label, value, detail }) => grid.append(metricCard(label, String(value), detail, ownerDocument)));
  return grid;
}

export type ScaleMeterMarkerTone = "ribbonfish" | "cloudflare" | "worker-budget" | "free-plan";

export interface ScaleMeterMarker {
  label: string;
  value: number;
  valueLabel: string;
  tone: ScaleMeterMarkerTone;
  className?: string;
  quotaMarker?: string;
}

interface ScaleMeterSegment {
  value: number;
  className?: string;
  captureId?: string;
}

interface ScaleMeterOptions {
  label: string;
  value: number;
  valueLabel: string;
  max: number;
  maxLabel: string;
  fillTone?: "brand" | "forecast";
  markers?: ScaleMeterMarker[];
  segments?: ScaleMeterSegment[];
  ownerDocument?: Document;
  className?: string;
  captionClassName?: string;
  trackClassName?: string;
  fillClassName?: string;
  markerClassName?: string;
}

function scalePercent(amount: number, max: number): number {
  const number = Number(amount);
  return Math.max(0, Math.min(100, Number.isFinite(number) ? (number / max) * 100 : 0));
}

function scaleMeterRoot(options: ScaleMeterOptions, ownerDocument: Document): HTMLElement {
  const markerDescription = (options.markers ?? []).map((marker) => marker.label + ": " + marker.valueLabel).join("; ");
  const meter = node("div", undefined,
    "scale-meter scale-meter--" + (options.fillTone ?? "brand") + (options.className ? " " + options.className : ""),
    ownerDocument,
  );
  meter.setAttribute("role", "img");
  meter.setAttribute("aria-label", (
    options.label + ": " + options.valueLabel + ". Scale from 0 to " + options.maxLabel + ". " + markerDescription
  ).trim());
  return meter;
}

function scaleMeterCaption(options: ScaleMeterOptions, ownerDocument: Document): HTMLElement {
  const caption = node("div", undefined,
    "scale-meter__caption" + (options.captionClassName ? " " + options.captionClassName : ""), ownerDocument);
  caption.append(
    node("span", options.label, "scale-meter__label", ownerDocument),
    node("strong", options.valueLabel, "scale-meter__value", ownerDocument),
  );
  return caption;
}

function scaleMeterSegments(
  track: HTMLElement,
  segments: ScaleMeterSegment[],
  max: number,
  ownerDocument: Document,
): void {
  const stack = node("span", undefined, "scale-meter__stack browser-usage-chart__stack", ownerDocument);
  stack.setAttribute("aria-hidden", "true");
  stack.style.width = "100%";
  for (const segment of segments) {
    if (!Number.isFinite(segment.value) || segment.value <= 0) continue;
    const item = node("span", undefined,
      "scale-meter__segment browser-usage-chart__segment" + (segment.className ? " " + segment.className : ""),
      ownerDocument,
    );
    item.style.width = scalePercent(segment.value, max) + "%";
    if (segment.captureId) item.dataset.captureId = segment.captureId;
    stack.append(item);
  }
  track.append(stack);
}

function scaleMeterFill(
  track: HTMLElement,
  options: ScaleMeterOptions,
  max: number,
  ownerDocument: Document,
): void {
  const fillTone = options.fillTone ?? "brand";
  const fill = node("span", undefined,
    "scale-meter__fill scale-meter__fill--" + fillTone +
    (options.fillClassName ? " " + options.fillClassName : ""),
    ownerDocument,
  );
  fill.style.width = scalePercent(options.value, max) + "%";
  track.append(fill);
}

function scaleMeterMarkers(
  track: HTMLElement,
  markers: ScaleMeterMarker[],
  max: number,
  options: ScaleMeterOptions,
  ownerDocument: Document,
): void {
  for (const marker of markers) {
    if (!Number.isFinite(marker.value) || marker.value <= 0) continue;
    const line = node("span", undefined,
      "scale-meter__marker scale-meter__marker--" + marker.tone +
      (options.markerClassName ? " " + options.markerClassName : "") +
      (marker.className ? " " + marker.className : ""),
      ownerDocument,
    );
    line.setAttribute("aria-hidden", "true");
    line.style.left = scalePercent(marker.value, max) + "%";
    line.title = marker.label + ": " + marker.valueLabel;
    if (marker.quotaMarker) line.dataset.quotaMarker = marker.quotaMarker;
    track.append(line);
  }
}

/** A reusable horizontal meter with accessible descriptions for reference markers. */
export function scaleMeter(options: ScaleMeterOptions): HTMLElement {
  const ownerDocument = options.ownerDocument ?? document;
  const max = Number.isFinite(options.max) && options.max > 0 ? options.max : 1;
  const markers = options.markers ?? [];
  const meter = scaleMeterRoot(options, ownerDocument);
  const caption = scaleMeterCaption(options, ownerDocument);
  const track = node("div", undefined,
    "scale-meter__track" + (options.trackClassName ? " " + options.trackClassName : ""), ownerDocument);
  track.setAttribute("aria-hidden", "true");
  if (options.segments) scaleMeterSegments(track, options.segments, max, ownerDocument);
  else scaleMeterFill(track, options, max, ownerDocument);
  scaleMeterMarkers(track, markers, max, options, ownerDocument);
  meter.append(caption, track);
  return meter;
}
