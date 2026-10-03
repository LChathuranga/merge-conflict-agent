import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createReadOnlyTools, normalizeRepoPath, resolveInsideRepo, selectTools } from '../src/tools/readOnlyTools.js';
import { isSensitivePath } from '../src/git/sensitive.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

// base -> feature (edits price.js and .env) and main (edits price.js): a real merge conflict.
const makeRepo = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mca-tools-'));
  const write = (name, text) => {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  };
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 'Tester');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'merge.conflictstyle', 'diff3');

  write('src/price.js', 'export const LIMIT = 10;\nexport const total = (x) => x;\n');
  write('checkout.js', "import { total } from './src/price.js';\nexport const run = () => total(1);\n");
  write('.env', 'LIMIT=1\n');
  write('big.txt', Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n'));
  writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([1, 2, 0, 3, 4]));
  git(dir, 'add', '-f', '.');
  git(dir, 'commit', '-q', '-m', 'base');

  git(dir, 'checkout', '-q', '-b', 'feature');
  write('src/price.js', 'export const LIMIT = 30;\nexport const total = (x) => x;\n');
  write('.env', 'LIMIT=3\nSECRET_TOKEN=hunter2\n');
  git(dir, 'commit', '-qam', 'Raise the limit to 30', '-m', 'Customers hit the old cap.');

  git(dir, 'checkout', '-q', 'main');
  write('src/price.js', 'export const LIMIT = 20;\nexport const total = (x) => x;\n');
  git(dir, 'commit', '-qam', 'Raise the limit to 20');
  try { git(dir, 'merge', 'feature'); } catch { /* conflict expected */ }
  return dir;
};

const call = (tools, name, args) => selectTools(tools, [name])[0].run(args);

test('isSensitivePath blocks secrets and git internals but not ordinary files', () => {
  for (const p of ['.env', 'a/.env.local', '.git/config', 'k/server.pem', 'id_rsa', '.npmrc', 'x/credentials.json']) {
    assert.equal(isSensitivePath(p), true, p);
  }
  for (const p of ['src/price.js', 'docs/environment.md', 'keyboard.js', 'src/gitlab.js']) {
    assert.equal(isSensitivePath(p), false, p);
  }
});

test('normalizeRepoPath and resolveInsideRepo keep every path inside the repo', async () => {
  const dir = makeRepo();
  try {
    for (const bad of ['../outside.txt', 'src/../../x', '/etc/passwd', 'C:\\Windows\\win.ini', '.git/config', '.env', '']) {
      assert.throws(() => normalizeRepoPath(bad), undefined, bad);
    }
    assert.equal(normalizeRepoPath('src\\price.js'), 'src/price.js');
    assert.equal((await resolveInsideRepo(dir, './src/../src/price.js')).rel, 'src/price.js');
    await assert.rejects(resolveInsideRepo(dir, 'missing.js'), /file not found/);
  } finally {
    cleanup(dir);
  }
});

test('a link pointing outside the repo cannot be followed', async (t) => {
  const dir = makeRepo();
  const outside = mkdtempSync(path.join(tmpdir(), 'mca-outside-'));
  try {
    writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
    try {
      // A junction on Windows (no admin rights needed), a plain directory symlink elsewhere.
      symlinkSync(outside, path.join(dir, 'linkdir'), 'junction');
    } catch {
      t.skip('could not create a link on this machine');
      return;
    }
    await assert.rejects(resolveInsideRepo(dir, 'linkdir/secret.txt'), /outside the repository/);
    await assert.rejects(call(createReadOnlyTools({ cwd: dir }), 'read_file', { path: 'linkdir/secret.txt' }), /outside the repository/);
  } finally {
    cleanup(dir);
    cleanup(outside);
  }
});

test('read_file numbers lines, honors ranges, caps length and refuses secrets and binaries', async () => {
  const dir = makeRepo();
  try {
    const tools = createReadOnlyTools({ cwd: dir });
    assert.equal(await call(tools, 'read_file', { path: 'checkout.js', startLine: 2, endLine: 2 }), "checkout.js lines 2-2:\n2: export const run = () => total(1);");

    const capped = await call(tools, 'read_file', { path: 'big.txt', startLine: 10, endLine: 999 });
    assert.match(capped, /^big\.txt lines 10-209:\n10: line 10\n/);
    assert.match(capped, /\.\.\. \(91 more lines; 300 total\)$/);

    // Weak models send numbers as strings; the range still applies.
    assert.equal(
      await call(tools, 'read_file', { path: 'big.txt', startLine: '5', endLine: '6' }),
      'big.txt lines 5-6:\n5: line 5\n6: line 6\n... (294 more lines; 300 total)'
    );
    assert.equal(await call(tools, 'read_file', { path: 'big.txt', startLine: 300 }), 'big.txt lines 300-300:\n300: line 300');
    await assert.rejects(call(tools, 'read_file', { path: '.env' }), /blocked/);
    await assert.rejects(call(tools, 'read_file', { path: 'blob.bin' }), /binary/);
    await assert.rejects(call(tools, 'read_file', { path: 'src' }), /not a file/);
    await assert.rejects(call(tools, 'read_file', {}), /path must be/);
  } finally {
    cleanup(dir);
  }
});

