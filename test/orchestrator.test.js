import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveConflicts } from '../src/orchestrator/index.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

const makeConflictRepo = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mca-orch-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'merge.conflictstyle', 'diff3');
  git(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(path.join(dir, 'f.txt'), 'top\nvalue=0\nbottom\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  writeFileSync(path.join(dir, 'f.txt'), 'top\nvalue=3\nbottom\n');
  git(dir, 'commit', '-qam', 'feature');
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(path.join(dir, 'f.txt'), 'top\nvalue=2\nbottom\n');
  git(dir, 'commit', '-qam', 'main');
  try { git(dir, 'merge', 'feature'); } catch { /* expected conflict */ }
  return dir;
};

// These tests script one fake model per run, so the extra intent call is disabled here.
const resolve = (options) => resolveConflicts({ useIntent: false, ...options });

const llmReplying = (json) => ({ complete: async () => JSON.stringify(json) });
const confident = { resolution: 'value=2\nvalue=3', explanation: 'take feature', confidence: 'high', ambiguous: false };

const passingValidator = async () => ({ ran: true, passed: true, steps: [{ name: 'test', status: 'passed' }] });
const failingValidator = async () => ({ ran: true, passed: false, steps: [{ name: 'test', status: 'failed', output: 'boom' }] });
const emptyValidator = async () => ({ ran: false, passed: false, steps: [] });
const unmerged = (dir) => git(dir, 'diff', '--name-only', '--diff-filter=U').trim();

test('auto-resolves a confident hunk, writes the file, stages after validation passes', async () => {
  const dir = makeConflictRepo();
  try {
    const { files, validation } = await resolve({
      cwd: dir,
      llm: llmReplying(confident),
      approve: async () => assert.fail('should not ask for approval'),
      stage: true,
      validator: passingValidator,
    });
    assert.equal(files[0].status, 'resolved');
    assert.equal(files[0].staged, true);
    assert.equal(validation.passed, true);
    assert.equal(readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'top\nvalue=2\nvalue=3\nbottom\n');
    assert.equal(unmerged(dir), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failed validation blocks staging but leaves the resolved file on disk', async () => {
  const dir = makeConflictRepo();
  try {
    const { files, stageBlockedReason } = await resolve({
      cwd: dir,
      llm: llmReplying(confident),
      approve: async () => assert.fail('should not ask for approval'),
      stage: true,
      validator: failingValidator,
    });
    assert.equal(files[0].status, 'resolved');
    assert.equal(files[0].staged, false);
    assert.equal(stageBlockedReason, 'validation failed');
    assert.equal(readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'top\nvalue=2\nvalue=3\nbottom\n');
    assert.equal(unmerged(dir), 'f.txt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no validation commands found means nothing is staged', async () => {
  const dir = makeConflictRepo();
  try {
    const { stageBlockedReason, notValidatedReason } = await resolve({
      cwd: dir,
      llm: llmReplying(confident),
      approve: async () => assert.fail('should not ask for approval'),
      stage: true,
      validator: emptyValidator,
    });
    assert.equal(notValidatedReason, 'no validation commands found');
    assert.equal(stageBlockedReason, 'no validation commands found');
    assert.equal(unmerged(dir), 'f.txt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validation is skipped when a file was rejected, and --validate alone never stages', async () => {
  const dir = makeConflictRepo();
  try {
    const rejected = await resolve({
      cwd: dir,
      llm: llmReplying({ ...confident, ambiguous: true }),
      approve: async () => ({ action: 'reject' }),
      validate: true,
      validator: async () => assert.fail('must not validate a half-resolved repo'),
    });
    assert.match(rejected.notValidatedReason, /unresolved/);

    const validated = await resolve({
      cwd: dir,
      llm: llmReplying(confident),
      approve: async () => assert.fail('should not ask for approval'),
      validate: true,
      validator: passingValidator,
    });
    assert.equal(validated.validation.passed, true);
    assert.equal(validated.files[0].staged, false);
    assert.equal(unmerged(dir), 'f.txt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ambiguous hunk asks for approval; reject leaves the file untouched', async () => {
  const dir = makeConflictRepo();
  try {
    const before = readFileSync(path.join(dir, 'f.txt'), 'utf8');
    let asked = 0;
    const { files } = await resolve({
      cwd: dir,
      llm: llmReplying({ ...confident, ambiguous: true }),
      approve: async () => { asked += 1; return { action: 'reject' }; },
    });
    assert.equal(asked, 1);
    assert.equal(files[0].status, 'rejected');
    assert.equal(readFileSync(path.join(dir, 'f.txt'), 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edit decision uses the user resolution; dry-run writes nothing', async () => {
  const dir = makeConflictRepo();
  try {
    const before = readFileSync(path.join(dir, 'f.txt'), 'utf8');
    const { files } = await resolve({
      cwd: dir,
      llm: llmReplying(confident),
      reviewAll: true,
      dryRun: true,
      approve: async () => ({ action: 'edit', resolution: 'value=99' }),
    });
    assert.equal(files[0].status, 'would-resolve');
    assert.equal(readFileSync(path.join(dir, 'f.txt'), 'utf8'), before);

    await resolve({
      cwd: dir,
      llm: llmReplying(confident),
      reviewAll: true,
      approve: async () => ({ action: 'edit', resolution: 'value=99' }),
    });
    assert.equal(readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'top\nvalue=99\nbottom\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hunk that keeps one side verbatim asks for approval even if the model is confident', async () => {
  const dir = makeConflictRepo();
  try {
    let asked = 0;
    const { files } = await resolve({
      cwd: dir,
      llm: llmReplying({ ...confident, resolution: 'value=3' }),
      approve: async ({ proposal }) => {
        asked += 1;
        assert.equal(proposal.flags.length, 1);
        return { action: 'reject' };
      },
    });
    assert.equal(asked, 1);
    assert.equal(files[0].status, 'rejected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unparseable model reply fails that file instead of crashing the run', async () => {
  const dir = makeConflictRepo();
  try {
    const before = readFileSync(path.join(dir, 'f.txt'), 'utf8');
    const { files } = await resolve({
      cwd: dir,
      llm: { complete: async () => 'garbage' },
      approve: async () => assert.fail('should not ask for approval'),
    });
    assert.equal(files[0].status, 'failed');
    assert.match(files[0].reason, /^model error:/);
    assert.equal(readFileSync(path.join(dir, 'f.txt'), 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('feedback sends the user comment back to the model and applies the revised proposal', async () => {
  const dir = makeConflictRepo();
  try {
    const requests = [];
    const replies = [
      { ...confident, resolution: 'value=2\nvalue=3' },
      { ...confident, resolution: 'value=2\nvalue=3\n// merged' },
    ];
    const llm = { complete: async (req) => { requests.push(req); return JSON.stringify(replies.shift()); } };
    const decisions = [{ action: 'retry', feedback: 'add a comment' }, { action: 'accept' }];
    const attempts = [];

    const { files } = await resolve({
      cwd: dir,
      llm,
      reviewAll: true,
      approve: async ({ attempt }) => { attempts.push(attempt); return decisions.shift(); },
    });

    assert.deepEqual(attempts, [0, 1]);
    assert.equal(requests.length, 2);
    assert.match(requests[1].messages.at(-1).content, /add a comment/);
    assert.equal(files[0].status, 'resolved');
    assert.equal(readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'top\nvalue=2\nvalue=3\n// merged\nbottom\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a revised proposal is shown to the user even when the model is confident and review is off', async () => {
  const dir = makeConflictRepo();
  try {
    let asked = 0;
    const decisions = [{ action: 'retry', feedback: '' }, { action: 'accept' }];
    // First answer keeps only one side, which forces the first approval request.
    const replies = [{ ...confident, resolution: 'value=3' }, confident];
    const { files } = await resolve({
      cwd: dir,
      llm: { complete: async () => JSON.stringify(replies.shift()) },
      approve: async () => { asked += 1; return decisions.shift(); },
    });
    assert.equal(asked, 2);
    assert.equal(files[0].status, 'resolved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('endless retries stop at maxAttempts and the file is left for manual resolution', async () => {
  const dir = makeConflictRepo();
  try {
    const before = readFileSync(path.join(dir, 'f.txt'), 'utf8');
    let modelCalls = 0;
    const events = [];
    const { files } = await resolve({
      cwd: dir,
      llm: { complete: async () => { modelCalls += 1; return JSON.stringify(confident); } },
      reviewAll: true,
      maxAttempts: 2,
      onEvent: (e) => events.push(e.type),
      approve: async () => ({ action: 'retry', feedback: 'again' }),
    });
    assert.equal(modelCalls, 2);
    assert.equal(files[0].status, 'rejected');
    assert.ok(events.includes('attempt-limit'));
    assert.equal(readFileSync(path.join(dir, 'f.txt'), 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
