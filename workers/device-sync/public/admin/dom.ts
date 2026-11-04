type RequiredAdminElementMap = {
  "#capture-filter": HTMLSelectElement;
  "#capture-search": HTMLInputElement;
  "#capture-site-form": HTMLFormElement;
  "#cancel-playlist-edit": HTMLButtonElement;
  "#confirm-cancel": HTMLButtonElement;
  "#confirm-dialog": HTMLDialogElement;
  "#confirm-submit": HTMLButtonElement;
  "#copy-secret": HTMLButtonElement;
  "#hide-secret": HTMLButtonElement;
  "#pending-enrollments-details": HTMLDetailsElement;
  "#playlist-editor": HTMLDetailsElement;
  "#playlist-form": HTMLFormElement;
  "#playlist-current-assets": HTMLElement;
  "#playlist-editor-summary": HTMLElement;
  "#playlist-feedback": HTMLElement;
  "#playlist-form-help": HTMLElement;
  "#playlist-submit": HTMLButtonElement;
  "#reload": HTMLButtonElement;
  "#playlist-form [name=rotation_interval]": HTMLSelectElement;
  "[name=assets]": HTMLInputElement;
  "button[type=submit]": HTMLButtonElement;
};

/** Resolve markup that is required by the page and retain its element type. */
export function requiredElement<K extends keyof RequiredAdminElementMap>(root: ParentNode, selector: K): RequiredAdminElementMap[K];
export function requiredElement<T extends Element = HTMLElement>(root: ParentNode, selector: string): T;
export function requiredElement<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Required element not found: ${selector}`);
  return element;
}

/** Resolve a typed snapshot of elements matching a selector. */
export function requiredElements<T extends Element = HTMLElement>(root: ParentNode, selector: string): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

/** Resolve a uniquely named form control while keeping its concrete control type. */
export function requiredFormControl<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
  form: HTMLFormElement,
  name: string,
): T {
  const control = form.elements.namedItem(name);
  if (!control || !("tagName" in control) || !("value" in control) ||
      !["INPUT", "SELECT", "TEXTAREA"].includes(control.tagName)) {
    throw new Error(`Required form control not found: ${name}`);
  }
  return control as unknown as T;
}