test('find_references and list_importers answer from the repo and never leak secret files', async () => {
  const dir = makeRepo();
  try {
    const tools = createReadOnlyTools({ cwd: dir });
    const found = await call(tools, 'find_references', { symbol: 'LIMIT' });
    assert.match(found, /src\/price\.js:\d+: .*LIMIT/);
    assert.doesNotMatch(found, /\.env|hunter2/);

    assert.match(await call(tools, 'find_references', { symbol: 'nothing_here_xyz' }), /No uses/);
    await assert.rejects(call(tools, 'find_references', { symbol: '' }), /symbol/);
    await assert.rejects(call(tools, 'find_references', { symbol: 'a\nb' }), /symbol/);

    assert.equal(await call(tools, 'list_importers', { file: 'src/price.js' }), 'Imported by:\ncheckout.js');
    assert.match(await call(tools, 'list_importers', { file: 'checkout.js' }), /No files import/);
  } finally {
    cleanup(dir);
  }
});

test('get_conflict_stages returns numbered base, ours and theirs versions', async () => {
  const dir = makeRepo();
  try {
    const tools = createReadOnlyTools({ cwd: dir });
    assert.match(await call(tools, 'get_conflict_stages', { file: 'src/price.js', version: 'base' }), /\(base\):\n1: export const LIMIT = 10;/);
    assert.match(await call(tools, 'get_conflict_stages', { file: 'src/price.js', version: 'ours' }), /1: export const LIMIT = 20;/);
    assert.match(await call(tools, 'get_conflict_stages', { file: 'src/price.js', version: 'theirs' }), /1: export const LIMIT = 30;/);
    await assert.rejects(call(tools, 'get_conflict_stages', { file: 'src/price.js', version: 'middle' }), /base, ours or theirs/);
    await assert.rejects(call(tools, 'get_conflict_stages', { file: '.env', version: 'ours' }), /blocked/);
    assert.match(await call(tools, 'get_conflict_stages', { file: 'checkout.js', version: 'ours' }), /no "ours" version/);
  } finally {
    cleanup(dir);
  }
});

test('git_log shows the chosen side(s); git_show validates the sha and omits secret files', async () => {
  const dir = makeRepo();
  try {
    const tools = createReadOnlyTools({ cwd: dir });
    const both = await call(tools, 'git_log', { path: 'src/price.js' });
    assert.match(both, /Raise the limit to 20/);
    assert.match(both, /Raise the limit to 30[\s\S]*Customers hit the old cap/);

    const theirs = await call(tools, 'git_log', { path: 'src/price.js', side: 'theirs' });
    assert.match(theirs, /to 30/);
    assert.doesNotMatch(theirs, /to 20/);
    await assert.rejects(call(tools, 'git_log', { path: 'src/price.js', side: 'sideways' }), /side must be/);

    const sha = theirs.split(' ')[0];
    const shown = await call(tools, 'git_show', { commit: sha });
    assert.match(shown, /Raise the limit to 30/);
    assert.match(shown, /\+export const LIMIT = 30;/);
    assert.doesNotMatch(shown, /hunter2|SECRET_TOKEN/);

    for (const bad of ['--output=evil.txt', 'HEAD', 'abc', 'zzzzzzz', `${sha}; rm -rf /`]) {
      await assert.rejects(call(tools, 'git_show', { commit: bad }), /hex sha/, bad);
    }
  } finally {
    cleanup(dir);
  }
});

test('git_blame names the author per side, and "theirs" needs an operation in progress', async () => {
  const dir = makeRepo();
  try {
    const tools = createReadOnlyTools({ cwd: dir });
    assert.match(await call(tools, 'git_blame', { file: 'src/price.js', startLine: 1, endLine: 1 }), /Tester .*LIMIT = 20/);
    assert.match(await call(tools, 'git_blame', { file: 'src/price.js', startLine: 1, endLine: 1, side: 'theirs' }), /LIMIT = 30/);
    await assert.rejects(call(tools, 'git_blame', { file: '.env', startLine: 1, endLine: 1 }), /blocked/);

    git(dir, 'merge', '--abort');
    await assert.rejects(call(tools, 'git_log', { path: 'src/price.js', side: 'theirs' }), /no "theirs" side/);
  } finally {
    cleanup(dir);
  }
});

test('every tool declares a JSON schema the providers can use', () => {
  const tools = createReadOnlyTools({ cwd: process.cwd() });
  assert.deepEqual(tools.map((t) => t.name), [
    'read_file', 'find_references', 'list_importers', 'get_conflict_stages', 'git_log', 'git_show', 'git_blame',
  ]);
  for (const tool of tools) {
    assert.ok(tool.description.length > 10, tool.name);
    assert.equal(tool.parameters.type, 'object');
    assert.ok(tool.parameters.required.every((key) => key in tool.parameters.properties), tool.name);
    assert.equal(typeof tool.run, 'function');
  }
});
