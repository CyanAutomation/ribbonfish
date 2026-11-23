/** Shared A2UI v1.0 component builders for fixed Ribbonfish management surfaces. */
export type ManagementA2uiComponent = Record<string, unknown> & {
  id: string;
  component: "Card" | "Column" | "Text" | "Badge" | "Button";
};

export type A2uiTextVariant = "caption" | "body";
export type A2uiBadgeTone = "success" | "warning" | "error" | "neutral";

export function a2uiBinding(path: string) {
  return { "@path": path };
}

export function a2uiColumn(id: string, children: string[]): ManagementA2uiComponent {
  return { id, component: "Column", children };
}

export function a2uiCard(id: string, child: string): ManagementA2uiComponent {
  return { id, component: "Card", child };
}

export function a2uiText(id: string, path: string, variant: A2uiTextVariant = "caption"): ManagementA2uiComponent {
  return { id, component: "Text", variant, text: a2uiBinding(path) };
}

export function a2uiBadge(id: string, path: string, tone: A2uiBadgeTone): ManagementA2uiComponent {
  return { id, component: "Badge", text: a2uiBinding(path), tone };
}

export function a2uiButton(
  id: string,
  textId: string,
  eventName: string,
  context: Record<string, unknown>,
): ManagementA2uiComponent {
  return {
    id,
    component: "Button",
    child: textId,
    action: { event: { name: eventName, context } },
  };
}
