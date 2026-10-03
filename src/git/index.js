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
