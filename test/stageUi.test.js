import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createFakeVscode } from '../test-support/fakeVscode.js';
import { ollamaRunning } from '../test-support/network.js';
import { cleanup, git, makeMergeRepo, mergeHeadExists } from '../test-support/gitRepo.js';
import { activateWith } from '../src/ui/vscode/activate.js';
import { stageResolvedFiles } from '../src/orchestrator/stage.js';
import { stageNotes, stageableFiles } from '../src/ui/viewmodel/stageModel.js';
import { buildTree } from '../src/ui/viewmodel/treeModel.js';

const keepBoth = (name) => JSON.stringify({ resolution: `${name}=2\n${name}=3`, explanation: 'keep both', confidence: 'high', ambiguous: false });
const unmerged = (dir) => [...new Set(git(dir, 'ls-files', '-u').split('\n').filter(Boolean).map((l) => l.split('\t')[1]))].sort();

const active = [];
const finish = async (...dirs) => {
  for (const api of active.splice(0)) {
    api.gitState.dispose();
    await api.gitState.settled();
  }
  dirs.forEach(cleanup);
};

// A merge in progress and the extension open on it; a scripted model resolves what it is asked to.
const open = async () => {
  const dir = makeMergeRepo();
  try { git(dir, 'merge', '--no-ff', '--no-commit', 'feature'); } catch { /* conflicts expected */ }
  const fake = createFakeVscode({ folders: [dir], settings: { 'mergeAssistant.useIntent': false, 'mergeAssistant.useReferences': false } });
  const client = { complete: async (request) => keepBoth(/File: c\.txt/.test(request.messages[0].content) ? 'c' : 'd') };
  const api = await activateWith(fake.vscode, fake.context(), { debounceMs: 20, createClient: () => client, fetchImpl: ollamaRunning() });
  active.push(api);
  return { dir, fake, api, run: (id, ...args) => fake.commands.get(id)(...args) };
};

test('stageResolvedFiles marks only verified files resolved, and re-checks each one at that moment', async () => {
  const dir = makeMergeRepo();
  try {
    try { git(dir, 'merge', '--no-ff', '--no-commit', 'feature'); } catch { /* conflicts expected */ }
    writeFileSync(path.join(dir, 'c.txt'), 'c=2\nc=3\n'); // fixed
    // d.txt still has markers; e.txt is not an unmerged file at all; ghost.txt does not exist.
    const result = await stageResolvedFiles({ cwd: dir, files: ['c.txt', 'd.txt', 'e.txt', 'ghost.txt'] });

    assert.deepEqual(result.staged, ['c.txt']);
    assert.deepEqual(Object.fromEntries(result.refused.map((r) => [r.file, r.reason])), {
      'd.txt': 'still has conflict markers',
      'e.txt': 'is not an unmerged file',
      'ghost.txt': 'is not an unmerged file',
    });
    assert.deepEqual(unmerged(dir), ['d.txt'], 'git now lists only the file that was refused');
    assert.equal(mergeHeadExists(dir), true, 'still merging');
  } finally {
    cleanup(dir);
  }
});

test('Stage Resolved Files: confirm, stage, and Git stops listing the files as conflicts; no commit is made', async () => {
  const { dir, fake, api, run } = await open();
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    await run('mergeAssistant.resolveAll');
    assert.deepEqual(unmerged(dir), ['c.txt', 'd.txt'], 'resolved on disk, but Git still lists them as conflicts');

    fake.script.information.push('Stage Files', 'Open Source Control');
    await run('mergeAssistant.stageResolved');

    const ask = fake.callsOf('information').find((c) => /^Stage 2 resolved files\?/.test(c.message));
    assert.equal(ask.rest[0].modal, true);
    assert.match(ask.rest[0].detail, /These 2 files will be marked resolved in Git \(git add\):\n {2}c\.txt\n {2}d\.txt/);
    assert.match(ask.rest[0].detail, /The checks have not been run on this code\./);
    assert.match(ask.rest[0].detail, /This does not commit\./);

    assert.deepEqual(unmerged(dir), [], 'Git no longer lists any conflicts');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'no commit was made');
    assert.equal(mergeHeadExists(dir), true, 'the merge still waits for the user to commit');
    assert.match(fake.messages('information').at(-1), /^Staged 2 files\. Nothing was committed/);
    assert.ok(fake.callsOf('executeCommand').some((c) => c.id === 'workbench.view.scm'));

    const tree = buildTree(api.session.state);
    assert.ok(!tree.some((n) => n.id === 'step:stage'), 'the Stage row is gone once nothing is left to stage');
    assert.equal(fake.contexts.get('mergeAssistant.hasStageable'), false);
    assert.equal(tree[0].children[0].label, 'All conflicts are handled');
  } finally {
    await finish(dir);
  }
});

test('declining the confirmation stages nothing', async () => {
  const { dir, fake, run } = await open();
  try {
    await run('mergeAssistant.resolveAll');
    await run('mergeAssistant.stageResolved'); // dismissed
    assert.deepEqual(unmerged(dir), ['c.txt', 'd.txt']);
    assert.ok(!fake.messages('information').some((m) => /^Staged/.test(m)));
  } finally {
    await finish(dir);
  }
});

