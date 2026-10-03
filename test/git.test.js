import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGit } from '../src/git/exec.js';
import {
  listConflictedFiles,
  getConflictStages,
  readWorkingFile,
  isMergeInProgress,
} from '../src/git/index.js';
import { parseConflictHunks, hasConflictMarkers } from '../src/conflict/parser.js';

let dir;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mca-'));
  const git = (...args) => runGit(dir, args);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 't@example.com');
  await git('config', 'user.name', 'Test');
  await git('config', 'merge.conflictstyle', 'diff3');

  const file = path.join(dir, 'a.txt');
  await writeFile(file, 'one\ntwo\nthree\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'base');

  await git('checkout', '-q', '-b', 'feature');
  await writeFile(file, 'one\ntwo-feature\nthree\n');
  await git('commit', '-qam', 'feature change');

  await git('checkout', '-q', 'main');
  await writeFile(file, 'one\ntwo-main\nthree\n');
  await git('commit', '-qam', 'main change');

  await runGit(dir, ['merge', 'feature'], { allowFailure: true });
});

after(() => rm(dir, { recursive: true, force: true }));

test('detects merge in progress and conflicted files', async () => {
  assert.equal(await isMergeInProgress(dir), true);
  assert.deepEqual(await listConflictedFiles(dir), ['a.txt']);
});

test('extracts base/ours/theirs stages', async () => {
  const s = await getConflictStages(dir, 'a.txt');
  assert.equal(s.base, 'one\ntwo\nthree\n');
  assert.equal(s.ours, 'one\ntwo-main\nthree\n');
  assert.equal(s.theirs, 'one\ntwo-feature\nthree\n');
});

test('parses hunks from the working tree file', async () => {
  const text = await readWorkingFile(dir, 'a.txt');
  assert.equal(hasConflictMarkers(text), true);
  const [h] = parseConflictHunks(text);
  assert.equal(h.ours, 'two-main');
  assert.equal(h.base, 'two');
  assert.equal(h.theirs, 'two-feature');
  assert.equal(h.startLine, 2);
  assert.equal(h.endLine, 8);
});

test('parser handles plain (non-diff3) markers and clean text', () => {
  const plain = 'x\n<<<<<<< HEAD\nA\n=======\nB\n>>>>>>> other\ny\n';
  const [h] = parseConflictHunks(plain);
  assert.equal(h.base, null);
  assert.equal(h.oursLabel, 'HEAD');
  assert.equal(h.theirsLabel, 'other');
  assert.equal(hasConflictMarkers('nothing here\n'), false);
});
