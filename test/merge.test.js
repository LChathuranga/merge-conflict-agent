import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repoFromTemplate } from '../test-support/gitRepo.js';
import { abortMerge, abortOperation, getMergeState, listMergeCandidates, pendingOperation, startMerge } from '../src/git/merge.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });
const read = (dir, file) => readFileSync(path.join(dir, file), 'utf8');
const mergeHeadExists = (dir) => existsSync(path.join(dir, '.git', 'MERGE_HEAD'));

// main and branches off the same base:
//   feature      changes c.txt (conflicts with main) and adds d.txt
//   clean-branch only adds e.txt (merges cleanly)
//   old          points at the base commit (already part of main)
//   stranger     unrelated history
const buildRepo = (dir) => {
  const put = (file, text) => writeFileSync(path.join(dir, file), text);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'merge.conflictstyle', 'diff3');
  put('c.txt', 'c=0\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'branch', 'old');

  git(dir, 'checkout', '-q', '-b', 'clean-branch');
  put('e.txt', 'e\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'add e');

  git(dir, 'checkout', '-q', 'main');
  git(dir, 'checkout', '-q', '-b', 'feature');
  put('c.txt', 'c=3\n');
  put('d.txt', 'd\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'feature work');

  git(dir, 'checkout', '-q', 'main');
  put('c.txt', 'c=2\n');
  git(dir, 'commit', '-qam', 'main work');

  git(dir, 'checkout', '-q', '--orphan', 'stranger');
  git(dir, 'rm', '-rfq', '.');
  put('z.txt', 'z\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'unrelated');
  git(dir, 'checkout', '-q', 'main');
};
const makeRepo = () => repoFromTemplate('merge', buildRepo);

test('a conflicting merge starts, lists the conflicts and creates no commit', async () => {
  const dir = makeRepo();
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    const result = await startMerge(dir, 'feature');

    assert.equal(result.status, 'conflicts');
    assert.deepEqual(result.conflicts, ['c.txt']);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'no commit was created');
    assert.match(read(dir, 'c.txt'), /<<<<<<< HEAD/);
    assert.equal(read(dir, 'd.txt'), 'd\n', 'the non-conflicting change is already merged in');

    const state = await getMergeState(dir);
    assert.equal(state.inProgress, true);
    assert.equal(state.operation, 'merge');
    assert.equal(state.branch, 'main');
    assert.equal(state.theirs.label, 'feature');
    assert.deepEqual(state.conflictedFiles, ['c.txt']);
  } finally {
    cleanup(dir);
  }
});

test('aborting restores the branch exactly as it was', async () => {
  const dir = makeRepo();
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    await startMerge(dir, 'feature');
    assert.equal((await abortMerge(dir)).status, 'aborted');

    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
    assert.equal(read(dir, 'c.txt'), 'c=2\n');
    assert.equal(existsSync(path.join(dir, 'd.txt')), false);
    assert.equal(mergeHeadExists(dir), false);
    assert.equal(git(dir, 'status', '--porcelain'), '');
    assert.equal((await getMergeState(dir)).inProgress, false);
  } finally {
    cleanup(dir);
  }
});

test('a merge without conflicts waits uncommitted for the user to review', async () => {
  const dir = makeRepo();
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    const result = await startMerge(dir, 'clean-branch');

    assert.equal(result.status, 'clean');
    assert.deepEqual(result.conflicts, []);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'still no commit');
    assert.equal(read(dir, 'e.txt'), 'e\n');
    assert.equal(mergeHeadExists(dir), true);
    assert.equal((await getMergeState(dir)).inProgress, true);
  } finally {
    cleanup(dir);
  }
});

test('a branch that is already merged is reported and nothing is run', async () => {
  const dir = makeRepo();
  try {
    const result = await startMerge(dir, 'old');
    assert.equal(result.status, 'up-to-date');
    assert.equal(mergeHeadExists(dir), false);
  } finally {
    cleanup(dir);
  }
});

test('uncommitted changes to tracked files refuse the merge and leave them alone', async () => {
  const dir = makeRepo();
  try {
    writeFileSync(path.join(dir, 'c.txt'), 'c=local edit\n');
    const result = await startMerge(dir, 'feature');
    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'dirty-tree');
    assert.equal(read(dir, 'c.txt'), 'c=local edit\n');
    assert.equal(mergeHeadExists(dir), false);
  } finally {
    cleanup(dir);
  }
});

test('untracked files that do not collide do not block a merge', async () => {
  const dir = makeRepo();
  try {
    writeFileSync(path.join(dir, 'notes.txt'), 'scratch\n');
    assert.equal((await startMerge(dir, 'clean-branch')).status, 'clean');
    assert.equal(read(dir, 'notes.txt'), 'scratch\n');
  } finally {
    cleanup(dir);
  }
});

