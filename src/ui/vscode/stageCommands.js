import { isResolvable } from '../../git/merge.js';
import { stageResolvedFiles } from '../../orchestrator/stage.js';
import { stageableFiles, stageNotes } from '../viewmodel/stageModel.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const STAGE = 'Stage Files';

// "Stage Resolved Files...": the only place the extension marks files as resolved, and only
// after the user has seen exactly which files and what the checks said. It never commits.
export const stageCommands = ({ vscode, getRepo, session, gitState, runner, logger, stage = stageResolvedFiles }) => ({
  async stageResolved() {
    const repo = getRepo();
    if (!repo) {
      await vscode.window.showInformationMessage('Open a folder that contains a Git repository first.');
      return;
    }
    const { state } = session;
    if (!isResolvable(state.operation)) {
      await vscode.window.showInformationMessage('There is no merge in progress, so there is nothing to stage. (A cherry-pick counts as a merge here.)');
      return;
    }
    if (runner.busy) {
      await vscode.window.showWarningMessage('Wait for the running task to finish (or cancel it) before staging.');
      return;
    }

    const ready = stageableFiles(state);
    if (ready.length === 0) {
      await vscode.window.showInformationMessage(
        'No files are ready to stage. Resolve the conflicts first. A file you fixed by hand can be staged with the + button in Source Control.'
      );
      return;
    }

    const { lines, severity } = stageNotes(state, ready);
    const ask = severity === 'danger' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const choice = await ask(
      `Stage ${plural(ready.length, 'resolved file')}?`,
      { modal: true, detail: lines.join('\n') },
      STAGE
    );
    if (choice !== STAGE) return;

    const result = await stage({ cwd: repo.root, files: ready });
    logger.info(`stage: ${result.staged.length} staged, ${result.refused.length} refused`);
    await gitState.refresh();

    if (result.refused.length > 0) {
      const why = result.refused.map((r) => `${r.file} ${r.reason}`).join('; ');
      await vscode.window.showWarningMessage(
        `Staged ${result.staged.length} of ${ready.length}. Not staged: ${why}.`
      );
      return;
    }
    const open = await vscode.window.showInformationMessage(
      `Staged ${plural(result.staged.length, 'file')}. Nothing was committed: review the changes, then commit them in Source Control.`,
      'Open Source Control'
    );
    if (open) await vscode.commands.executeCommand('workbench.view.scm');
  },
});
