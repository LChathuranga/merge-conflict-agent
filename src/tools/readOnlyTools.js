import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  blameLines,
  getCommits,
  getConflictStages,
  getOperationInProgress,
  grepWord,
  isCommitSha,
  showCommit,
} from '../git/index.js';
import { isSensitivePath } from '../git/sensitive.js';
import { findImporters } from '../agents/referenceAgent.js';

// Read-only tools a model may call. Nothing here writes, stages, or runs repo code, and
// every tool returns a string (errors included) so a bad call never crashes the agent.

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READ_LINES = 200;
const MAX_BLAME_LINES = 60;
const MAX_LOG_COMMITS = 30;
const MAX_REFERENCES = 40;
const MAX_STAGE_LINES = 250;

const toInt = (value, fallback, min, max) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const requireString = (value, name, maxLength = 300) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  if (value.length > maxLength || /[\0\r\n]/.test(value)) throw new Error(`${name} is not a valid value`);
  return value.trim();
};

const isOutside = (relative) => relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);

// Repo-relative posix path without touching the disk (for paths that may only exist in git).
export const normalizeRepoPath = (input) => {
  const value = requireString(input, 'path');
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('path is outside the repository');
  }
  if (isSensitivePath(normalized)) throw new Error('access to this path is blocked (it may hold secrets)');
  return normalized;
};

// Existing file inside the repo, after following symlinks.
export const resolveInsideRepo = async (cwd, input) => {
  const wanted = normalizeRepoPath(input);
  const root = await realpath(cwd);
  let real;
  try {
    real = await realpath(path.resolve(root, wanted));
  } catch {
    throw new Error(`file not found: ${wanted}`);
  }
  const relative = path.relative(root, real);
  if (isOutside(relative)) throw new Error('path is outside the repository');
  const posix = relative.split(path.sep).join('/');
  if (isSensitivePath(posix)) throw new Error('access to this path is blocked (it may hold secrets)');
  return { abs: real, rel: posix };
};

const numbered = (lines, firstLine) => lines.map((line, i) => `${firstLine + i}: ${line}`).join('\n');

const formatCommit = (c) => `${c.shortSha} ${c.date} ${c.author}: ${c.subject}${c.body ? `\n    ${c.body.slice(0, 300).replace(/\r?\n/g, '\n    ')}` : ''}`;

const SIDES = ['ours', 'theirs', 'both'];

