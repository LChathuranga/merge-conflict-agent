import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './exec.js';
import { describeCommit, getCurrentBranch, listConflictedFiles } from './index.js';
import { getCommitDetails, isAncestor, isWorkingTreeClean, listOtherBranches, requireRef, resolveCommit } from './history.js';

// Starting and aborting a merge. The merge is always run with --no-commit, so this module
// never creates a commit: the result waits in the working tree for the user to review and
// commit. Nothing here stages files on its own beyond what `git merge` itself does.

// Git records a multi-step operation as a marker file (or folder) in the git directory.
// Reading those directly costs one git call instead of one per marker; this runs on every refresh.
const OPERATION_MARKERS = [
  ['merge', 'MERGE_HEAD'],
  ['cherry-pick', 'CHERRY_PICK_HEAD'],
  ['revert', 'REVERT_HEAD'],
  ['rebase', 'REBASE_HEAD'],
  ['rebase', 'rebase-merge'],
  ['rebase', 'rebase-apply'],
];

const gitDirOf = async (cwd) => {
  const { stdout, ok } = await runGit(cwd, ['rev-parse', '--git-dir'], { allowFailure: true });
  return ok ? path.resolve(cwd, stdout.trim()) : null;
};

const markerPresent = (gitDir, name) => stat(path.join(gitDir, name)).then(() => true, () => false);

// Which multi-step Git operation is currently waiting for the user, if any.
export const pendingOperation = async (cwd, gitDir = null) => {
  const dir = gitDir ?? (await gitDirOf(cwd));
  if (!dir) return null;
  const present = await Promise.all(OPERATION_MARKERS.map(([, name]) => markerPresent(dir, name)));
  const index = present.indexOf(true);
  return index === -1 ? null : OPERATION_MARKERS[index][0];
};

// The operations this tool can walk a person through: both stop with conflict markers to resolve.
export const isResolvable = (operation) => operation === 'merge' || operation === 'cherry-pick';

export const getMergeState = async (cwd) => {
  const gitDir = await gitDirOf(cwd);
  const [branch, operation, conflictedFiles] = await Promise.all([
    getCurrentBranch(cwd),
    pendingOperation(cwd, gitDir),
    listConflictedFiles(cwd),
  ]);

  let theirs = null;
  if (operation === 'merge') {
    // An octopus merge lists several commits; the first is enough to name the other side.
    const sha = (await readFile(path.join(gitDir, 'MERGE_HEAD'), 'utf8')).trim().split(/\s+/)[0];
    theirs = { sha, label: await describeCommit(cwd, sha) };
  } else if (operation === 'cherry-pick') {
    // The commit being replayed, named by what it did rather than by a bare hash.
    const sha = (await readFile(path.join(gitDir, 'CHERRY_PICK_HEAD'), 'utf8')).trim().split(/\s+/)[0];
    const details = await getCommitDetails(cwd, sha).catch(() => null);
    theirs = { sha, label: details ? `${details.shortSha} "${details.subject}"` : sha.slice(0, 7) };
  }

  return {
    branch,
    detached: branch === 'HEAD',
    operation,
    inProgress: operation === 'merge',
    // A merge or a cherry-pick: something with conflicts this tool can help finish.
    resolvable: isResolvable(operation),
    theirs,
    conflictedFiles,
  };
};

// Branches that have commits HEAD lacks, with how many; the others have nothing to merge.
export const listMergeCandidates = async (cwd) => {
  const current = await getCurrentBranch(cwd);
  const counted = await Promise.all(
    (await listOtherBranches(cwd, [current])).map(async (name) => {
      const { stdout, ok } = await runGit(cwd, ['rev-list', '--count', `HEAD..${name}`], { allowFailure: true });
      return { name, ahead: ok ? Number.parseInt(stdout.trim(), 10) : 0 };
    })
  );
  return counted.filter((c) => c.ahead > 0).sort((a, b) => a.name.localeCompare(b.name));
};

const refused = (reason, message) => ({ status: 'refused', reason, message, conflicts: [] });

// Result status:
//   conflicts   merge started, `conflicts` lists the files that need resolving
//   clean       merge started with no conflicts, waiting for the user to commit
//   up-to-date  nothing to merge, nothing was run
//   refused     a precondition failed (reason: operation-in-progress | dirty-tree | detached-head), nothing was run
//   error       git itself failed (untracked file collision, unrelated histories, ...); `message` is git's own text
// Throws for a branch name that is unsafe or is not a commit in this repository.
export const startMerge = async (cwd, branch, { allowDetached = false } = {}) => {
  requireRef(branch, 'branch');
  await resolveCommit(cwd, branch);

  const operation = await pendingOperation(cwd);
  if (operation) {
    return refused('operation-in-progress', `A ${operation} is already in progress. Finish or abort it before starting a merge.`);
  }
  if (!(await isWorkingTreeClean(cwd))) {
    return refused('dirty-tree', 'There are uncommitted changes to tracked files. Commit or stash them before merging.');
  }
  if (!allowDetached && (await getCurrentBranch(cwd)) === 'HEAD') {
    return refused('detached-head', 'HEAD is detached, so the merge result would not belong to any branch.');
  }
  if (await isAncestor(cwd, branch, 'HEAD')) {
    return { status: 'up-to-date', message: `${branch} is already part of the current branch.`, conflicts: [] };
  }

  const { ok, stdout, stderr } = await runGit(cwd, ['merge', '--no-ff', '--no-commit', '--no-edit', branch], { allowFailure: true });

  // Decide from the repository state, not from git's (translated) wording.
  const merging = await pendingOperation(cwd).then((op) => op === 'merge');
  const conflicts = merging ? await listConflictedFiles(cwd) : [];
  if (conflicts.length > 0) return { status: 'conflicts', conflicts };
  if (merging) return { status: 'clean', conflicts: [] };
  return { status: 'error', conflicts: [], message: (stderr || stdout).trim() || (ok ? 'git merge did not start a merge' : 'git merge failed') };
};

// Discards the merge and every resolution made since it started.
export const abortMerge = async (cwd) => {
  if ((await pendingOperation(cwd)) !== 'merge') return refused('no-merge', 'No merge is in progress.');
  const { ok, stdout, stderr } = await runGit(cwd, ['merge', '--abort'], { allowFailure: true });
  if (!ok) return { status: 'error', conflicts: [], message: (stderr || stdout).trim() || 'git merge --abort failed' };
  return { status: 'aborted', conflicts: [] };
};

// Discards a merge or a cherry-pick and every resolution made since it started. Any other
// operation (a rebase, a revert) is left alone: it is not ours to abort.
export const abortOperation = async (cwd) => {
  const operation = await pendingOperation(cwd);
  if (!isResolvable(operation)) {
    return operation
      ? refused('other-operation', `A ${operation} is in progress. Finish or abort it yourself; this tool only handles merges and cherry-picks.`)
      : refused('no-operation', 'No merge or cherry-pick is in progress.');
  }
  const args = operation === 'merge' ? ['merge', '--abort'] : ['cherry-pick', '--abort'];
  const { ok, stdout, stderr } = await runGit(cwd, args, { allowFailure: true });
  if (!ok) return { status: 'error', conflicts: [], message: (stderr || stdout).trim() || `git ${args.join(' ')} failed` };
  return { status: 'aborted', operation, conflicts: [] };
};
