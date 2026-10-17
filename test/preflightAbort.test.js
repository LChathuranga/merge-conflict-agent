import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { cleanup, git, makePickRepo } from '../test-support/gitRepo.js';
import { runPreflight } from '../src/preflight/index.js';

const tipOfFeature = (dir) => git(dir, 'rev-parse', 'feature');
const worktrees = (dir) => git(dir, 'worktree', 'list').split('\n').length;

test('an already-cancelled check does nothing at all', async () => {
  const dir = makePickRepo();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runPreflight({ cwd: dir, commit: tipOfFeature(dir), signal: controller.signal }), { name: 'AbortError' });
    assert.equal(worktrees(dir), 1);
  } finally {
    cleanup(dir);
  }
});

test('cancelling after the trial pick has started still removes the temporary worktree', { timeout: 300000 }, async () => {
  const dir = makePickRepo();
  try {
    const controller = new AbortController();
    const head = git(dir, 'rev-parse', 'HEAD');
    const steps = [];

    await assert.rejects(
      runPreflight({
        cwd: dir,
        commit: tipOfFeature(dir),
        signal: controller.signal,
        // "references" is announced once the trial pick has applied inside the worktree.
        onEvent: (e) => {
          if (e.type !== 'preflight-step') return;
          steps.push(e.step);
          if (e.step === 'references') controller.abort();
        },
      }),
      { name: 'AbortError' }
    );

    assert.ok(steps.includes('references'), 'the worktree existed when it was cancelled');
    assert.equal(worktrees(dir), 1, 'git no longer lists the temporary worktree');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
    assert.equal(git(dir, 'status', '--porcelain'), '');
    assert.equal(existsSync(path.join(dir, '.git', 'CHERRY_PICK_HEAD')), false);
  } finally {
    cleanup(dir);
  }
});
