import path from 'node:path';
import { getRepoRoot } from '../../git/index.js';

const sameRoot = (a, b) => {
  const norm = (p) => path.resolve(p).replace(/[\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

// Every distinct Git repository among the open workspace folders.
export const findRepos = async ({ vscode, resolveRoot = getRepoRoot }) => {
  const repos = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    let root;
    try {
      root = await resolveRoot(folder.uri.fsPath);
    } catch {
      continue; // this folder is not inside a Git repository
    }
    if (!repos.some((r) => sameRoot(r.root, root))) repos.push({ root, name: path.basename(root) || folder.name });
  }
  return repos;
};

const REMEMBERED = 'mergeAssistant.repo';

// One repository: the only one, the one chosen earlier, or the user's pick when several are open.
export const chooseRepo = async ({ vscode, context, repos, ask = false }) => {
  if (repos.length === 0) return null;
  if (repos.length === 1) return repos[0];

  const remembered = context.workspaceState?.get(REMEMBERED);
  const previous = repos.find((r) => remembered && sameRoot(r.root, remembered));
  if (previous && !ask) return previous;

  const picked = await vscode.window.showQuickPick(
    repos.map((r) => ({ label: r.name, description: r.root, repo: r })),
    { title: 'Which repository?', placeHolder: 'Several Git repositories are open' }
  );
  if (!picked) return previous ?? null;
  await context.workspaceState?.update(REMEMBERED, picked.repo.root);
  return picked.repo;
};

export { sameRoot };
