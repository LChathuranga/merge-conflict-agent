import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gatherIntentEvidence, summarizeIntent, determineIntent, buildIntentPrompt } from '../src/agents/intentAgent.js';
import { resolveConflicts } from '../src/orchestrator/index.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

// base -> feature (an unrelated commit plus one touching f.txt) and main (one touching f.txt).
const makeRepo = ({ operation }) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mca-intent-'));
  const write = (name, text) => writeFileSync(path.join(dir, name), text);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 'Tester');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'merge.conflictstyle', 'diff3');
  write('f.txt', 'timeout=30\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial commit');

  git(dir, 'checkout', '-q', '-b', 'feature');
  write('g.txt', 'unrelated\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'add unrelated file');
  write('f.txt', 'timeout=120\n');
  git(dir, 'commit', '-qam', 'Raise timeout for slow customer networks', '-m', 'Support tickets showed 30s was too short on satellite links.');

  git(dir, 'checkout', '-q', 'main');
  write('f.txt', 'timeout=5\n');
  git(dir, 'commit', '-qam', 'Fail fast: lower timeout to 5s');

  try {
    git(dir, operation, 'feature');
  } catch {
    // the conflict is expected
  }
  return dir;
};

const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });
const subjects = (side) => side.commits.map((c) => c.subject);

test('gathers both sides of a merge, preferring commits that touch the conflicted files', async () => {
  const dir = makeRepo({ operation: 'merge' });
  try {
    const evidence = await gatherIntentEvidence({ cwd: dir, files: ['f.txt'] });
    assert.equal(evidence.operation, 'merge');
    assert.equal(evidence.ours.label, 'main');
    assert.equal(evidence.theirs.label, 'feature');
    assert.deepEqual(subjects(evidence.ours), ['Fail fast: lower timeout to 5s']);
    assert.deepEqual(subjects(evidence.theirs), ['Raise timeout for slow customer networks']);
    assert.equal(evidence.theirs.touchesConflictedFiles, true);
    assert.match(evidence.theirs.commits[0].body, /satellite links/);
  } finally {
    cleanup(dir);
  }
});

test('a cherry-pick treats exactly the picked commit as theirs', async () => {
  const dir = makeRepo({ operation: 'cherry-pick' });
  try {
    const evidence = await gatherIntentEvidence({ cwd: dir, files: ['f.txt'] });
    assert.equal(evidence.operation, 'cherry-pick');
    assert.deepEqual(subjects(evidence.theirs), ['Raise timeout for slow customer networks']);
    assert.equal(evidence.theirs.touchesConflictedFiles, false);
  } finally {
    cleanup(dir);
  }
});

test('returns null when no merge, cherry-pick or rebase is in progress', async () => {
  const dir = makeRepo({ operation: 'merge' });
  try {
    git(dir, 'merge', '--abort');
    assert.equal(await gatherIntentEvidence({ cwd: dir, files: ['f.txt'] }), null);
    const llm = { complete: async () => assert.fail('no model call expected') };
    assert.equal(await determineIntent({ llm, cwd: dir, files: ['f.txt'] }), null);
  } finally {
    cleanup(dir);
  }
});

test('summarizeIntent sends commit messages to the model and formats the answer', async () => {
  const dir = makeRepo({ operation: 'merge' });
  try {
    let seen;
    const llm = {
      complete: async (req) => {
        seen = req;
        return '```json\n{"ours": "Wants requests to fail quickly.", "theirs": "Wants slow networks to succeed.", "relationship": "Conflict: opposite timeout goals."}\n```';
      },
    };
    const intent = await determineIntent({ llm, cwd: dir, files: ['f.txt'] });

    assert.equal(seen.json, true);
    assert.match(seen.system, /untrusted data/);
    assert.match(seen.messages[0].content, /Fail fast: lower timeout to 5s/);
    assert.match(seen.messages[0].content, /satellite links/);
    assert.equal(intent.ours.summary, 'Wants requests to fail quickly.');
    assert.match(intent.text, /^Operation: merge\nOurs \(main\): Wants requests/);
    assert.match(intent.text, /Relationship: Conflict: opposite timeout goals\.$/);
  } finally {
    cleanup(dir);
  }
});

test('missing or blank fields become "unclear" and non-JSON replies throw', async () => {
  const evidence = {
    operation: 'merge',
    files: ['f.txt'],
    ours: { label: 'main', commits: [] },
    theirs: { label: 'feature', commits: [] },
  };
  const intent = await summarizeIntent({ llm: { complete: async () => '{"ours": "  "}' }, evidence });
  assert.equal(intent.ours.summary, 'unclear');
  assert.equal(intent.relationship, 'unclear');
  assert.match(buildIntentPrompt(evidence), /\(no commits found\)/);
  await assert.rejects(
    summarizeIntent({ llm: { complete: async () => 'nope' }, evidence }),
    /Intent Agent returned no JSON/
  );
});

test('orchestrator passes the intent summary into the conflict prompt and reports it', async () => {
  const dir = makeRepo({ operation: 'merge' });
  try {
    const prompts = [];
    const events = [];
    const llm = {
      complete: async (req) => {
        prompts.push(req.messages[0].content);
        if (/Intent Agent/.test(req.system)) {
          return '{"ours": "fail fast", "theirs": "tolerate slow networks", "relationship": "opposite goals"}';
        }
        return '{"resolution": "timeout=5\\ntimeout=120", "confidence": "high", "ambiguous": false}';
      },
    };
    await resolveConflicts({
      cwd: dir,
      llm,
      dryRun: true,
      approve: async () => ({ action: 'reject' }),
      onEvent: (e) => events.push(e),
    });

    assert.ok(events.some((e) => e.type === 'intent' && e.intent.theirs.summary === 'tolerate slow networks'));
    const conflictPrompt = prompts.find((p) => p.startsWith('File: f.txt'));
    assert.match(conflictPrompt, /Known intent of the branches:\nOperation: merge/);
    assert.match(conflictPrompt, /Theirs \(feature\): tolerate slow networks/);
  } finally {
    cleanup(dir);
  }
});

test('a failing intent agent is reported but never blocks resolving', async () => {
  const dir = makeRepo({ operation: 'merge' });
  try {
    const events = [];
    const llm = {
      complete: async () => '{"resolution": "timeout=5\\ntimeout=120", "confidence": "high", "ambiguous": false}',
    };
    const { files } = await resolveConflicts({
      cwd: dir,
      llm,
      dryRun: true,
      intentAgent: async () => {
        throw new Error('boom');
      },
      approve: async () => assert.fail('should not ask for approval'),
      onEvent: (e) => events.push(e),
    });
    assert.equal(files[0].status, 'would-resolve');
    assert.deepEqual(events.find((e) => e.type === 'intent-unavailable'), {
      type: 'intent-unavailable',
      reason: 'boom',
    });
  } finally {
    cleanup(dir);
  }
});
