export type ConfirmedActionOptions = {
  confirmAndPerform: () => Promise<boolean>;
  successMessage: string;
  context: string;
  showMessage: (message: string, isError?: boolean, context?: string) => void;
  refresh: () => unknown;
};

export async function runConfirmedAction({
  confirmAndPerform,
  successMessage,
  context,
  showMessage,
  refresh,
}: ConfirmedActionOptions): Promise<void> {
  try {
    if (!await confirmAndPerform()) return;
    showMessage(successMessage, false, context);
    await refresh();
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error), true, context);
  }
}
