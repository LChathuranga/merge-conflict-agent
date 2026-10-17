import path from 'node:path';
import { abortMerge, getMergeState, listMergeCandidates, startMerge } from '../../git/merge.js';
import { ensureSaved } from './dirtyGuard.js';
import { sameRoot } from './repo.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const mergeCommands = ({ vscode, getRepo, gitState, runner, logger }) => {
  const needRepo = () => {
    const repo = getRepo();
    if (!repo) vscode.window.showInformationMessage('Open a folder that contains a Git repository first.');
    return repo;
  };

  const reportMerge = async (result, branch) => {
    switch (result.status) {
      case 'conflicts':
        await vscode.window.showInformationMessage(`Merge started: ${plural(result.conflicts.length, 'file')} with conflicts. Follow the steps in the Merge Assistant view.`);
        break;
      case 'clean': {
        const open = await vscode.window.showInformationMessage(
          'Merged without conflicts. Nothing was committed: review the changes and commit them in Source Control.',
          'Open Source Control'
        );
        if (open) await vscode.commands.executeCommand('workbench.view.scm');
        break;
      }
      case 'up-to-date':
        await vscode.window.showInformationMessage(result.message);
        break;
      case 'refused':
        await vscode.window.showWarningMessage(result.message);
        break;
      default: {
        logger.error(`merge ${branch} failed: ${result.message}`);
        const choice = await vscode.window.showErrorMessage(`The merge did not start: ${result.message}`, 'Show Log');
        if (choice === 'Show Log') logger.show(false);
      }
    }
  };

  return {
    async mergeBranch() {
      const repo = needRepo();
      if (!repo) return;

      const state = await getMergeState(repo.root);
      if (state.operation) {
        await vscode.window.showWarningMessage(
          state.inProgress
            ? 'A merge is already in progress. Resolve it in the Merge Assistant view, or abort it first.'
            : `A ${state.operation} is already in progress. Finish or abort it before starting a merge.`
        );
        return;
      }

      const candidates = await listMergeCandidates(repo.root);
      if (candidates.length === 0) {
        await vscode.window.showInformationMessage('Nothing to merge: no other branch has commits that this branch lacks.');
        return;
      }

      const target = state.detached ? 'detached HEAD' : state.branch;
      const picked = await vscode.window.showQuickPick(
        candidates.map(({ name, ahead }) => ({ label: name, description: `${plural(ahead, 'commit')} to merge` })),
        { title: `Merge into ${target}`, placeHolder: 'Choose the branch to merge' }
      );
      if (!picked) return;

      const confirm = await vscode.window.showInformationMessage(
        `Merge "${picked.label}" into "${target}"?`,
        {
          modal: true,
          detail: [
            'This changes files in your working tree. No commit is created, and you can abort the merge afterwards.',
            state.detached ? 'HEAD is detached, so the result will not belong to any branch.' : null,
          ].filter(Boolean).join('\n'),
        },
        'Merge'
      );
      if (confirm !== 'Merge') return;
      if (!(await ensureSaved({ vscode, root: repo.root, reason: 'The merge rewrites files in your working tree.' }))) return;

      const result = await runner.run('merge', () => startMerge(repo.root, picked.label, { allowDetached: state.detached }), {
        title: `Merging ${picked.label}...`,
        cancellable: false,
      });
      if (!result) return;
      logger.info(`merge ${picked.label}: ${result.status}${result.conflicts.length ? ` (${result.conflicts.join(', ')})` : ''}`);

      await gitState.refresh();
      await reportMerge(result, picked.label);
      if (result.status === 'conflicts') await vscode.commands.executeCommand('mergeAssistant.steps.focus');
    },

    async abortMerge() {
      const repo = needRepo();
      if (!repo) return;

      const confirm = await vscode.window.showWarningMessage(
        'Abort the merge?',
        { modal: true, detail: 'This discards the merge and every conflict resolution made since it started, including edits you made by hand to the merged files.' },
        'Abort Merge'
      );
      if (confirm !== 'Abort Merge') return;

      const result = await abortMerge(repo.root);
      logger.info(`abort merge: ${result.status}`);
      await gitState.refresh();
      if (result.status === 'aborted') await vscode.window.showInformationMessage('Merge aborted. The branch is back as it was.');
      else await vscode.window.showWarningMessage(`The merge was not aborted: ${result.message}`);
    },

    refresh: () => gitState.refresh(),

    // Opens a conflicted file at a line. Only files inside the open repository are opened.
    async openConflict(file, line = 1) {
      const repo = getRepo();
      if (!repo || typeof file !== 'string') return;
      const target = path.resolve(repo.root, file);
      const relative = path.relative(repo.root, target);
      if (relative.startsWith('..') || path.isAbsolute(relative) || sameRoot(target, repo.root)) return;

      const position = Math.max(0, Number(line) - 1);
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target), {
        selection: new vscode.Range(position, 0, position, 0),
      });
    },
  };
};
