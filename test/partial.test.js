import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, git, makeMultiConflictRepo } from '../test-support/gitRepo.js';
import { resolveConflicts } from '../src/orchestrator/index.js';
import { parseConflictHunks } from '../src/conflict/parser.js';

const makeRepo = makeMultiConflictRepo;

const read = (dir) => readFileSync(path.join(dir, 'f.txt'), 'utf8');
const markersIn = (dir) => parseConflictHunks(read(dir));

// Which conflict a prompt is about: read its OURS section only, because the code shown around
// a conflict mentions the neighbouring ones.
const which = (request) => request.messages[0].content.match(/--- OURS ---\n([abc])=2/)[1];
const keepBoth = (name) => JSON.stringify({ resolution: `${name}=2\n${name}=3`, explanation: 'keep both', confidence: 'high', ambiguous: false });
const doubtful = (name) => JSON.stringify({ resolution: `${name}=3`, explanation: 'unsure', confidence: 'low', ambiguous: true });
const options = { useIntent: false, useReferences: false };

test('the fixture really has three separate conflicts', () => {
  const dir = makeRepo();
  try {
    assert.equal(markersIn(dir).length, 3);
  } finally {
    cleanup(dir);
  }
});

test('accepting two conflicts and skipping the middle one keeps the two and leaves only the skipped one', async () => {
  const dir = makeRepo();
  try {
    const asked = [];
    const events = [];
    const llm = { complete: async (request) => (which(request) === 'b' ? doubtful('b') : keepBoth(which(request))) };

    const { files } = await resolveConflicts({
      ...options, cwd: dir, llm,
      approve: async ({ hunk, index, total, proposal }) => {
        asked.push({ index, total, resolution: proposal.resolution });
        return { action: 'reject' };
      },
      onEvent: (e) => events.push(e),
    });

    assert.deepEqual(asked, [{ index: 1, total: 3, resolution: 'b=3' }], 'only the doubtful one is asked, and knows its position');
    assert.equal(files[0].status, 'partial');
    assert.equal(files[0].remaining, 1);
    assert.equal(files[0].staged, false);

    const text = read(dir);
    assert.match(text, /a=2\na=3/, 'the first conflict was written');
    assert.match(text, /c=2\nc=3/, 'the third conflict was written');
    const left = markersIn(dir);
    assert.equal(left.length, 1, 'only one conflict still has markers');
    assert.equal(left[0].ours, 'b=2');
    assert.equal(left[0].theirs, 'b=3');

    assert.ok(events.some((e) => e.type === 'hunk-skipped' && e.index === 1 && e.total === 3));
    assert.ok(events.some((e) => e.type === 'partial' && e.remaining === 1));
    assert.ok(!events.some((e) => e.type === 'resolved'), 'a partly resolved file is not reported as resolved');
    assert.ok(!events.some((e) => e.type === 'rejected' || e.type === 'failed'));
  } finally {
    cleanup(dir);
  }
});

test('skipping every conflict changes nothing and is reported as rejected', async () => {
  const dir = makeRepo();
  try {
    const before = read(dir);
    const { files } = await resolveConflicts({
      ...options, cwd: dir,
      llm: { complete: async (request) => doubtful(which(request)) },
      approve: async () => ({ action: 'reject' }),
    });
    assert.equal(files[0].status, 'rejected');
    assert.equal(read(dir), before);
  } finally {
    cleanup(dir);
  }
});

test('accepting every conflict resolves the file completely', async () => {
  const dir = makeRepo();
  try {
    const { files } = await resolveConflicts({
      ...options, cwd: dir,
      llm: { complete: async (request) => keepBoth(which(request)) },
      approve: async () => assert.fail('nothing should need approval'),
    });
    assert.equal(files[0].status, 'resolved');
    assert.equal(files[0].remaining, undefined);
    assert.equal(markersIn(dir).length, 0);
  } finally {
    cleanup(dir);
  }
});

