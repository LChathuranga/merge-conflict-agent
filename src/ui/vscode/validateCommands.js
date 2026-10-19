import { access } from 'node:fs/promises';
import path from 'node:path';
import { isResolvable } from '../../git/merge.js';
import { planValidation, runValidation } from '../../agents/validationAgent.js';
import { describeEvent } from '../viewmodel/runSummary.js';

const RUN = 'Run Checks';

const existing = async (root, files) => {
  const found = await Promise.all(files.map((f) => access(path.join(root, f)).then(() => f, () => null)));
  return found.filter(Boolean);
};

const SOURCE_TEXT = {
  'package.json': 'the test, typecheck, lint and build scripts in package.json',
  '.merge-agent.json': 'the "validate" list in .merge-agent.json',
};

// Step 4. The checks are the repository's own commands, and after a merge the repository
// includes the code that was just merged in, so nothing runs until the user has seen the
// exact list. What is approved is what runs: the same plan object is shown and then executed.
export const validateCommands = ({ vscode, getRepo, session, runner, logger, plan = planValidation, execute = runValidation }) => ({
  async runChecks() {
    const repo = getRepo();
    if (!repo) {
      await vscode.window.showInformationMessage('Open a folder that contains a Git repository first.');
      return;
    }
    const { state } = session;
    if (!isResolvable(state.operation)) {
      await vscode.window.showInformationMessage('There is no merge in progress (or cherry-pick), so there is nothing to check.');
      return;
    }
    const unresolved = state.files.filter((f) => f.hunks.length > 0);
    if (unresolved.length > 0) {
      await vscode.window.showWarningMessage(
        `${unresolved.length} file${unresolved.length === 1 ? ' still has' : 's still have'} conflict markers (${unresolved.slice(0, 3).map((f) => f.path).join(', ')}${unresolved.length > 3 ? ', ...' : ''}). Resolve or fix them first: the checks need code that can run.`
      );
      return;
    }

    const focusedTests = await existing(repo.root, [...new Set(state.files.flatMap((f) => f.impact?.testFiles ?? []))]);
    const approved = await plan({ cwd: repo.root, focusedTests });
    if (approved.commands.length === 0) {
      await vscode.window.showInformationMessage(
        'No checks were found. Add a "test" (or "typecheck", "lint", "build") script to package.json, or a .merge-agent.json with a "validate" list.'
      );
      return;
    }

    const list = approved.commands.map((c, i) => `${i + 1}. ${c.name}: ${c.command}`).join('\n');
    const choice = await vscode.window.showWarningMessage(
      `Run ${approved.commands.length} check${approved.commands.length === 1 ? '' : 's'} on the merged code?`,
      {
        modal: true,
        detail: `${list}\n\nThese commands come from ${SOURCE_TEXT[approved.source] ?? 'the repository'}. The merge has just brought in code from another branch, which may have changed them, so review the list if you do not trust that branch. They run on this machine with your permissions.`,
      },
      RUN
    );
    if (choice !== RUN) return;

    logger.info(`checks: running ${approved.commands.map((c) => c.name).join(', ')}`);
    const result = await runner.run('validate', async ({ signal, report }) => {
      const outcome = await execute({
        cwd: repo.root,
        commands: approved.commands,
        signal,
        onEvent: (event) => {
          session.handleEvent(event);
          const { log, progress } = describeEvent(event);
          if (log) logger.info(log);
          if (progress) report(progress);
        },
      });
      session.setValidation({ ...outcome, source: approved.source });
      return outcome;
    }, { title: 'Running checks' });
    if (!result) return; // another task was already running

    for (const step of result.steps.filter((s) => s.output)) {
      logger.info(`--- ${step.name} (${step.status}) ---\n${step.output.trim()}`);
    }
    const failed = result.steps.find((s) => s.status === 'failed');

    if (result.cancelled) {
      await vscode.window.showWarningMessage('Checks cancelled. Nothing was changed.');
    } else if (result.passed) {
      const open = await vscode.window.showInformationMessage(
        `All ${result.steps.length} check${result.steps.length === 1 ? '' : 's'} passed. Review the changes, then stage and commit them in Source Control.`,
        'Open Source Control'
      );
      if (open) await vscode.commands.executeCommand('workbench.view.scm');
    } else {
      const choice2 = await vscode.window.showWarningMessage(
        `Check "${failed?.name ?? 'unknown'}" failed${failed?.timedOut ? ' (timed out)' : failed?.exitCode != null ? ` (exit ${failed.exitCode})` : ''}. The merged code is not ready to commit; see the log for the output.`,
        'Show Log'
      );
      if (choice2 === 'Show Log') logger.show(false);
    }
  },
});
