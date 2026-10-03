import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyCherryPick, runPreflight } from '../src/preflight/index.js';
import { extractUsedNames, importCandidates, parseUnifiedDiff } from '../src/preflight/diff.js';
import { resolveCommit } from '../src/git/history.js';

const sh = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });
const preflightDirs = () => readdirSync(tmpdir()).filter((name) => name.startsWith('mca-preflight-'));

const write = (dir, name, text) => {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(path.join(dir, name), text);
};

// Writes files (null deletes) and commits them; returns the new commit sha.
const commit = (dir, files, message) => {
  for (const [name, text] of Object.entries(files)) {
    if (text === null) rmSync(path.join(dir, name), { force: true });
    else write(dir, name, text);
  }
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', message);
  return sh(dir, 'rev-parse', 'HEAD');
};

const newRepo = (baseFiles) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mca-pf-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@t.t');
  sh(dir, 'config', 'user.name', 'Tester');
  sh(dir, 'config', 'core.autocrlf', 'false');
  commit(dir, baseFiles, 'base');
  return dir;
};

const confirmedShas = (result) => result.evidence.prerequisites.filter((p) => p.kind === 'confirmed').map((p) => p.sha);

test('an independent commit is safe, and the report says it is local analysis only', async () => {
  const dir = newRepo({ 'app.js': 'export const app = 1;\n' });
  try {
    sh(dir, 'checkout', '-q', '-b', 'feature');
    const F1 = commit(dir, { 'other.js': 'export const other = 2;\n' }, 'add other');
    sh(dir, 'checkout', '-q', 'main');
    commit(dir, { 'app.js': 'export const app = 1;\nexport const more = 3;\n' }, 'main moves on');

    const result = await runPreflight({ cwd: dir, commit: F1 });
    assert.equal(result.outcome, 'safe');
    assert.equal(result.localOnly, true);
    assert.equal(result.simulation.status, 'clean');
    assert.deepEqual(result.evidence.prerequisites, []);
    assert.match(result.lines.find((l) => l.text.startsWith('Outcome:')).text, /SAFE \(local analysis only\)/);
    assert.match(result.evidence.remote.reason, /Open pull requests were not checked/);
  } finally {
    cleanup(dir);
  }
});

test('editing lines written by an unmerged commit makes that commit a confirmed prerequisite', async () => {
  const dir = newRepo({ 'cfg.js': 'one\ntwo\nthree\n' });
  try {
    sh(dir, 'checkout', '-q', '-b', 'feature');
    const A = commit(dir, { 'cfg.js': 'one\ntwo\nthree\nx = 1\n' }, 'A: add x');
    const B = commit(dir, { 'cfg.js': 'one\ntwo\nthree\nx = 2\n' }, 'B: bump x');
    sh(dir, 'checkout', '-q', 'main');

    const result = await runPreflight({ cwd: dir, commit: B });
    assert.equal(result.outcome, 'conditional');
    assert.deepEqual(confirmedShas(result), [A]);
    assert.match(result.evidence.prerequisites[0].reasons[0], /cfg\.js: line 4 .* written by .*not on HEAD/);
    assert.equal(result.simulation.status, 'conflict');
    assert.deepEqual(result.simulation.conflicts, ['cfg.js']);
    assert.match(result.findings.find((f) => f.level === 'conditional').text, /Apply these first \(oldest first\): .* "A: add x"/);
  } finally {
    cleanup(dir);
  }
});

test('a pick that applies cleanly but uses a file and a function from an unmerged commit is conditional', async () => {
  const dir = newRepo({ 'main.js': 'export const title = "app";\n' });
  try {
    sh(dir, 'checkout', '-q', '-b', 'feature');
    const A = commit(dir, { 'helper.js': 'export const computeTotal = (x) => x * 2;\n' }, 'A: add helper');
    const B = commit(dir, { 'main.js': 'import { computeTotal } from "./helper.js";\nexport const title = "app";\nexport const total = computeTotal(5);\n' }, 'B: use helper');
    sh(dir, 'checkout', '-q', 'main');

    const result = await runPreflight({ cwd: dir, commit: B });
    assert.equal(result.simulation.status, 'clean', 'the text applies fine, which is exactly why this is dangerous');
    assert.equal(result.outcome, 'conditional');
    assert.deepEqual(confirmedShas(result), [A]);
    const missing = result.evidence.missing.map((m) => `${m.kind}:${m.name}`).sort();
    assert.deepEqual(missing, ['file:helper.js', 'symbol:computeTotal']);
    assert.ok(result.evidence.missing.every((m) => m.providers[0].sha === A));
  } finally {
    cleanup(dir);
  }
});

