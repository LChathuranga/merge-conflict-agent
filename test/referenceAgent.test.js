import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  extractDeclarations,
  assessResolution,
  gatherUsages,
  findImporters,
  isTestFile,
} from '../src/agents/referenceAgent.js';
import { detectFocusedTestCommand, validateRepo } from '../src/agents/validationAgent.js';
import { resolveConflicts } from '../src/orchestrator/index.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

const makeDir = (files = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mca-ref-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
};

const initRepo = (dir) => {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 'Tester');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'merge.conflictstyle', 'diff3');
};

const commitAll = (dir, message) => {
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', message);
};

// price.js line 1 is changed differently on each branch; checkout.js and a test use TAX_RATE.
const makeConflictRepo = () => {
  const dir = makeDir({
    'src/price.js': 'export const TAX_RATE = 0.2;\nexport const label = "price";\n',
    'src/checkout.js': "import { TAX_RATE } from './price.js';\nexport const withTax = (x) => x * (1 + TAX_RATE);\n",
    'test/price.test.js': "import { TAX_RATE } from '../src/price.js';\nconsole.log(TAX_RATE);\n",
    'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
  });
  initRepo(dir);
  commitAll(dir, 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  writeFileSync(path.join(dir, 'src/price.js'), 'export const TAX_RATE = 0.3;\nexport const label = "price";\n');
  git(dir, 'commit', '-qam', 'feature raises tax');
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(path.join(dir, 'src/price.js'), 'export const TAX_RATE = 0.25;\nexport const label = "price";\n');
  git(dir, 'commit', '-qam', 'main raises tax');
  try { git(dir, 'merge', 'feature'); } catch { /* conflict expected */ }
  return dir;
};

const usagesTable = (table) => ({
  lookup: async (name) => table[name] ?? { references: [], total: 0, files: [] },
});
const refs = (...locations) => ({
  references: locations.map(([file, line]) => ({ file, line, text: '' })),
  total: locations.length,
  files: locations.map(([file]) => file),
});

test('extractDeclarations understands common JS/TS declarations and ignores keywords and comments', () => {
  const found = extractDeclarations([
    '// export const ignored = 1;',
    'export async function load(id, opts) {',
    'export const calculateTotal = (items,  region) => {',
    'export const TAX_RATE = 0.2;',
    'class Cart extends Base {',
    '  static create(a, b): Cart {',
    '  timeout: 60,',
    '  if (x) {',
    'export interface Item { id: string }',
    "export type Id = string | number;",
    'enum Mode {',
  ].join('\n'));

  assert.deepEqual(found.get('load'), { kind: 'function', signature: '(id, opts)' });
  assert.deepEqual(found.get('calculateTotal'), { kind: 'variable', signature: '(items, region) =>' });
  assert.deepEqual(found.get('TAX_RATE'), { kind: 'variable', signature: '0.2' });
  assert.equal(found.get('Cart').kind, 'class');
  assert.equal(found.get('create').kind, 'method');
  assert.deepEqual(found.get('timeout'), { kind: 'property', signature: '60' });
  assert.equal(found.get('Item').kind, 'interface');
  assert.equal(found.get('Id').kind, 'type');
  assert.equal(found.get('Mode').kind, 'enum');
  assert.equal(found.has('ignored'), false);
  assert.equal(found.has('if'), false);
});

test('a merge that keeps each side\'s own change reports nothing, even for widely used names', async () => {
  const hunk = { ours: '  timeout: 60,', base: '  timeout: 30,', theirs: '  timeout: 30,\n  retries: 3,' };
  const usages = usagesTable({ timeout: refs(['a.js', 1], ['b.js', 2]), retries: refs(['c.js', 3]) });
  const result = await assessResolution({ hunk, resolution: '  timeout: 60,\n  retries: 3,', usages });
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.flags, []);
});

