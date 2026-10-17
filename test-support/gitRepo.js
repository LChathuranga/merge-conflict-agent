import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
export const mergeHeadExists = (dir) => existsSync(path.join(dir, '.git', 'MERGE_HEAD'));

// Windows can hold a directory for a moment after a git process exits, so retry the removal.
export const cleanup = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

// Building a repository takes dozens of git commands, which is slow on some machines. Each
// shape is built once per test process and copied for every test that needs a fresh one.
const templates = new Map();
process.on('exit', () => templates.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

export const repoFromTemplate = (key, build) => {
  if (!templates.has(key)) {
    const template = mkdtempSync(path.join(tmpdir(), `mca-tpl-${key}-`));
    build(template);
    templates.set(key, template);
  }
  const dir = mkdtempSync(path.join(tmpdir(), `mca-${key}-`));
  cpSync(templates.get(key), dir, { recursive: true });
  return dir;
};

// A repository on `main` with two other branches:
//   feature      changes c.txt and d.txt (both conflict with main) and adds e.txt
//   clean-branch only adds f.txt (merges without conflicts)
const buildMergeRepo = (dir) => {
  const put = (file, text) => writeFileSync(path.join(dir, file), text);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'merge.conflictstyle', 'diff3');
  put('c.txt', 'c=0\n');
  put('d.txt', 'd=0\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');

  git(dir, 'checkout', '-q', '-b', 'clean-branch');
  put('f.txt', 'f\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'add f');

  git(dir, 'checkout', '-q', 'main');
  git(dir, 'checkout', '-q', '-b', 'feature');
  put('c.txt', 'c=3\n');
  put('d.txt', 'd=3\n');
  put('e.txt', 'e\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'feature work');

  git(dir, 'checkout', '-q', 'main');
  put('c.txt', 'c=2\n');
  put('d.txt', 'd=2\n');
  git(dir, 'commit', '-qam', 'main work');
};

export const makeMergeRepo = () => repoFromTemplate('ui', buildMergeRepo);

// main has a base commit; `feature` has three commits on top of it:
//   footer   independent
//   helper   adds helper.js
//   total    edits main.js to use helper.js (applies cleanly, but needs `helper`)
const buildPickRepo = (dir) => {
  const put = (file, text) => writeFileSync(path.join(dir, file), text);
  const commit = (message) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', message); };
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
  put('main.js', 'export const title = "app";\n');
  commit('Initial commit');
  git(dir, 'checkout', '-q', '-b', 'feature');
  put('footer.js', 'export const footer = "(c) Demo";\n');
  commit('Add a footer');
  put('helper.js', 'export const computeTotal = (items) => items.length * 2;\n');
  commit('Add computeTotal helper');
  put('main.js', 'import { computeTotal } from "./helper.js";\nexport const title = "app";\nexport const total = computeTotal([1, 2]);\n');
  commit('Show the cart total on the main page');
  git(dir, 'checkout', '-q', 'main');
};
export const makePickRepo = () => repoFromTemplate('pick', buildPickRepo);

// One file (f.txt) with three separate conflicts a, b and c ("x=2" on main, "x=3" on feature,
// "x=0" in the base), far enough apart that Git keeps them as three conflicts, with the merge
// already started. The history is built once and copied.
const MULTI_LINES = ['a=0', 'k1', 'k2', 'k3', 'k4', 'k5', 'b=0', 'k6', 'k7', 'k8', 'k9', 'k10', 'c=0'];
const multiValues = (a, b, c) =>
  MULTI_LINES.map((l) => ({ 'a=0': `a=${a}`, 'b=0': `b=${b}`, 'c=0': `c=${c}` })[l] ?? l).join('\n') + '\n';

const buildMultiHistory = (dir) => {
  const put = (text) => writeFileSync(path.join(dir, 'f.txt'), text);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'merge.conflictstyle', 'diff3');
  put(multiValues(0, 0, 0));
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  put(multiValues(3, 3, 3));
  git(dir, 'commit', '-qam', 'feature');
  git(dir, 'checkout', '-q', 'main');
  put(multiValues(2, 2, 2));
  git(dir, 'commit', '-qam', 'main');
};

export const makeMultiConflictRepo = () => {
  const dir = repoFromTemplate('multi', buildMultiHistory);
  try { git(dir, 'merge', 'feature'); } catch { /* conflicts expected */ }
  return dir;
};