test('a needed name that no unmerged commit provides blocks the pick', async () => {
  const dir = newRepo({ 'lib.js': 'export const ghostFn = () => 1;\n', 'app.js': 'export const app = 1;\n' });
  try {
    sh(dir, 'checkout', '-q', '-b', 'feature');
    const B = commit(dir, { 'app.js': 'export const app = 1;\nexport const r = ghostFn();\n' }, 'B: call ghostFn');
    sh(dir, 'checkout', '-q', 'main');
    commit(dir, { 'lib.js': 'export const other = 1;\n' }, 'main removes ghostFn');

    const result = await runPreflight({ cwd: dir, commit: B });
    assert.equal(result.outcome, 'blocked');
    assert.deepEqual(result.evidence.missing.map((m) => [m.kind, m.name, m.providers.length]), [['symbol', 'ghostFn', 0]]);
    assert.match(result.findings.find((f) => f.level === 'blocked').text, /needs symbol "ghostFn".*no unmerged commit provides/);
  } finally {
    cleanup(dir);
  }
});

test('a commit whose change is already on the target needs no work', async () => {
  const dir = newRepo({ 'f.txt': 'a\nb\nc\n' });
  try {
    sh(dir, 'checkout', '-q', '-b', 'feature');
    const B = commit(dir, { 'f.txt': 'a\nB\nc\n' }, 'B: edit');
    sh(dir, 'checkout', '-q', 'main');
    sh(dir, 'cherry-pick', B);

    const result = await runPreflight({ cwd: dir, commit: B });
    assert.equal(result.outcome, 'safe');
    assert.equal(result.simulation, null);
    assert.match(result.findings[0].text, /Nothing to do: .*equivalent change/);
  } finally {
    cleanup(dir);
  }
});

test('a merge commit is blocked with an explanation', async () => {
  const dir = newRepo({ 'f.txt': 'a\n' });
  try {
    sh(dir, 'checkout', '-q', '-b', 'x');
    commit(dir, { 'x.txt': 'x\n' }, 'X');
    sh(dir, 'checkout', '-q', '-b', 'y', 'main');
    commit(dir, { 'y.txt': 'y\n' }, 'Y');
    sh(dir, 'checkout', '-q', 'x');
    sh(dir, 'merge', '--no-ff', '-q', '-m', 'merge y', 'y');
    const merge = sh(dir, 'rev-parse', 'HEAD');
    sh(dir, 'checkout', '-q', 'main');

    const result = await runPreflight({ cwd: dir, commit: merge });
    assert.equal(result.outcome, 'blocked');
    assert.match(result.findings[0].text, /merge commit/);
  } finally {
    cleanup(dir);
  }
});

test('unmerged work on another branch touching the same file makes the pick risky', async () => {
  const dir = newRepo({ 'cfg.js': 'l1\nl2\nl3\nl4\nl5\nl6\nl7\n' });
  try {
    sh(dir, 'checkout', '-q', '-b', 'feature');
    const B = commit(dir, { 'cfg.js': 'L1\nl2\nl3\nl4\nl5\nl6\nl7\n' }, 'B: edit top');
    sh(dir, 'checkout', '-q', '-b', 'other', 'main');
    commit(dir, { 'cfg.js': 'l1\nl2\nl3\nl4\nl5\nl6\nL7\n' }, 'other: edit bottom');
    sh(dir, 'checkout', '-q', 'main');

    const result = await runPreflight({ cwd: dir, commit: B });
    assert.equal(result.simulation.status, 'clean');
    assert.equal(result.outcome, 'risky');
    assert.deepEqual(result.evidence.overlaps.map((o) => o.branch), ['other']);
    assert.match(result.findings.find((f) => f.level === 'risky').text, /Branch other has 1 unmerged commit.*other: edit bottom/);
  } finally {
    cleanup(dir);
  }
});

test('removing a function that the target still uses is reported from the simulated result', async () => {
  const dir = newRepo({ 'lib.js': 'export function legacy() { return 1; }\nexport function keep() { return 2; }\n' });
  try {
    sh(dir, 'checkout', '-q', '-b', 'feature');
    const B = commit(dir, { 'lib.js': 'export function keep() { return 2; }\n' }, 'B: drop legacy');
    sh(dir, 'checkout', '-q', 'main');
    commit(dir, { 'use.js': 'import { legacy } from "./lib.js";\nexport const v = legacy();\n' }, 'main starts using legacy');

    const result = await runPreflight({ cwd: dir, commit: B });
    assert.equal(result.simulation.status, 'clean');
    assert.equal(result.outcome, 'risky');
    const [broken] = result.simulation.brokenReferences;
    assert.deepEqual({ name: broken.name, change: broken.change, file: broken.file }, { name: 'legacy', change: 'removed', file: 'lib.js' });
    assert.ok(broken.references.every((r) => r.file === 'use.js'));
  } finally {
    cleanup(dir);
  }
});

