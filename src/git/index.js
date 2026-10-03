import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './exec.js';

export const getRepoRoot = async (cwd) => {
  const { stdout } = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  return stdout.trim();
};

export const getCurrentBranch = async (cwd) => {
  const { stdout } = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return stdout.trim();
};

// Paths (relative to repo root) with unresolved merge conflicts.
export const listConflictedFiles = async (cwd) => {
  const { stdout } = await runGit(cwd, ['diff', '--name-only', '--diff-filter=U', '-z']);
  return stdout.split('\0').filter(Boolean);
};

// Merge stages: 1 = common ancestor (base), 2 = ours, 3 = theirs.
// A stage is null when absent (e.g. add/add conflicts have no base).
export const getConflictStages = async (cwd, file) => {
  const read = async (stage) => {
    const { stdout, ok } = await runGit(cwd, ['show', `:${stage}:${file}`], { allowFailure: true });
    return ok ? stdout : null;
  };
  const [base, ours, theirs] = await Promise.all([read(1), read(2), read(3)]);
  return { base, ours, theirs };
};

// Working-tree content, including conflict markers.
export const readWorkingFile = async (cwd, file) => readFile(path.join(cwd, file), 'utf8');

export const stageFile = async (cwd, file) => {
  await runGit(cwd, ['add', '--', file]);
};

export const isMergeInProgress = async (cwd) => {
  const { ok } = await runGit(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFailure: true });
  return ok;
};

const verifyRef = async (cwd, ref) => {
  const { stdout, ok } = await runGit(cwd, ['rev-parse', '-q', '--verify', ref], { allowFailure: true });
  return ok ? stdout.trim() : null;
};

// Which operation left the repo conflicted, and the commit being brought in ("theirs").
// cherry-pick and rebase replay exactly one commit; a merge brings in a whole branch.
export const getOperationInProgress = async (cwd) => {
  const candidates = [
    ['merge', 'MERGE_HEAD', false],
    ['cherry-pick', 'CHERRY_PICK_HEAD', true],
    ['rebase', 'REBASE_HEAD', true],
  ];
  for (const [operation, ref, singleCommit] of candidates) {
    const theirsSha = await verifyRef(cwd, ref);
    if (theirsSha) return { operation, theirsSha, singleCommit };
  }
  return null;
};

export const getMergeBase = async (cwd, a, b) => {
  const { stdout, ok } = await runGit(cwd, ['merge-base', a, b], { allowFailure: true });
  return ok ? stdout.trim() : null;
};

// Human-friendly name for a commit (branch name when one points at it), else short sha.
export const describeCommit = async (cwd, sha) => {
  const { stdout, ok } = await runGit(
    cwd,
    ['name-rev', '--name-only', '--no-undefined', '--refs=refs/heads/*', '--refs=refs/remotes/*', sha],
    { allowFailure: true }
  );
  return (ok && stdout.trim()) || sha.slice(0, 7);
};

// Commits reachable from `revs` (no merge commits), optionally limited to `paths`.
// noWalk returns exactly the listed commits without walking their ancestors.
export const getCommits = async (cwd, { revs, paths = [], maxCount = 20, noWalk = false }) => {
  const args = [
    'log',
    '--no-merges',
    '--date=short',
    `--max-count=${maxCount}`,
    '--format=%H%x1f%an%x1f%ad%x1f%s%x1f%b%x1e',
    ...(noWalk ? ['--no-walk'] : []),
    ...revs,
    ...(paths.length > 0 ? ['--', ...paths] : []),
  ];
  const { stdout } = await runGit(cwd, args);
  return stdout
    .split('\x1e')
    .map((record) => record.replace(/^\r?\n/, ''))
    .filter((record) => record.trim())
    .map((record) => {
      const [sha, author, date, subject, body = ''] = record.split('\x1f');
      return { sha, shortSha: sha.slice(0, 7), author, date, subject, body: body.trim() };
    });
};
