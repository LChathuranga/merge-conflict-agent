import { getCurrentBranch } from '../../git/index.js';
import { commitsNotOnTarget, listOtherBranches } from '../../git/history.js';
import { runPreflight } from '../../preflight/index.js';
import { isAbort } from '../../util/abort.js';

const MAX_COMMITS = 50;

const LABEL = { safe: 'SAFE', conditional: 'CONDITIONAL', risky: 'RISKY', blocked: 'BLOCKED' };

// "Check Cherry-pick...": report only. It never applies the pick; it can hand over the git
// command to run yourself once the report looks acceptable.
export const cherryPickCommands = ({ vscode, getRepo, runner, logger, preflight = runPreflight }) => {
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

      const buttons = ['Show Report', ...(result.outcome === 'blocked' ? [] : ['Copy Cherry-pick Command'])];
      const headline = result.findings.find((f) => f.level === result.outcome) ?? result.findings[0];
      const choice = await vscode.window.showInformationMessage(
        `Cherry-pick check: ${LABEL[result.outcome]} (local analysis only). ${headline?.text ?? ''} Your files were not touched.`,
        ...buttons
      );
      if (choice === 'Show Report') report.show(true);
      if (choice === 'Copy Cherry-pick Command') {
        await vscode.env.clipboard.writeText(`git cherry-pick ${sha}`);
        await vscode.window.showInformationMessage(`Copied "git cherry-pick ${sha.slice(0, 7)}". Run it yourself when you are ready; Merge Assistant does not apply it.`);
      }
    },
  };
};
