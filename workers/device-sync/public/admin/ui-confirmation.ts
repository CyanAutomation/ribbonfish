export async function confirmBeforeAction<T>(confirmFn: (message: string) => boolean | Promise<boolean>, message: string, action: () => T | Promise<T>) {
  const { confirmed } = await confirmAction(confirmFn, message, action);
  return confirmed;
}

export async function confirmAction<T>(confirmFn: (message: string) => boolean | Promise<boolean>, message: string, action: () => T | Promise<T>) {
  if (typeof confirmFn !== "function") throw new TypeError("A confirmation function is required");
  if (!(await confirmFn(message))) return { confirmed: false, result: undefined };
  return { confirmed: true, result: await action() };
}
