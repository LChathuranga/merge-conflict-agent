// Runs one long task at a time (merge, resolve, validate) with a progress notification the
// user can cancel. Cancelling aborts the task's AbortSignal; the core stops at the next step.
export const createTaskRunner = ({ vscode, session, logger, onBusyChange = () => {} }) => {
  let current = null;
  const setBusy = async (busy) => {
    await vscode.commands.executeCommand('setContext', 'mergeAssistant.busy', busy);
    onBusyChange(busy);
  };
  const RUN_KINDS = new Set(['resolve', 'validate']);
  const BUSY_TEXT = { merge: 'starting a merge', resolve: 'resolving conflicts', validate: 'running checks', check: 'checking a cherry-pick' };

  return {
    get busy() { return current !== null; },
    get kind() { return current?.kind ?? null; },

    async run(kind, task, { title, cancellable = true } = {}) {
      if (current) {
        vscode.window.showWarningMessage(`Merge Assistant is already ${BUSY_TEXT[current.kind] ?? 'busy'}. Wait for it to finish or cancel it first.`);
        return undefined;
      }
      const controller = new AbortController();
      current = { kind, controller };
      if (RUN_KINDS.has(kind)) session.beginRun(kind);
      await setBusy(true);
      logger.info(`${kind}: started`);

      try {
        return await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title, cancellable },
          async (progress, token) => {
            token.onCancellationRequested(() => {
              logger.info(`${kind}: cancel requested`);
              controller.abort();
            });
            return task({ signal: controller.signal, report: (message) => progress.report({ message }) });
          }
        );
      } finally {
        current = null;
        if (RUN_KINDS.has(kind)) session.endRun();
        await setBusy(false);
        logger.info(`${kind}: finished`);
      }
    },

    cancel() {
      if (!current) return false;
      current.controller.abort();
      return true;
    },
  };
};
