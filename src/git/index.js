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

// Generated or vendored files are noise when looking for who uses a symbol.
const GREP_EXCLUDES = [
  ':(exclude)node_modules',
  ':(exclude)dist',
  ':(exclude)build',
  ':(exclude)package-lock.json',
  ':(exclude)yarn.lock',
  ':(exclude)pnpm-lock.yaml',
  ':(exclude)*.min.js',
  ':(exclude)*.map',
];
const MAX_SNIPPET_CHARS = 160;
const MAX_DISTINCT_FILES = 200;

// Whole-word search of tracked files in the working tree.
// excludeRange: [firstLine, lastLine] inside excludeFile to ignore (the conflict hunk itself).
// Returns the first `maxResults` hits, the real total, and every distinct file that matched.
export const grepWord = async (cwd, word, { excludeFile, excludeRange, maxResults = 25 } = {}) => {
  const { stdout, stderr, ok } = await runGit(
    cwd,
    ['grep', '-n', '-w', '-I', '-F', '-e', word, '--', '.', ...GREP_EXCLUDES],
    { allowFailure: true }
  );
  // Exit status 1 just means "no match"; anything with stderr is a real failure.
  if (!ok && stderr.trim()) throw new Error(`git grep failed: ${stderr.trim()}`);

  const hits = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, lineText, text] = m;
    const lineNo = Number(lineText);
    if (file === excludeFile && excludeRange && lineNo >= excludeRange[0] && lineNo <= excludeRange[1]) continue;
    hits.push({ file, line: lineNo, text: text.trim().slice(0, MAX_SNIPPET_CHARS) });
  }

  return {
    references: hits.slice(0, maxResults),
    total: hits.length,
    files: [...new Set(hits.map((h) => h.file))].slice(0, MAX_DISTINCT_FILES),
  };
};

// Lines that mention `pattern` (extended regex) in tracked files, as { file, line, text }.
export const grepPattern = async (cwd, pattern) => {
  const { stdout, stderr, ok } = await runGit(
    cwd,
    ['grep', '-n', '-I', '-E', '-e', pattern, '--', '.', ...GREP_EXCLUDES],
    { allowFailure: true }
  );
  if (!ok && stderr.trim()) throw new Error(`git grep failed: ${stderr.trim()}`);

  return stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^(.+?):(\d+):(.*)$/))
    .filter(Boolean)
    .map(([, file, line, text]) => ({ file, line: Number(line), text: text.trim().slice(0, MAX_SNIPPET_CHARS) }));
};
