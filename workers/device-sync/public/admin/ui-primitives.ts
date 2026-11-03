/** Small DOM primitives shared by the management views. Text is always inserted safely. */
export function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: unknown, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

export function button(text: string, variant = "primary"): HTMLButtonElement {
  const element = node("button", text, `button button--${variant}`);
  element.type = "button";
  return element;
}

export function statusBadge(text: string, tone = "success"): HTMLElement {
  return node("span", text, `badge badge--${tone}`);
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
