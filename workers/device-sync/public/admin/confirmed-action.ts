export type ConfirmedActionOptions = {
  confirmAndPerform: () => Promise<boolean>;
  successMessage: string;
  context: string;
  showMessage: (message: string, isError?: boolean, context?: string) => void;
};

export async function runConfirmedAction({
  confirmAndPerform,
  successMessage,
  context,
  showMessage,
}: ConfirmedActionOptions): Promise<void> {
  try {
    if (!await confirmAndPerform()) return;
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error), true, context);
    return;
  }

  showMessage(`${successMessage} Click Refresh data to load the latest status.`, false, context);
}
