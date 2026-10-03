import { runGit } from './exec.js';
import { getCommits } from './index.js';
import { SENSITIVE_EXCLUDES } from './sensitive.js';

// Read-only history queries used by the cherry-pick preflight. Refs and shas that come from
// users or models are validated before they reach git, so none can be read as an option.

const SAFE_REF = /^[\w][\w./@{}^~:+-]*$/;

const requireRef = (ref, what = 'ref') => {
  if (typeof ref !== 'string' || !SAFE_REF.test(ref) || ref.includes('..')) {
    throw new Error(`${what} must be a commit sha or a branch/tag name (got "${ref}")`);
  }
  return ref;
};

export const resolveCommit = async (cwd, ref) => {
  const { stdout, ok } = await runGit(cwd, ['rev-parse', '-q', '--verify', `${requireRef(ref, 'commit')}^{commit}`], { allowFailure: true });
  if (!ok) throw new Error(`"${ref}" is not a commit in this repository`);
  return stdout.trim();
};

export const getCommitDetails = async (cwd, sha) => {
  const { stdout } = await runGit(cwd, ['show', '-s', '--date=short', '--format=%H%x1f%P%x1f%an%x1f%ad%x1f%s%x1f%b', requireRef(sha, 'commit')]);
  const [full, parents, author, date, subject, body = ''] = stdout.split('\x1f');
  const parentList = parents.trim() ? parents.trim().split(' ') : [];
  return { sha: full.trim(), shortSha: full.trim().slice(0, 7), parents: parentList, author, date, subject, body: body.trim() };
};

// Files a commit changed relative to its first parent, with renames detected.
export const getCommitFiles = async (cwd, sha) => {
  const { stdout } = await runGit(cwd, ['diff-tree', '--no-commit-id', '-r', '-M', '--name-status', '-z', '--root', requireRef(sha, 'commit')]);
  const tokens = stdout.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i][0];
    if (status === 'R' || status === 'C') {
      files.push({ status, oldPath: tokens[i + 1], path: tokens[i + 2] });
      i += 3;
    } else {
      files.push({ status, path: tokens[i + 1] });
      i += 2;
    }
  }
  return files;
};

// Zero-context patch of one commit, for working out which old lines it touches.
export const getCommitPatch = async (cwd, sha) => {
  const { stdout } = await runGit(cwd, [
    '-c', 'core.quotepath=false', 'show', '--format=', '-U0', '--no-color', '--no-ext-diff', '-M', requireRef(sha, 'commit'),
  ]);
  return stdout;
};

export const isAncestor = async (cwd, ancestor, descendant) => {
  const { ok } = await runGit(cwd, ['merge-base', '--is-ancestor', requireRef(ancestor), requireRef(descendant)], { allowFailure: true });
  return ok;
};

// True when `target` already contains an equivalent change (same patch, different sha), as
// happens when a commit was cherry-picked before.
export const isPatchOnTarget = async (cwd, target, sha) => {
  const { stdout, ok } = await runGit(cwd, ['cherry', requireRef(target, 'target'), requireRef(sha, 'commit'), `${sha}^`], { allowFailure: true });
  return ok && stdout.split(/\r?\n/).some((line) => line.startsWith('- '));
};

// Commits that are in `rev` but not in `target`, newest first (rev's own ancestors, no merges).
export const commitsNotOnTarget = (cwd, target, rev, { paths = [], maxCount = 50 } = {}) =>
  getCommits(cwd, { revs: [`${requireRef(target, 'target')}..${requireRef(rev)}`], paths, maxCount });

// Which commit last touched each line of file[start..end] as it was at `rev`.
// Returns Map(sha -> [lineNumbers]).
export const blameShas = async (cwd, rev, file, start, end) => {
  const { stdout, ok } = await runGit(cwd, ['blame', '--porcelain', '-L', `${start},${end}`, requireRef(rev), '--', file], { allowFailure: true });
  const bySha = new Map();
  if (!ok) return bySha;
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{40}) \d+ (\d+)/);
    if (m) bySha.set(m[1], [...(bySha.get(m[1]) ?? []), Number(m[2])]);
  }
  return bySha;
};

export const grepAtRef = async (cwd, ref, word) => {
  const { ok } = await runGit(cwd, ['grep', '-q', '-w', '-I', '-F', '-e', word, requireRef(ref), '--', '.', ...SENSITIVE_EXCLUDES], { allowFailure: true });
  return ok;
};

export const fileExistsAtRef = async (cwd, ref, file) => {
  const { ok } = await runGit(cwd, ['cat-file', '-e', `${requireRef(ref)}:${file}`], { allowFailure: true });
  return ok;
};

export const readFileAtRef = async (cwd, ref, file) => {
  const { stdout, ok } = await runGit(cwd, ['show', `${requireRef(ref)}:${file}`], { allowFailure: true });
  return ok ? stdout : null;
};

// Commits in `range` (like "target..sha^") where the number of occurrences of `text` changed:
// the commits that introduced or removed it.
export const commitsChangingText = async (cwd, text, { range, paths = [], maxCount = 5 }) => {
  const { stdout } = await runGit(cwd, [
    'log', '--no-merges', '--date=short', `--max-count=${maxCount}`, '--format=%H%x1f%an%x1f%ad%x1f%s%x1f%b%x1e',
    `-S${text}`, range, ...(paths.length > 0 ? ['--', ...paths] : []),
  ]);
  return stdout
    .split('\x1e')
    .map((record) => record.replace(/^\r?\n/, ''))
    .filter((record) => record.trim())
    .map((record) => {
      const [sha, author, date, subject, body = ''] = record.split('\x1f');
      return { sha, shortSha: sha.slice(0, 7), author, date, subject, body: body.trim() };
    });
};

// Commits in `range` that added `path`.
export const commitsAddingFile = async (cwd, range, file) => {
  const { stdout } = await runGit(cwd, ['log', '--no-merges', '--diff-filter=A', '--format=%H%x1f%s', range, '--', file]);
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split('\x1f');
      return { sha, shortSha: sha.slice(0, 7), subject };
    });
};

// Local branches and remote-tracking branches other than `exclude`.
export const listOtherBranches = async (cwd, exclude = []) => {
  const { stdout } = await runGit(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']);
  return stdout
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter((name) => name && !name.endsWith('/HEAD') && !exclude.includes(name) && SAFE_REF.test(name));
};

export const isShallowRepository = async (cwd) => {
  const { stdout } = await runGit(cwd, ['rev-parse', '--is-shallow-repository'], { allowFailure: true });
  return stdout.trim() === 'true';
};

export const isWorkingTreeClean = async (cwd) => {
  const { stdout } = await runGit(cwd, ['status', '--porcelain', '--untracked-files=no']);
  return stdout.trim() === '';
};

// Every non-merge commit in `rev` that `target` lacks, oldest first (the order to apply them in).
export const listUnmergedShas = async (cwd, target, rev, maxCount = 500) => {
  const { stdout } = await runGit(cwd, ['rev-list', '--reverse', '--no-merges', `--max-count=${maxCount}`, `${requireRef(target, 'target')}..${requireRef(rev)}`]);
  return stdout.split(/\r?\n/).filter(Boolean);
};