export const createReadOnlyTools = ({ cwd }) => {
  const sideRevs = async (side) => {
    const operation = await getOperationInProgress(cwd);
    const theirs = operation?.theirsSha ?? null;
    if (side === 'theirs') {
      if (!theirs) throw new Error('no merge, cherry-pick or rebase is in progress, so there is no "theirs" side');
      return [theirs];
    }
    if (side === 'ours') return ['HEAD'];
    return theirs ? ['HEAD', theirs] : ['HEAD'];
  };

  return [
    {
      name: 'read_file',
      description: `Read lines of a file in the repository's working tree (line numbers are shown). At most ${MAX_READ_LINES} lines per call. Files that may hold secrets are blocked.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repo-relative path, e.g. src/price.js' },
          startLine: { type: 'integer', description: 'First line to read (default 1)' },
          endLine: { type: 'integer', description: `Last line to read (default startLine + ${MAX_READ_LINES - 1})` },
        },
        required: ['path'],
      },
      run: async ({ path: input, startLine, endLine }) => {
        const { abs, rel } = await resolveInsideRepo(cwd, input);
        const info = await stat(abs);
        if (!info.isFile()) throw new Error(`${rel} is not a file`);
        if (info.size > MAX_FILE_BYTES) throw new Error(`${rel} is too large to read`);
        const text = await readFile(abs, 'utf8');
        if (text.slice(0, 8000).includes('\0')) throw new Error(`${rel} looks like a binary file`);

        const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
        const from = toInt(startLine, 1, 1, Math.max(1, lines.length));
        const to = Math.min(toInt(endLine, from + MAX_READ_LINES - 1, from, lines.length), from + MAX_READ_LINES - 1, lines.length);
        const left = lines.length - to;
        const more = left > 0 ? `\n... (${left} more line${left === 1 ? '' : 's'}; ${lines.length} total)` : '';
        return `${rel} lines ${from}-${to}:\n${numbered(lines.slice(from - 1, to), from)}${more}`;
      },
    },
    {
      name: 'find_references',
      description: 'Find every whole-word occurrence of a name (function, constant, key) in the repository, as file:line: text.',
      parameters: {
        type: 'object',
        properties: { symbol: { type: 'string', description: 'The identifier to search for' } },
        required: ['symbol'],
      },
      run: async ({ symbol }) => {
        const word = requireString(symbol, 'symbol', 100);
        const { references, total } = await grepWord(cwd, word, { maxResults: MAX_REFERENCES });
        if (total === 0) return `No uses of "${word}" found.`;
        const lines = references.map((r) => `${r.file}:${r.line}: ${r.text}`);
        return `${total} use${total === 1 ? '' : 's'} of "${word}":\n${lines.join('\n')}${total > references.length ? `\n... and ${total - references.length} more` : ''}`;
      },
    },
    {
      name: 'list_importers',
      description: 'List the files that import a given JS/TS file through a relative path.',
      parameters: {
        type: 'object',
        properties: { file: { type: 'string', description: 'Repo-relative path of the imported file' } },
        required: ['file'],
      },
      run: async ({ file }) => {
        const rel = normalizeRepoPath(file);
        const importers = await findImporters({ cwd, file: rel });
        return importers.length === 0 ? `No files import ${rel} through a relative path.` : `Imported by:\n${importers.join('\n')}`;
      },
    },
    {
      name: 'get_conflict_stages',
      description: 'Show one version of a conflicted file from the merge: base (common ancestor), ours (the branch you are on) or theirs (the incoming change). Line numbers match that version.',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Repo-relative path of the conflicted file' },
          version: { type: 'string', enum: ['base', 'ours', 'theirs'] },
        },
        required: ['file', 'version'],
      },
      run: async ({ file, version }) => {
        const rel = normalizeRepoPath(file);
        if (!['base', 'ours', 'theirs'].includes(version)) throw new Error('version must be base, ours or theirs');
        const text = (await getConflictStages(cwd, rel))[version];
        if (text === null) return `${rel} has no "${version}" version (it was added or removed on that side).`;
        const lines = text.split(/\r?\n/);
        const shown = lines.slice(0, MAX_STAGE_LINES);
        const more = lines.length > shown.length ? `\n... (${lines.length - shown.length} more lines)` : '';
        return `${rel} (${version}):\n${numbered(shown, 1)}${more}`;
      },
    },
    {
      name: 'git_log',
      description: `Recent commits (newest first, up to ${MAX_LOG_COMMITS}) that touched a path, with their messages. Use side to pick whose history to see.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repo-relative file or folder' },
          side: { type: 'string', enum: SIDES, description: 'ours, theirs or both (default both)' },
          maxCount: { type: 'integer', description: `How many commits (default 10, max ${MAX_LOG_COMMITS})` },
        },
        required: ['path'],
      },
      run: async ({ path: input, side = 'both', maxCount }) => {
        if (!SIDES.includes(side)) throw new Error('side must be ours, theirs or both');
        const rel = normalizeRepoPath(input);
        const commits = await getCommits(cwd, {
          revs: await sideRevs(side),
          paths: [rel],
          maxCount: toInt(maxCount, 10, 1, MAX_LOG_COMMITS),
        });
        return commits.length === 0 ? `No commits touched ${rel}.` : commits.map(formatCommit).join('\n');
      },
    },
    {
      name: 'git_show',
      description: 'Show one commit: its message, the files it changed and the patch (long output is cut). Use a sha from git_log.',
      parameters: {
        type: 'object',
        properties: { commit: { type: 'string', description: 'Hex sha, 7-40 characters' } },
        required: ['commit'],
      },
      run: async ({ commit }) => {
        if (!isCommitSha(commit)) throw new Error('commit must be a hex sha of 7-40 characters (take it from git_log)');
        return showCommit(cwd, commit);
      },
    },
    {
      name: 'git_blame',
      description: `Who last changed each line in a range (at most ${MAX_BLAME_LINES} lines). Line numbers refer to the file as it is on the chosen side, as shown by get_conflict_stages.`,
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Repo-relative path' },
          startLine: { type: 'integer' },
          endLine: { type: 'integer' },
          side: { type: 'string', enum: ['ours', 'theirs'], description: 'Default ours' },
        },
        required: ['file', 'startLine', 'endLine'],
      },
      run: async ({ file, startLine, endLine, side = 'ours' }) => {
        if (side !== 'ours' && side !== 'theirs') throw new Error('side must be ours or theirs');
        const rel = normalizeRepoPath(file);
        const from = toInt(startLine, 1, 1, 1_000_000);
        const to = Math.min(toInt(endLine, from, from, 1_000_000), from + MAX_BLAME_LINES - 1);
        const [rev] = await sideRevs(side);
        return (await blameLines(cwd, rel, from, to, rev)).trimEnd() || `No blame output for ${rel}.`;
      },
    },
  ];
};

export const selectTools = (tools, names) => tools.filter((tool) => names.includes(tool.name));
