import { lstat, mkdtemp, readdir, rmdir, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGit } from './exec.js';
import { listConflictedFiles } from './index.js';

// A throwaway checkout of another commit, so a cherry-pick can be tried without touching
// the user's working tree, index or branch.

export const createWorktree = async (cwd, ref) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mca-preflight-'));
  try {
    await runGit(cwd, ['worktree', 'add', '--detach', '--quiet', dir, ref]);
  } catch (error) {
    await rmdir(dir).catch(() => {});
    throw error;
  }
  return dir;
};

// Makes the repo's installed dependencies visible to the worktree through a link.
// Returns true when a link was created.
export const linkDependencies = async (cwd, worktree) => {
  const source = path.join(cwd, 'node_modules');
  const exists = await lstat(source).then((s) => s.isDirectory(), () => false);
  if (!exists) return false;
  try {
    // 'junction' needs no admin rights on Windows and is ignored on other platforms.
    await symlink(source, path.join(worktree, 'node_modules'), 'junction');
    return true;
  } catch {
    return false;
  }
};

// Removes only the link, never what it points at. If that cannot be done the error is
// thrown so the caller does not delete the worktree (which could follow the link).
export const unlinkDependencies = async (worktree) => {
  const link = path.join(worktree, 'node_modules');
  const info = await lstat(link).catch(() => null);
  if (!info) return;
  if (!info.isSymbolicLink()) return; // a real folder created inside the worktree, not ours
  try {
    await unlink(link);
  } catch {
    await rmdir(link); // Windows junctions are removed with rmdir
  }
  if (await lstat(link).then(() => true, () => false)) {
    throw new Error('could not remove the dependency link from the temporary worktree');
  }
};

export const removeWorktree = async (cwd, worktree) => {
  await unlinkDependencies(worktree);
  await runGit(cwd, ['worktree', 'remove', '--force', worktree], { allowFailure: true });
  await runGit(cwd, ['worktree', 'prune'], { allowFailure: true });
  const left = await readdir(worktree).then((names) => names.length, () => 0);
  return left === 0;
};

// Applies a commit's changes to the worktree without committing them.
export const cherryPickNoCommit = async (worktree, sha) => {
  const args = ['cherry-pick', '--no-commit', sha];
  const { ok, stdout, stderr } = await runGit(worktree, args, { allowFailure: true });
  if (ok) {
    const staged = await runGit(worktree, ['diff', '--cached', '--name-only']);
    return { status: staged.stdout.trim() ? 'clean' : 'empty', conflicts: [] };
  }
  const conflicts = await listConflictedFiles(worktree);
  if (conflicts.length > 0) return { status: 'conflict', conflicts };
  return { status: 'error', conflicts: [], message: (stderr || stdout).trim() };
};

// The real thing. Only called after the user approved the preflight report.
export const cherryPick = async (cwd, sha) => {
  const args = ['cherry-pick', sha];
  const { ok, stdout, stderr } = await runGit(cwd, args, { allowFailure: true });
  if (ok) return { status: 'applied', conflicts: [] };
  const conflicts = await listConflictedFiles(cwd);
  if (conflicts.length > 0) return { status: 'conflict', conflicts };
  return { status: 'error', conflicts: [], message: (stderr || stdout).trim() };
};