test('when the checks failed the confirmation is a warning that says so', async () => {
  const { dir, fake, api, run } = await open();
  try {
    await run('mergeAssistant.resolveAll');
    api.session.setValidation({ ran: true, passed: false, cancelled: false, steps: [{ name: 'test', status: 'failed', exitCode: 1 }] });

    await run('mergeAssistant.stageResolved'); // dismissed
    const warning = fake.callsOf('warning').find((c) => /^Stage 2 resolved files\?/.test(c.message));
    assert.ok(warning, 'a failed check upgrades the prompt to a warning');
    assert.match(warning.rest[0].detail, /WARNING: the checks FAILED on this code/);
    assert.deepEqual(unmerged(dir), ['c.txt', 'd.txt']);
  } finally {
    await finish(dir);
  }
});

test('it only stages files this extension resolved, and says what stays conflicted', async () => {
  const { dir, fake, api, run } = await open();
  try {
    await run('mergeAssistant.resolveFile', { file: 'c.txt' }); // only c.txt
    fake.script.information.push('Stage Files');
    await run('mergeAssistant.stageResolved');

    const ask = fake.callsOf('information').find((c) => /^Stage 1 resolved file\?/.test(c.message));
    assert.match(ask.rest[0].detail, /1 other file stay conflicted: d\.txt\./);
    assert.deepEqual(unmerged(dir), ['d.txt']);
    assert.deepEqual(stageableFiles(api.session.state), [], 'nothing else is ready');
  } finally {
    await finish(dir);
  }
});

test('with nothing resolved, no merge, or a task running, it explains instead of staging', async () => {
  const { dir, fake, api, run } = await open();
  try {
    await run('mergeAssistant.stageResolved');
    assert.match(fake.messages('information')[0], /No files are ready to stage\. Resolve the conflicts first/);

    let release;
    const busy = api.runner.run('validate', () => new Promise((resolve) => { release = resolve; }), { title: 'x' });
    await new Promise((resolve) => setImmediate(resolve));
    await run('mergeAssistant.stageResolved');
    assert.match(fake.messages('warning').at(-1), /Wait for the running task to finish/);
    release();
    await busy;

    git(dir, 'merge', '--abort');
    await run('mergeAssistant.refresh');
    await run('mergeAssistant.stageResolved');
    assert.match(fake.messages('information').at(-1), /There is no merge in progress, so there is nothing to stage/);
    assert.deepEqual(unmerged(dir), []);
  } finally {
    await finish(dir);
  }
});

test('a file edited back to having markers between the click and the confirmation is refused, not staged', async () => {
  const { dir, fake, run } = await open();
  try {
    await run('mergeAssistant.resolveAll');
    // The user pastes a conflict back in while the confirmation is open.
    fake.script.information.push('Stage Files');
    const original = fake.vscode.window.showInformationMessage;
    fake.vscode.window.showInformationMessage = async (message, ...rest) => {
      if (/^Stage 2 resolved files\?/.test(message)) writeFileSync(path.join(dir, 'd.txt'), '<<<<<<< HEAD\nd=2\n=======\nd=3\n>>>>>>> feature\n');
      return original(message, ...rest);
    };
    await run('mergeAssistant.stageResolved');

    assert.deepEqual(unmerged(dir), ['d.txt'], 'only the still-clean file was staged');
    assert.match(fake.messages('warning').at(-1), /^Staged 1 of 2\. Not staged: d\.txt still has conflict markers\./);
  } finally {
    await finish(dir);
  }
});

test('stageNotes and stageableFiles describe the ready files and the check result', () => {
  const state = {
    files: [
      { path: 'a.js', status: 'resolved', hunks: [] },
      { path: 'b.js', status: 'resolved', hunks: [{ startLine: 1, endLine: 5 }] },
      { path: 'c.js', status: 'manual', hunks: [] },
      { path: 'd.js', status: 'skipped', hunks: [{ startLine: 1, endLine: 5 }] },
    ],
    validation: null,
  };
  assert.deepEqual(stageableFiles(state), ['a.js'], 'markers left, or not resolved by this extension, means not ready');
  assert.equal(stageNotes(state, ['a.js']).severity, 'normal');
  assert.match(stageNotes(state, ['a.js']).lines.join('\n'), /3 other files stay conflicted: b\.js, c\.js, d\.js\./);
  assert.equal(stageNotes({ ...state, validation: { ran: true, passed: true, steps: [] } }, ['a.js']).lines.some((l) => /checks passed/.test(l)), true);
  assert.equal(stageNotes({ ...state, validation: { ran: true, passed: false, cancelled: false, steps: [] } }, ['a.js']).severity, 'danger');
  assert.equal(stageNotes({ ...state, validation: { ran: false, passed: false, steps: [] } }, ['a.js']).severity, 'normal', 'no checks found is not a failure');
});
