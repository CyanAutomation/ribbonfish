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

export function statusBadge(text: string, tone = "success"): HTMLElement {
  return node("span", text, tone === "success" ? "badge" : "badge badge--" + tone);
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
