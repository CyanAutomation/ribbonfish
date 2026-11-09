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
  const details = node("details", undefined, "action-disclosure");
  details.append(node("summary", label));
  const content = node("div", undefined, "action-disclosure__content");
  content.append(...actions);
  details.append(content);
  return details;
}

/** A reusable, consistently labelled value card for compact dashboard summaries. */
export function metricCard(label: string, value: string, detail?: string, ownerDocument: Document = document): HTMLElement {
  const card = node("article", undefined, "metric-card", ownerDocument);
  card.append(node("span", label, "metric-card__label", ownerDocument));
  card.append(node("strong", value, "metric-card__value", ownerDocument));
  if (detail) card.append(node("span", detail, "metric-card__detail", ownerDocument));
  return card;
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

export interface ScaleMeterSegment {
  value: number;
  className?: string;
  captureId?: string;
}

/** A reusable horizontal meter with accessible descriptions for reference markers. */
export function scaleMeter({
  label,
  value,
  valueLabel,
  max,
  maxLabel,
  fillTone = "brand",
  markers = [],
  segments,
  ownerDocument = document,
  className,
  captionClassName,
  trackClassName,
  fillClassName,
  markerClassName,
}: {
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
}): HTMLElement {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 1;
  const percent = (amount: number) => {
    const number = Number(amount);
    return Math.max(0, Math.min(100, Number.isFinite(number) ? (number / safeMax) * 100 : 0));
  };
  const markerDescription = markers.map((marker) => marker.label + ": " + marker.valueLabel).join("; ");
  const meter = node("div", undefined, "scale-meter scale-meter--" + fillTone + (className ? " " + className : ""), ownerDocument);
  meter.setAttribute("role", "img");
  meter.setAttribute("aria-label", (label + ": " + valueLabel + ". Scale from 0 to " + maxLabel + ". " + markerDescription).trim());

  const caption = node("div", undefined, "scale-meter__caption" + (captionClassName ? " " + captionClassName : ""), ownerDocument);
  caption.append(
    node("span", label, "scale-meter__label", ownerDocument),
    node("strong", valueLabel, "scale-meter__value", ownerDocument),
  );
  const track = node("div", undefined, "scale-meter__track" + (trackClassName ? " " + trackClassName : ""), ownerDocument);
  track.setAttribute("aria-hidden", "true");
  if (segments) {
    const stack = node("span", undefined, "scale-meter__stack browser-usage-chart__stack", ownerDocument);
    stack.setAttribute("aria-hidden", "true");
    stack.style.width = "100%";
    for (const segment of segments) {
      if (!Number.isFinite(segment.value) || segment.value <= 0) continue;
      const item = node("span", undefined, "scale-meter__segment browser-usage-chart__segment" + (segment.className ? " " + segment.className : ""), ownerDocument);
      item.style.width = percent(segment.value) + "%";
      if (segment.captureId) item.dataset.captureId = segment.captureId;
      stack.append(item);
    }
    track.append(stack);
  } else {
    const fill = node("span", undefined, "scale-meter__fill scale-meter__fill--" + fillTone + (fillClassName ? " " + fillClassName : ""), ownerDocument);
    fill.style.width = percent(value) + "%";
    track.append(fill);
  }
  for (const marker of markers) {
    if (!Number.isFinite(marker.value) || marker.value <= 0) continue;
    const line = node("span", undefined,
      "scale-meter__marker scale-meter__marker--" + marker.tone +
      (markerClassName ? " " + markerClassName : "") +
      (marker.className ? " " + marker.className : ""),
      ownerDocument,
    );
    line.setAttribute("aria-hidden", "true");
    line.style.left = percent(marker.value) + "%";
    line.title = marker.label + ": " + marker.valueLabel;
    if (marker.quotaMarker) line.dataset.quotaMarker = marker.quotaMarker;
    track.append(line);
  }
  meter.append(caption, track);
  return meter;
}