test('a model that fails on the second conflict still keeps the first, and the rest stay conflicted', async () => {
  const dir = makeRepo();
  try {
    let calls = 0;
    const llm = {
      complete: async (request) => {
        calls += 1;
        if (which(request) === 'a') return keepBoth('a');
        throw new Error('connection refused');
      },
    };
    const { files } = await resolveConflicts({ ...options, cwd: dir, llm, approve: async () => assert.fail('no approval expected') });

    assert.equal(files[0].status, 'partial');
    assert.equal(files[0].remaining, 2);
    assert.equal(files[0].reason, 'model error: connection refused');
    assert.equal(calls, 2, 'it stopped at the failure instead of asking again for the third conflict');
    assert.match(read(dir), /a=2\na=3/);
    assert.equal(markersIn(dir).length, 2);
  } finally {
    cleanup(dir);
  }
});

test('hitting the attempt limit skips that one conflict and carries on with the others', async () => {
  const dir = makeRepo();
  try {
    const events = [];
    const { files } = await resolveConflicts({
      ...options, cwd: dir, maxAttempts: 2,
      llm: { complete: async (request) => (which(request) === 'a' ? doubtful('a') : keepBoth(which(request))) },
      approve: async () => ({ action: 'retry', feedback: 'again' }),
      onEvent: (e) => events.push(e.type),
    });
    assert.ok(events.includes('attempt-limit'));
    assert.equal(files[0].status, 'partial');
    assert.equal(files[0].remaining, 1);
    assert.match(read(dir), /b=2\nb=3/);
    assert.match(read(dir), /c=2\nc=3/);
  } finally {
    cleanup(dir);
  }
});

test('a dry run reports "would-partial" and writes nothing', async () => {
  const dir = makeRepo();
  try {
    const before = read(dir);
    const { files } = await resolveConflicts({
      ...options, cwd: dir, dryRun: true,
      llm: { complete: async (request) => (which(request) === 'b' ? doubtful('b') : keepBoth(which(request))) },
      approve: async () => ({ action: 'reject' }),
    });
    assert.equal(files[0].status, 'would-partial');
    assert.equal(read(dir), before);
  } finally {
    cleanup(dir);
  }
});

test('a partly resolved file blocks validation and staging', async () => {
  const dir = makeRepo();
  try {
    let validated = false;
    const result = await resolveConflicts({
      ...options, cwd: dir, validate: true, stage: true,
      llm: { complete: async (request) => (which(request) === 'b' ? doubtful('b') : keepBoth(which(request))) },
      approve: async () => ({ action: 'reject' }),
      validator: async () => { validated = true; return { ran: true, passed: true, steps: [] }; },
    });
    assert.equal(validated, false);
    assert.match(result.notValidatedReason, /still unresolved/);
    assert.equal(result.files[0].staged, false);
    assert.deepEqual([...new Set(git(dir, 'ls-files', '-u').split('\n').filter(Boolean).map((l) => l.split('\t')[1]))], ['f.txt'], 'still unmerged in Git');
  } finally {
    cleanup(dir);
  }
});

test('a text edit on one conflict is kept while another is skipped', async () => {
  const dir = makeRepo();
  try {
    const decisions = { a: { action: 'edit', resolution: 'a=custom' }, b: { action: 'reject' }, c: { action: 'accept' } };
    const { files } = await resolveConflicts({
      ...options, cwd: dir, reviewAll: true,
      llm: { complete: async (request) => keepBoth(which(request)) },
      approve: async ({ proposal }) => decisions[proposal.resolution.slice(0, 1)],
    });
    assert.equal(files[0].status, 'partial');
    assert.match(read(dir), /a=custom/);
    assert.match(read(dir), /c=2\nc=3/);
    assert.equal(markersIn(dir).length, 1);
  } finally {
    cleanup(dir);
  }
});