test('reverting a side\'s edit is reported, and flagged only when the name is used elsewhere', async () => {
  const hunk = { ours: '  timeout: 60,', base: '  timeout: 30,', theirs: '  timeout: 30,' };
  const used = await assessResolution({ hunk, resolution: '  timeout: 30,', usages: usagesTable({ timeout: refs(['a.js', 1], ['b.js', 2], ['c.js', 3]) }) });
  assert.equal(used.changes[0].change, 'value changed');
  assert.deepEqual(used.changes[0].discardedFrom, ['ours']);
  assert.equal(used.flags.length, 1);
  assert.match(used.flags[0], /"timeout" value changed: the ours side's version is discarded/);
  assert.match(used.flags[0], /used in 3 other places \(a\.js:1, b\.js:2, \.\.\.\)/);

  const unused = await assessResolution({ hunk, resolution: '  timeout: 30,', usages: usagesTable({}) });
  assert.equal(unused.changes.length, 1);
  assert.deepEqual(unused.flags, []);
});

test('dropping a declaration is "removed", including one nobody disputed', async () => {
  const hunk = {
    ours: 'export const tax = 1;\nexport const shared = 5;',
    base: 'export const tax = 0;\nexport const shared = 5;',
    theirs: 'export const tax = 2;\nexport const shared = 5;',
  };
  const usages = usagesTable({ shared: refs(['x.js', 9]), tax: refs(['y.js', 4]) });
  const result = await assessResolution({ hunk, resolution: 'export const tax = 1;', usages });

  const shared = result.changes.find((c) => c.name === 'shared');
  assert.equal(shared.change, 'removed');
  assert.match(result.flags.find((f) => f.includes('"shared"')), /"shared" is removed but is still used in 1 other place \(x\.js:9\)/);
});

test('a changed function signature is reported as such, and without a base the sides are compared with each other', async () => {
  const withBase = {
    ours: 'export const run = (a, b) => {',
    base: 'export const run = (a) => {',
    theirs: 'export const run = (a) => {',
  };
  const result = await assessResolution({ hunk: withBase, resolution: 'export const run = (a) => {', usages: usagesTable({ run: refs(['m.js', 3]) }) });
  assert.equal(result.changes[0].change, 'signature changed');
  assert.deepEqual(result.changes[0].discardedFrom, ['ours']);

  const noBase = { ours: 'export const LIMIT = 1;', base: null, theirs: 'export const LIMIT = 2;' };
  const keptOurs = await assessResolution({ hunk: noBase, resolution: 'export const LIMIT = 1;', usages: usagesTable({}) });
  assert.deepEqual(keptOurs.changes[0].discardedFrom, ['theirs']);
});

test('test files that use a dropped or changed name are collected', async () => {
  const hunk = { ours: '  timeout: 60,', base: '  timeout: 30,', theirs: '  timeout: 30,' };
  const usages = usagesTable({ timeout: refs(['src/a.js', 1], ['test/a.test.js', 2], ['src/__tests__/b.js', 3]) });
  const result = await assessResolution({ hunk, resolution: '  timeout: 30,', usages });
  assert.deepEqual(result.testFiles.sort(), ['src/__tests__/b.js', 'test/a.test.js']);
  assert.equal(isTestFile('src/a.spec.ts'), true);
  assert.equal(isTestFile('src/contest.js'), false);
});

test('gatherUsages greps the real repo, skips the hunk itself and tiny or generic names', async () => {
  const dir = makeConflictRepo();
  try {
    const hunk = { startLine: 1, endLine: 7, ours: 'export const TAX_RATE = 0.25;', base: 'export const TAX_RATE = 0.2;', theirs: 'export const TAX_RATE = 0.3;' };
    const usages = await gatherUsages({ cwd: dir, file: 'src/price.js', hunk });

    assert.deepEqual(usages.symbols.map((s) => s.name), ['TAX_RATE']);
    const files = usages.symbols[0].references.map((r) => r.file).sort();
    assert.deepEqual(files, ['src/checkout.js', 'src/checkout.js', 'test/price.test.js', 'test/price.test.js']);
    assert.match(usages.text, /^- TAX_RATE \(4 other uses\): /);

    const generic = await gatherUsages({
      cwd: dir,
      file: 'src/price.js',
      hunk: { startLine: 1, endLine: 5, ours: '  name: 1,\n  id: 2,\n  ab: 3,', base: null, theirs: '  name: 9,\n  id: 8,\n  ab: 7,' },
    });
    assert.deepEqual(generic.symbols, []);
  } finally {
    cleanup(dir);
  }
});

test('findImporters follows relative paths and ignores a same-named module elsewhere', async () => {
  const dir = makeDir({
    'src/price.js': 'export const a = 1;\n',
    'src/checkout.js': "import { a } from './price.js';\n",
    'src/noext.js': "const p = require('./price');\n",
    'test/price.test.js': "import { a } from '../src/price';\n",
    'other/price.js': 'export const a = 2;\n',
    'other/use.js': "import { a } from './price.js';\n",
    'src/lib/index.js': 'export const lib = 1;\n',
    'src/app.js': "import { lib } from './lib';\n",
    'README.md': "see './price.js' in docs\n",
  });
  try {
    initRepo(dir);
    commitAll(dir, 'files');
    assert.deepEqual((await findImporters({ cwd: dir, file: 'src/price.js' })).sort(), ['src/checkout.js', 'src/noext.js', 'test/price.test.js']);
    assert.deepEqual(await findImporters({ cwd: dir, file: 'other/price.js' }), ['other/use.js']);
    assert.deepEqual(await findImporters({ cwd: dir, file: 'src/lib/index.js' }), ['src/app.js']);
    assert.deepEqual(await findImporters({ cwd: dir, file: 'README.md' }), []);
  } finally {
    cleanup(dir);
  }
});

const confidentReply = (resolution) => JSON.stringify({ resolution, confidence: 'high', ambiguous: false, explanation: 'x' });

test('orchestrator: dropping a name that is used elsewhere forces approval and shows the flag', async () => {
  const dir = makeConflictRepo();
  try {
    const prompts = [];
    let shown;
    const { files } = await resolveConflicts({
      cwd: dir,
      useIntent: false,
      dryRun: true,
      llm: { complete: async (req) => { prompts.push(req.messages[0].content); return confidentReply('// tax handled elsewhere'); } },
      approve: async ({ proposal }) => { shown = proposal; return { action: 'reject' }; },
    });

    assert.equal(files[0].status, 'rejected');
    assert.ok(shown.flags.some((f) => /"TAX_RATE" is removed but is still used in 4 other places/.test(f)));
    assert.equal(shown.usedElsewhere[0].name, 'TAX_RATE');
    assert.match(prompts[0], /Where the contested names are used elsewhere in the repository:\n- TAX_RATE \(4 other uses\)/);
  } finally {
    cleanup(dir);
  }
});

test('orchestrator: affected tests are handed to the validator and recorded as impact', async () => {
  const dir = makeConflictRepo();
  try {
    let validatorArgs;
    const { files, stageBlockedReason } = await resolveConflicts({
      cwd: dir,
      useIntent: false,
      stage: true,
      llm: { complete: async () => confidentReply('export const TAX_RATE = 0.28;') },
      approve: async () => ({ action: 'accept' }),
      validator: async (args) => {
        validatorArgs = args;
        return { ran: true, passed: true, steps: [] };
      },
    });

    assert.equal(stageBlockedReason, null);
    assert.deepEqual(validatorArgs.focusedTests, ['test/price.test.js']);
    assert.deepEqual(files[0].impact.importers.sort(), ['src/checkout.js', 'test/price.test.js']);
    assert.equal(files[0].impact.changes[0].name, 'TAX_RATE');
    assert.equal(files[0].staged, true);
  } finally {
    cleanup(dir);
  }
});

test('orchestrator: a broken reference agent is reported once and never blocks resolving', async () => {
  const dir = makeConflictRepo();
  try {
    const events = [];
    const boom = async () => { throw new Error('grep exploded'); };
    const { files } = await resolveConflicts({
      cwd: dir,
      useIntent: false,
      dryRun: true,
      referenceAgent: { gatherUsages: boom, assessResolution: boom, findImporters: boom },
      llm: { complete: async () => confidentReply('export const TAX_RATE = 0.28;') },
      approve: async () => ({ action: 'accept' }),
      onEvent: (e) => events.push(e),
    });

    assert.equal(files[0].status, 'would-resolve');
    assert.equal(events.filter((e) => e.type === 'references-unavailable').length, 1);
  } finally {
    cleanup(dir);
  }
});

test('detectFocusedTestCommand recognizes the repo test runner and refuses unsafe paths', async () => {
  const forScript = (test, extra = {}) => makeDir({ 'package.json': JSON.stringify({ scripts: { test }, ...extra }) });
  const dirs = [forScript('node --test test/'), forScript('jest --ci'), forScript('vitest run'), forScript('mocha'), forScript('echo hi')];
  try {
    const files = ['test/a.test.js', 'test/b c.test.js', 'test/bad";rm -rf.js'];
    assert.equal(await detectFocusedTestCommand(dirs[0], files), 'node --test "test/a.test.js" "test/b c.test.js"');
    assert.match(await detectFocusedTestCommand(dirs[1], files), /^npx --no-install jest --runTestsByPath "test\/a\.test\.js"/);
    assert.match(await detectFocusedTestCommand(dirs[2], files), /^npx --no-install vitest run /);
    assert.match(await detectFocusedTestCommand(dirs[3], files), /^npx --no-install mocha /);
    assert.equal(await detectFocusedTestCommand(dirs[4], files), null);
    assert.equal(await detectFocusedTestCommand(dirs[0], []), null);
  } finally {
    dirs.forEach(cleanup);
  }
});

test('validateRepo runs the focused tests first, but not when the repo set its own commands', async () => {
  const passing = "import { test } from 'node:test';\ntest('ok', () => {});\n";
  const dir = makeDir({
    'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }),
    'test/a.test.js': passing,
  });
  try {
    const auto = await validateRepo({ cwd: dir, focusedTests: ['test/a.test.js'] });
    assert.deepEqual(auto.steps.map((s) => s.name), ['focused tests', 'test']);
    assert.equal(auto.passed, true);

    writeFileSync(path.join(dir, '.merge-agent.json'), JSON.stringify({ validate: ['node -e "process.exit(0)"'] }));
    const configured = await validateRepo({ cwd: dir, focusedTests: ['test/a.test.js'] });
    assert.deepEqual(configured.steps.map((s) => s.name), ['check 1']);
  } finally {
    cleanup(dir);
  }
});

test('several key: value pairs collapsed onto one line are read as separate properties', async () => {
  const found = extractDeclarations('timeout: 60, retries: 3, handler: fn(a, b), label: "x, y"');
  assert.deepEqual([...found.keys()], ['timeout', 'retries', 'handler', 'label']);
  assert.equal(found.get('timeout').signature, '60');
  assert.equal(found.get('handler').signature, 'fn(a, b)');
  assert.equal(found.get('label').signature, '"x, y"');

  // The same merge written on one line must not be reported as dropping anything.
  const hunk = { ours: '  timeout: 60,', base: '  timeout: 30,', theirs: '  timeout: 30,\n  retries: 3,' };
  const usages = usagesTable({ timeout: refs(['a.js', 1]), retries: refs(['b.js', 2]) });
  const result = await assessResolution({ hunk, resolution: 'timeout: 60, retries: 3', usages });
  assert.deepEqual(result.changes, []);
});

test('flag wording says when neither side\'s version survives', async () => {
  const hunk = { ours: 'export const LIMIT = 1;', base: 'export const LIMIT = 0;', theirs: 'export const LIMIT = 2;' };
  const result = await assessResolution({ hunk, resolution: 'export const LIMIT = 3;', usages: usagesTable({ LIMIT: refs(['a.js', 1]) }) });
  assert.match(result.flags[0], /"LIMIT" value changed: neither side's version is kept, but "LIMIT" is still used in 1 other place \(a\.js:1\)/);
});
