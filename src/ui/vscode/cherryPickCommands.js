import { getCurrentBranch } from '../../git/index.js';
import { commitsNotOnTarget, isWorkingTreeClean, listOtherBranches } from '../../git/history.js';
import { getMergeState } from '../../git/merge.js';
import { applyCherryPick, runPreflight } from '../../preflight/index.js';
import { isAbort } from '../../util/abort.js';
import { ensureSaved } from './dirtyGuard.js';

const MAX_COMMITS = 50;
const APPLY = 'Apply Cherry-pick';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const LABEL = { safe: 'SAFE', conditional: 'CONDITIONAL', risky: 'RISKY', blocked: 'BLOCKED' };

// "Check Cherry-pick...": a report first (nothing is touched), then, unless the check is
// blocked, an optional confirmed Apply.
export const cherryPickCommands = ({ vscode, getRepo, runner, logger, gitState, preflight = runPreflight }) => {
  const report = vscode.window.createOutputChannel('Merge Assistant Report');
  const dispose = () => report.dispose();

  const pickCommit = async (repo) => {
    const branch = await getCurrentBranch(repo.root);
    const branches = await listOtherBranches(repo.root, [branch]);
    if (branches.length === 0) {
      await vscode.window.showInformationMessage('There is no other branch to cherry-pick from.');
      return null;
    }

    const source = await vscode.window.showQuickPick(
      branches.map((name) => ({ label: name })),
      { title: `Cherry-pick onto ${branch === 'HEAD' ? 'the detached HEAD' : branch}`, placeHolder: 'Which branch has the commit?' }
    );
    if (!source) return null;

    const commits = await commitsNotOnTarget(repo.root, 'HEAD', source.label, { maxCount: MAX_COMMITS });
    if (commits.length === 0) {
      await vscode.window.showInformationMessage(`${source.label} has no commits that this branch lacks.`);
      return null;
    }
    const picked = await vscode.window.showQuickPick(
      commits.map((c) => ({ label: `${c.shortSha}  ${c.subject}`, description: `${c.author}, ${c.date}`, sha: c.sha })),
      { title: `Commits on ${source.label} not on this branch`, placeHolder: 'Which commit would you cherry-pick?', matchOnDescription: true }
    );
    return picked?.sha ?? null;
  };

  // The real cherry-pick. Never offered for a blocked check; it needs a clean tree and an
  // explicit confirmation that says a commit will be created. A risky or conditional outcome
  // additionally needs the word "apply" typed. Conflicts continue into the normal flow.
  const apply = async (repo, sha, outcome) => {
    const state = await getMergeState(repo.root);
    if (state.operation) {
      await vscode.window.showWarningMessage(`A ${state.operation} is already in progress. Finish or abort it before cherry-picking.`);
      return;
    }
    if (!(await isWorkingTreeClean(repo.root))) {
      await vscode.window.showWarningMessage('There are uncommitted changes to tracked files. Commit or stash them before cherry-picking.');
      return;
    }

    const where = state.detached ? 'the detached HEAD' : `"${state.branch}"`;
    const confirm = await vscode.window.showWarningMessage(
      `Cherry-pick ${sha.slice(0, 7)} onto ${where}?`,
      {
        modal: true,
        detail: [
          `Check result: ${LABEL[outcome]}.`,
          'If it applies cleanly, Git creates a new commit right away. If it conflicts, it stops so you can resolve the conflicts here, and you can abort it.',
          state.detached ? 'HEAD is detached, so the result will not belong to any branch.' : null,
        ].filter(Boolean).join('\n'),
      },
      APPLY
    );
    if (confirm !== APPLY) return;

    if (outcome !== 'safe') {
      const typed = await vscode.window.showInputBox({
        title: `This check was ${LABEL[outcome]}`,
        prompt: 'Type "apply" to cherry-pick anyway. Read the report first if you have not.',
        ignoreFocusOut: true,
      });
      if (typed?.trim().toLowerCase() !== 'apply') return;
    }
    if (!(await ensureSaved({ vscode, root: repo.root, reason: 'The cherry-pick rewrites files in your working tree.' }))) return;

    let result;
    try {
      result = await runner.run('merge', () => applyCherryPick({ cwd: repo.root, commit: sha }), { title: `Cherry-picking ${sha.slice(0, 7)}...`, cancellable: false });
    } catch (error) {
      await vscode.window.showErrorMessage(`The cherry-pick did not start: ${error.message}`);
      return;
    }
    if (!result) return;
    logger.info(`cherry-pick ${sha.slice(0, 7)}: ${result.status}${result.conflicts.length ? ` (${result.conflicts.join(', ')})` : ''}`);
    await gitState?.refresh();

    if (result.status === 'applied') {
      await vscode.window.showInformationMessage(`Cherry-picked ${sha.slice(0, 7)}. Git created the commit.`);
    } else if (result.status === 'conflict') {
      await vscode.window.showInformationMessage(`The cherry-pick stopped: ${plural(result.conflicts.length, 'file')} with conflicts. Follow the steps in the Merge Assistant view; nothing is committed until you commit.`);
      await vscode.commands.executeCommand('mergeAssistant.steps.focus');
    } else {
      logger.error(`cherry-pick ${sha} failed: ${result.message}`);
      const stuck = await getMergeState(repo.root).then((s) => s.operation === 'cherry-pick', () => false);
      await vscode.window.showErrorMessage(`The cherry-pick failed: ${result.message}${stuck ? ' It is still in progress: use Abort to clear it.' : ''}`);
    }
  };

  return {
    dispose,
    async checkCherryPick() {
      const repo = getRepo();
      if (!repo) {
        await vscode.window.showInformationMessage('Open a folder that contains a Git repository first.');
        return;
      }
      const sha = await pickCommit(repo);
      if (!sha) return;

      let result;
      try {
        result = await runner.run('check', ({ signal, report: progress }) => preflight({
          cwd: repo.root,
          commit: sha,
          target: 'HEAD',
          signal,
          onEvent: (e) => {
            if (e.type === 'preflight-step') progress(`Checking ${e.step}...`);
          },
        }), { title: 'Checking the cherry-pick (your files are not touched)' });
      } catch (error) {
        if (isAbort(error)) {
          await vscode.window.showInformationMessage('Cherry-pick check cancelled. Nothing was changed.');
          return;
        }
        throw error;
      }
      if (!result) return; // another task was already running

      report.clear();
      for (const { text } of result.lines) report.appendLine(text);
      logger.info(`cherry-pick check ${sha.slice(0, 7)}: ${result.outcome}`);

      const buttons = ['Show Report', ...(result.outcome === 'blocked' ? [] : [APPLY, 'Copy Cherry-pick Command'])];
      const headline = result.findings.find((f) => f.level === result.outcome) ?? result.findings[0];
      const choice = await vscode.window.showInformationMessage(
        `Cherry-pick check: ${LABEL[result.outcome]} (local analysis only). ${headline?.text ?? ''} Your files were not touched.`,
        ...buttons
      );
      if (choice === 'Show Report') report.show(true);
      if (choice === 'Copy Cherry-pick Command') {
        await vscode.env.clipboard.writeText(`git cherry-pick ${sha}`);
        await vscode.window.showInformationMessage(`Copied "git cherry-pick ${sha.slice(0, 7)}". Run it yourself if you prefer.`);
      }
      if (choice === APPLY) await apply(repo, sha, result.outcome);
    },
  };
};