test('an untracked file in the way is reported as git\'s own error and nothing is half-done', async () => {
  const dir = makeRepo();
  try {
    writeFileSync(path.join(dir, 'e.txt'), 'my own e\n');
    const result = await startMerge(dir, 'clean-branch');
    assert.equal(result.status, 'error');
    assert.ok(result.message.length > 0);
    assert.equal(read(dir, 'e.txt'), 'my own e\n', 'the user\'s file is untouched');
    assert.equal(mergeHeadExists(dir), false);
  } finally {
    cleanup(dir);
  }
});

test('unrelated histories are refused by git and reported', async () => {
  const dir = makeRepo();
  try {
    const result = await startMerge(dir, 'stranger');
    assert.equal(result.status, 'error');
    assert.ok(result.message.length > 0);
    assert.equal(mergeHeadExists(dir), false);
  } finally {
    cleanup(dir);
  }
});

test('a second merge cannot start while an operation is waiting, and other operations are detected', async () => {
  const dir = makeRepo();
  try {
    await startMerge(dir, 'feature');
    assert.equal(await pendingOperation(dir), 'merge');
    const again = await startMerge(dir, 'clean-branch');
    assert.equal(again.status, 'refused');
    assert.equal(again.reason, 'operation-in-progress');
    await abortMerge(dir);
    assert.equal(await pendingOperation(dir), null);

    // A cherry-pick that stops on conflicts blocks a merge too.
    try { git(dir, 'cherry-pick', 'feature'); } catch { /* conflict expected */ }
    assert.equal(await pendingOperation(dir), 'cherry-pick');
    const blocked = await startMerge(dir, 'clean-branch');
    assert.equal(blocked.status, 'refused');
    assert.match(blocked.message, /cherry-pick/);
    git(dir, 'cherry-pick', '--abort');
  } finally {
    cleanup(dir);
  }
});

test('a detached HEAD needs an explicit go-ahead', async () => {
  const dir = makeRepo();
  try {
    git(dir, 'checkout', '-q', '--detach');
    assert.equal((await getMergeState(dir)).detached, true);

    const refusal = await startMerge(dir, 'feature');
    assert.equal(refusal.status, 'refused');
    assert.equal(refusal.reason, 'detached-head');
    assert.equal(mergeHeadExists(dir), false);

    assert.equal((await startMerge(dir, 'feature', { allowDetached: true })).status, 'conflicts');
  } finally {
    cleanup(dir);
  }
});

test('unsafe or unknown branch names are rejected before git sees them', async () => {
  const dir = makeRepo();
  try {
    for (const bad of ['--abort', '-s', '--no-commit', 'feature; echo hi', 'a..b', '', undefined, 'no-such-branch']) {
      await assert.rejects(startMerge(dir, bad), undefined, `should reject ${JSON.stringify(bad)}`);
    }
    assert.equal(mergeHeadExists(dir), false);
  } finally {
    cleanup(dir);
  }
});

test('abort with no merge in progress is refused', async () => {
  const dir = makeRepo();
  try {
    const result = await abortMerge(dir);
    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'no-merge');
  } finally {
    cleanup(dir);
  }
});

test('merge candidates are the branches that have something to merge, with counts', async () => {
  const dir = makeRepo();
  try {
    const candidates = await listMergeCandidates(dir);
    assert.deepEqual(candidates, [
      { name: 'clean-branch', ahead: 1 },
      { name: 'feature', ahead: 1 },
      { name: 'stranger', ahead: 1 },
    ]);
  } finally {
    cleanup(dir);
  }
});

test('a cherry-pick that conflicts is a resolvable operation, named by its commit, and can be aborted', async () => {
  const dir = makeRepo();
  try {
    try { git(dir, 'cherry-pick', 'feature'); } catch { /* the conflict is expected */ }
    const state = await getMergeState(dir);
    assert.equal(state.operation, 'cherry-pick');
    assert.equal(state.resolvable, true);
    assert.equal(state.inProgress, false, 'inProgress still means a merge');
    assert.match(state.theirs.label, /^[0-9a-f]{7} ".+"$/);
    assert.ok(state.conflictedFiles.length > 0);

    const head = git(dir, 'rev-parse', 'HEAD');
    const result = await abortOperation(dir);
    assert.equal(result.status, 'aborted');
    assert.equal(result.operation, 'cherry-pick');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
    assert.equal((await getMergeState(dir)).operation, null);
    assert.equal((await abortOperation(dir)).status, 'refused');
  } finally {
    cleanup(dir);
  }
});

test('abortOperation leaves a revert alone', async () => {
  const dir = makeRepo();
  try {
    writeFileSync(path.join(dir, '.git', 'REVERT_HEAD'), `${git(dir, 'rev-parse', 'HEAD')}\n`);
    const result = await abortOperation(dir);
    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'other-operation');
  } finally {
    cleanup(dir);
  }
});