test('--validate runs the repo checks on the simulated result and a failure blocks', async () => {
  const failing = JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } });
  const passing = JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } });
  for (const [script, expected, validationPassed] of [[failing, 'blocked', false], [passing, 'safe', true]]) {
    const dir = newRepo({ 'package.json': script, 'f.txt': 'a\n' });
    try {
      sh(dir, 'checkout', '-q', '-b', 'feature');
      const B = commit(dir, { 'f.txt': 'a\nb\n' }, 'B: edit');
      sh(dir, 'checkout', '-q', 'main');

      const result = await runPreflight({ cwd: dir, commit: B, validate: true });
      assert.equal(result.outcome, expected);
      assert.equal(result.validation.ran, true);
      assert.equal(result.validation.passed, validationPassed);
    } finally {
      cleanup(dir);
    }
  }
});

test('validation sees the repo dependencies through a link, and the link never harms the real folder', async () => {
  const check = JSON.stringify({ scripts: { test: 'node -e "require(\'fs\').accessSync(\'node_modules/pkg/index.js\')"' } });
  // Like a real project, node_modules is ignored; otherwise `git add -A` would commit it.
  const dir = newRepo({ 'package.json': check, 'f.txt': 'a\n', '.gitignore': 'node_modules/\n' });
  try {
    write(dir, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
    sh(dir, 'checkout', '-q', '-b', 'feature');
    const B = commit(dir, { 'f.txt': 'a\nb\n' }, 'B: edit');
    sh(dir, 'checkout', '-q', 'main');

    const result = await runPreflight({ cwd: dir, commit: B, validate: true });
    assert.equal(result.simulation.dependenciesLinked, true);
    assert.equal(result.validation.passed, true, 'the check needs node_modules to exist in the worktree');
    assert.equal(readFileSync(path.join(dir, 'node_modules/pkg/index.js'), 'utf8'), 'module.exports = 1;\n', 'the real node_modules survives');
    assert.equal(result.simulation.cleanedUp, true);
  } finally {
    cleanup(dir);
  }
});

test('the trial pick leaves the repository exactly as it was and removes its worktree', async () => {
  const dir = newRepo({ 'cfg.js': 'one\ntwo\nthree\n' });
  try {
    sh(dir, 'checkout', '-q', '-b', 'feature');
    commit(dir, { 'cfg.js': 'one\ntwo\nthree\nx = 1\n' }, 'A');
    const B = commit(dir, { 'cfg.js': 'one\ntwo\nthree\nx = 2\n' }, 'B');
    sh(dir, 'checkout', '-q', 'main');
    write(dir, 'untracked.txt', 'keep me\n');
    const before = { head: sh(dir, 'rev-parse', 'HEAD'), status: sh(dir, 'status', '--porcelain'), branches: sh(dir, 'branch', '--list'), dirs: preflightDirs() };

    const result = await runPreflight({ cwd: dir, commit: B });
    assert.equal(result.simulation.status, 'conflict');

    assert.equal(sh(dir, 'rev-parse', 'HEAD'), before.head);
    assert.equal(sh(dir, 'status', '--porcelain'), before.status);
    assert.equal(sh(dir, 'branch', '--list'), before.branches);
    assert.equal(readFileSync(path.join(dir, 'untracked.txt'), 'utf8'), 'keep me\n');
    assert.equal(sh(dir, 'worktree', 'list').split(/\r?\n/).length, 1, 'only the main worktree remains');
    assert.deepEqual(preflightDirs(), before.dirs, 'no temporary folder is left behind');
    assert.equal(result.simulation.cleanedUp, true);
  } finally {
    cleanup(dir);
  }
});

test('applyCherryPick applies after approval, and refuses a dirty tree or the wrong checked-out branch', async () => {
  const dir = newRepo({ 'cfg.js': 'one\ntwo\nthree\n', 'app.js': 'a\n' });
  try {
    sh(dir, 'checkout', '-q', '-b', 'feature');
    commit(dir, { 'cfg.js': 'one\ntwo\nthree\nx = 1\n' }, 'A');
    const B = commit(dir, { 'cfg.js': 'one\ntwo\nthree\nx = 2\n' }, 'B: bump x');
    const C = commit(dir, { 'app.js': 'a\nb\n' }, 'C: app');
    sh(dir, 'checkout', '-q', 'main');

    writeFileSync(path.join(dir, 'app.js'), 'dirty\n');
    await assert.rejects(applyCherryPick({ cwd: dir, commit: C }), /uncommitted changes/);
    sh(dir, 'checkout', '--', 'app.js');
    await assert.rejects(applyCherryPick({ cwd: dir, commit: C, target: 'feature' }), /Check out feature first/);

    assert.equal((await applyCherryPick({ cwd: dir, commit: C })).status, 'applied');
    assert.equal(sh(dir, 'log', '-1', '--format=%s'), 'C: app');

    const conflicted = await applyCherryPick({ cwd: dir, commit: B });
    assert.deepEqual({ status: conflicted.status, conflicts: conflicted.conflicts }, { status: 'conflict', conflicts: ['cfg.js'] });
    sh(dir, 'cherry-pick', '--abort');
  } finally {
    cleanup(dir);
  }
});

test('commit and ref arguments cannot be smuggled in as git options', async () => {
  const dir = newRepo({ 'f.txt': 'a\n' });
  try {
    for (const bad of ['--output=evil.txt', '-n', 'a..b', '', 'x y', 'nope-not-a-commit']) {
      await assert.rejects(resolveCommit(dir, bad), /commit must be|is not a commit/, JSON.stringify(bad));
    }
    assert.match(await resolveCommit(dir, 'HEAD'), /^[0-9a-f]{40}$/);
    await assert.rejects(runPreflight({ cwd: dir, commit: 'HEAD', target: '--upload-pack=x' }), /commit must be/);
  } finally {
    cleanup(dir);
  }
});

test('parseUnifiedDiff reads hunks, ranges and added/removed lines, including "--" content', () => {
  const diff = [
    'diff --git a/old.js b/new.js',
    'similarity index 80%',
    'rename from old.js',
    'rename to new.js',
    '--- a/old.js',
    '+++ b/new.js',
    '@@ -3,2 +3,3 @@ context',
    '-const a = 1;',
    '--- not a header, a removed line',
    '+const a = 2;',
    '+const b = 3;',
    '+++ not a header either',
    '@@ -10,0 +12 @@',
    '+inserted',
    'diff --git a/gone.js b/gone.js',
    '--- a/gone.js',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
  ].join('\n');
  const [renamed, deleted] = parseUnifiedDiff(diff);
  assert.deepEqual([renamed.oldPath, renamed.newPath], ['old.js', 'new.js']);
  assert.deepEqual(renamed.hunks[0].removed.map((r) => [r.line, r.text]), [[3, 'const a = 1;'], [4, '-- not a header, a removed line']]);
  assert.deepEqual(renamed.hunks[0].added.map((a) => [a.line, a.text]), [[3, 'const a = 2;'], [4, 'const b = 3;'], [5, '++ not a header either']]);
  assert.deepEqual([renamed.hunks[1].oldStart, renamed.hunks[1].oldCount, renamed.hunks[1].newStart, renamed.hunks[1].newCount], [10, 0, 12, 1]);
  assert.deepEqual([deleted.newPath, deleted.hunks[0].oldCount], [null, 1]);
});

test('extractUsedNames finds calls, imports and packages, and skips what the code declares or the language provides', () => {
  const used = extractUsedNames([
    'import { helper, other as o } from "./util.js";',
    'import lodash from "lodash";',
    'import { readFile } from "node:fs/promises";',
    'import path from "path";',
    'import scoped from "@acme/tools/deep";',
    'function localFn() { return localFn2(); }',
    'const x = helper(1) + fetchThing(2) + obj.method(3); // ignored(4)',
    'console.log("skipMe(5)", JSON.stringify(x), new Map());',
  ].join('\n'));
  assert.deepEqual(used.symbols.sort(), ['fetchThing', 'helper', 'localFn2', 'other'].sort());
  assert.deepEqual(used.relativeImports, ['./util.js']);
  assert.deepEqual(used.packages.sort(), ['@acme/tools', 'lodash']);
  assert.deepEqual(importCandidates('src/a/b.js', '../util').slice(0, 3), ['src/util', 'src/util.js', 'src/util.mjs']);
  assert.ok(importCandidates('b.js', './dir').includes('dir/index.js'));
});
