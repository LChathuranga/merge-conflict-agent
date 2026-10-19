import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakeVscode } from '../test-support/fakeVscode.js';
import { cleanup, git, makeMergeRepo, mergeHeadExists } from '../test-support/gitRepo.js';
import { activateWith } from '../src/ui/vscode/activate.js';
import { buildTree } from '../src/ui/viewmodel/treeModel.js';

// A refresh still running when the repository is deleted would hold it open on Windows.
const active = [];
const finish = async (...dirs) => {
  for (const api of active.splice(0)) {
    api.gitState.dispose();
    await api.gitState.settled();
  }
  dirs.forEach(cleanup);
};

const start = async (dir, options = {}) => {
  const fake = createFakeVscode({ folders: [dir], ...options });
  const context = fake.context();
  const api = await activateWith(fake.vscode, context, { debounceMs: 20 });
  active.push(api);
  return { fake, context, api, run: (id, ...args) => fake.commands.get(id)(...args) };
};
const stepLabels = (api) => buildTree(api.session.state).map((n) => n.label);

test('opening a repository with no merge shows the welcome content and the contexts that drive it', async () => {
  const dir = makeMergeRepo();
  try {
    const { fake, api } = await start(dir);
    assert.equal(fake.treeViews[0].id, 'mergeAssistant.steps');
    assert.equal(fake.contexts.get('mergeAssistant.hasRepo'), true);
    assert.equal(fake.contexts.get('mergeAssistant.mergeInProgress'), false);
    assert.equal(fake.contexts.get('mergeAssistant.otherOperation'), false);
    assert.deepEqual(stepLabels(api), [], 'an empty tree lets the welcome text show');
  } finally {
    await finish(dir);
  }
});

test('a folder that is not a Git repository says so instead of failing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mca-nogit-'));
  try {
    const { fake, run } = await start(dir);
    assert.equal(fake.contexts.get('mergeAssistant.hasRepo'), false);
    await run('mergeAssistant.mergeBranch');
    assert.match(fake.messages('information')[0], /Open a folder that contains a Git repository/);
  } finally {
    await finish(dir);
  }
});

test('Merge a Branch: pick, confirm, merge, and the conflicts appear as steps with no commit made', async () => {
  const dir = makeMergeRepo();
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    const { fake, api, run } = await start(dir);

    fake.script.quickPick.push({ label: 'feature' });
    fake.script.information.push('Merge');
    await run('mergeAssistant.mergeBranch');

    const picker = fake.callsOf('quickPick')[0];
    assert.deepEqual(picker.items.map((i) => `${i.label}: ${i.description}`), ['clean-branch: 1 commit to merge', 'feature: 1 commit to merge']);
    const confirm = fake.callsOf('information')[0];
    assert.equal(confirm.message, 'Merge "feature" into "main"?');
    assert.match(confirm.rest[0].detail, /No commit is created/);

    assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'no commit');
    assert.equal(mergeHeadExists(dir), true);
    assert.match(fake.messages('information').at(-1), /Merge started: 2 files with conflicts/);
    assert.equal(fake.contexts.get('mergeAssistant.mergeInProgress'), true);
    assert.equal(fake.contexts.get('mergeAssistant.hasConflicts'), true);
    assert.equal(fake.contexts.get('mergeAssistant.busy'), false, 'busy is cleared afterwards');
    assert.ok(fake.callsOf('executeCommand').some((c) => c.id === 'mergeAssistant.steps.focus'), 'the view is brought forward');

    assert.deepEqual(stepLabels(api), ['1. Merge', '2. Conflicts', '3. Review', '4. Validate']);
    const files = buildTree(api.session.state)[1].children;
    assert.deepEqual(files.map((f) => f.id), ['file:c.txt', 'file:d.txt']);
    assert.equal(api.session.state.theirs.label, 'feature');
  } finally {
    await finish(dir);
  }
});

test('backing out at the picker or the confirmation changes nothing', async () => {
  const dir = makeMergeRepo();
  try {
    const { fake, run } = await start(dir);
    await run('mergeAssistant.mergeBranch'); // picker dismissed
    assert.equal(mergeHeadExists(dir), false);

    fake.script.quickPick.push({ label: 'feature' });
    await run('mergeAssistant.mergeBranch'); // confirmation dismissed
    assert.equal(mergeHeadExists(dir), false);
    assert.equal(fake.callsOf('progress').length, 0, 'git was never run');
  } finally {
    await finish(dir);
  }
});

test('unsaved editors must be saved first, and declining stops the merge', async () => {
  const dir = makeMergeRepo();
  try {
    const { fake, run } = await start(dir);
    let saved = 0;
    fake.vscode.workspace.textDocuments.push(
      { isDirty: true, uri: { scheme: 'file', fsPath: path.join(dir, 'c.txt') }, save: async () => { saved += 1; return true; } },
      { isDirty: true, uri: { scheme: 'file', fsPath: path.join(tmpdir(), 'elsewhere.txt') }, save: async () => { throw new Error('outside the repo'); } },
      { isDirty: false, uri: { scheme: 'file', fsPath: path.join(dir, 'd.txt') }, save: async () => { throw new Error('clean file'); } }
    );

    fake.script.quickPick.push({ label: 'feature' });
    fake.script.information.push('Merge');
    await run('mergeAssistant.mergeBranch'); // warning dismissed
    const warning = fake.callsOf('warning')[0];
    assert.match(warning.message, /1 file has unsaved changes \(c\.txt\)/);
    assert.equal(warning.rest[0].modal, true);
    assert.equal(mergeHeadExists(dir), false);
    assert.equal(saved, 0);

    fake.script.quickPick.push({ label: 'feature' });
    fake.script.information.push('Merge');
    fake.script.warning.push('Save All and Continue');
    await run('mergeAssistant.mergeBranch');
    assert.equal(saved, 1);
    assert.equal(mergeHeadExists(dir), true);
  } finally {
    await finish(dir);
  }
});

test('a merge without conflicts waits for the user and offers Source Control', async () => {
  const dir = makeMergeRepo();
  try {
    const { fake, api, run } = await start(dir);
    fake.script.quickPick.push({ label: 'clean-branch' });
    fake.script.information.push('Merge', 'Open Source Control');
    await run('mergeAssistant.mergeBranch');

    assert.match(fake.messages('information').at(-1), /Merged without conflicts\. Nothing was committed/);
    assert.ok(fake.callsOf('executeCommand').some((c) => c.id === 'workbench.view.scm'));
    assert.equal(mergeHeadExists(dir), true);
    const tree = buildTree(api.session.state);
    assert.equal(tree[0].children[0].label, 'Merged without conflicts');
    assert.ok(tree.some((n) => n.id === 'step:next'));
  } finally {
    await finish(dir);
  }
});

test('Abort Merge needs a confirmation and puts everything back', async () => {
  const dir = makeMergeRepo();
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    const { fake, api, run } = await start(dir);
    fake.script.quickPick.push({ label: 'feature' });
    fake.script.information.push('Merge');
    await run('mergeAssistant.mergeBranch');

    await run('mergeAssistant.abortMerge'); // confirmation dismissed
    assert.equal(mergeHeadExists(dir), true, 'still merging');

    fake.script.warning.push('Abort Merge');
    await run('mergeAssistant.abortMerge');
    const confirm = fake.callsOf('warning').at(-1);
    assert.equal(confirm.rest[0].modal, true);
    assert.match(confirm.rest[0].detail, /discards the merge and every conflict resolution/);

    assert.equal(mergeHeadExists(dir), false);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
    assert.equal(git(dir, 'status', '--porcelain'), '');
    assert.equal(fake.contexts.get('mergeAssistant.mergeInProgress'), false);
    assert.deepEqual(stepLabels(api), []);
    assert.match(fake.messages('information').at(-1), /Merge aborted/);
  } finally {
    await finish(dir);
  }
});

test('a merge or another operation already in progress blocks starting a new merge', async () => {
  const dir = makeMergeRepo();
  try {
    try { git(dir, 'merge', '--no-ff', '--no-commit', 'feature'); } catch { /* the conflict is expected */ }
    const { fake, run } = await start(dir);

    await run('mergeAssistant.mergeBranch');
    assert.match(fake.messages('warning')[0], /A merge is already in progress/);
    assert.equal(fake.callsOf('quickPick').length, 0, 'no branch is offered');

    git(dir, 'merge', '--abort');
    // A cherry-pick is something this tool walks through, so it is "in progress" too.
    try { git(dir, 'cherry-pick', 'feature'); } catch { /* the conflict is expected */ }
    await run('mergeAssistant.refresh');
    assert.equal(fake.contexts.get('mergeAssistant.mergeInProgress'), true);
    await run('mergeAssistant.mergeBranch');
    assert.match(fake.messages('warning')[1], /A cherry-pick is already in progress/);
    git(dir, 'cherry-pick', '--abort');

    // A revert is not ours: it is explained, not offered.
    writeFileSync(path.join(dir, '.git', 'REVERT_HEAD'), `${git(dir, 'rev-parse', 'HEAD')}\n`);
    await run('mergeAssistant.refresh');
    assert.equal(fake.contexts.get('mergeAssistant.otherOperation'), true, 'the welcome text explains why nothing is offered');
    assert.equal(fake.contexts.get('mergeAssistant.mergeInProgress'), false);
    await run('mergeAssistant.mergeBranch');
    assert.match(fake.messages('warning')[2], /A revert is already in progress/);
  } finally {
    await finish(dir);
  }
});

test('a merge already in progress when the window opens is picked up from git alone', async () => {
  const dir = makeMergeRepo();
  try {
    try { git(dir, 'merge', '--no-ff', '--no-commit', 'feature'); } catch { /* conflict expected */ }
    const { fake, api } = await start(dir);
    assert.equal(fake.contexts.get('mergeAssistant.mergeInProgress'), true);
    assert.deepEqual(stepLabels(api), ['1. Merge', '2. Conflicts', '3. Review', '4. Validate']);
    assert.deepEqual(buildTree(api.session.state)[1].children.map((f) => f.label), ['c.txt', 'd.txt']);
  } finally {
    await finish(dir);
  }
});

test('changes made outside the extension update the view (focus, and the Git extension events)', async () => {
  const dir = makeMergeRepo();
  try {
    try { git(dir, 'merge', '--no-ff', '--no-commit', 'feature'); } catch { /* conflict expected */ }

    const stateListeners = [];
    const fakeGit = {
      isActive: true,
      exports: {
        getAPI: () => ({
          repositories: [{ state: { onDidChange: (l) => { stateListeners.push(l); return { dispose() {} }; } } }],
          onDidOpenRepository: () => ({ dispose() {} }),
        }),
      },
    };
    const fake = createFakeVscode({ folders: [dir] });
    fake.state.gitExtension = fakeGit;
    const api = await activateWith(fake.vscode, fake.context(), { debounceMs: 10 });
    active.push(api);
    assert.equal(fake.contexts.get('mergeAssistant.mergeInProgress'), true);
    assert.equal(stateListeners.length, 1, 'follows the built-in Git extension');

    git(dir, 'merge', '--abort');
    stateListeners.forEach((l) => l());
    await api.gitState.settled();
    assert.equal(fake.contexts.get('mergeAssistant.mergeInProgress'), false);
    assert.deepEqual(stepLabels(api), []);
  } finally {
    await finish(dir);
  }
});

test('a missing Git extension is tolerated, and window focus still refreshes', async () => {
  const dir = makeMergeRepo();
  try {
    const { fake, api } = await start(dir); // no Git extension in the fake
    try { git(dir, 'merge', '--no-ff', '--no-commit', 'feature'); } catch { /* conflict expected */ }
    fake.focusWindow();
    await api.gitState.settled();
    assert.equal(fake.contexts.get('mergeAssistant.mergeInProgress'), true);
    assert.equal(stepLabels(api).length, 4);
  } finally {
    await finish(dir);
  }
});

test('refreshes that arrive in a burst are coalesced into serial runs', async () => {
  const dir = makeMergeRepo();
  try {
    const { api } = await start(dir);
    let syncs = 0;
    const original = api.session.syncGit;
    api.session.syncGit = (...args) => { syncs += 1; return original(...args); };
    await Promise.all(Array.from({ length: 10 }, () => api.gitState.refresh()));
    assert.ok(syncs >= 1 && syncs <= 2, `expected 1-2 refreshes for a burst of 10, got ${syncs}`);
  } finally {
    await finish(dir);
  }
});

test('openConflict opens the file at the line, and refuses anything outside the repository', async () => {
  const dir = makeMergeRepo();
  try {
    const { fake, run } = await start(dir);
    await run('mergeAssistant.openConflict', 'c.txt', 7);
    const open = fake.callsOf('executeCommand').find((c) => c.id === 'vscode.open');
    assert.equal(open.args[0].fsPath, path.join(dir, 'c.txt'));
    assert.equal(open.args[1].selection.start.line, 6, 'lines are 1-based for people, 0-based for the editor');

    const before = fake.callsOf('executeCommand').filter((c) => c.id === 'vscode.open').length;
    for (const bad of ['../outside.txt', path.join(tmpdir(), 'x.txt'), '.', '', undefined, 42]) await run('mergeAssistant.openConflict', bad, 1);
    assert.equal(fake.callsOf('executeCommand').filter((c) => c.id === 'vscode.open').length, before);
  } finally {
    await finish(dir);
  }
});

test('only one task runs at a time, cancelling aborts its signal, and busy is always cleared', async () => {
  const dir = makeMergeRepo();
  try {
    const { fake, api } = await start(dir);
    let release;
    let aborted = false;
    const first = api.runner.run('validate', ({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { aborted = true; resolve('cancelled'); });
      release = () => resolve('done');
    }), { title: 'Checking' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(fake.contexts.get('mergeAssistant.busy'), true);
    assert.equal(api.runner.kind, 'validate');
    assert.equal(api.session.state.run.kind, 'validate');

    const second = await api.runner.run('resolve', async () => assert.fail('must not start'), { title: 'x' });
    assert.equal(second, undefined);
    assert.match(fake.messages('warning').at(-1), /already running checks/);

    await fake.commands.get('mergeAssistant.cancel')();
    assert.equal(aborted, true);
    assert.equal(await first, 'cancelled');
    assert.equal(fake.contexts.get('mergeAssistant.busy'), false);
    assert.equal(api.session.state.run.kind, null);
    assert.equal(api.runner.busy, false);

    await fake.commands.get('mergeAssistant.cancel')();
    assert.equal(fake.messages('information').at(-1), 'Nothing is running.');
    assert.ok(release);
  } finally {
    await finish(dir);
  }
});

test('a task that throws still clears busy and the run state', async () => {
  const dir = makeMergeRepo();
  try {
    const { fake, api } = await start(dir);
    await assert.rejects(api.runner.run('resolve', async () => { throw new Error('boom'); }, { title: 'x' }), /boom/);
    assert.equal(fake.contexts.get('mergeAssistant.busy'), false);
    assert.equal(api.session.state.run.kind, null);
  } finally {
    await finish(dir);
  }
});

test('several repositories: the user picks once and the choice is remembered', async () => {
  const one = makeMergeRepo();
  const two = makeMergeRepo();
  try {
    const fake = createFakeVscode({ folders: [one, two] });
    const context = fake.context();
    fake.script.quickPick.push({ repo: { root: two, name: path.basename(two) } });
    const api = await activateWith(fake.vscode, context, { debounceMs: 10 });
    active.push(api);
    assert.equal(fake.callsOf('quickPick').length, 1);
    assert.equal(api.getRepo().root, two);
    assert.equal(context.workspaceState.get('mergeAssistant.repo'), two);

    const again = await activateWith(fake.vscode, context, { debounceMs: 10 });
    active.push(again);
    assert.equal(fake.callsOf('quickPick').length, 1, 'no second prompt');
    assert.equal(path.resolve(again.getRepo().root), path.resolve(two));
  } finally {
    await finish(one, two);
  }
});

test('an unreadable or deleted conflicted file is listed for manual work, not a crash', async () => {
  const dir = makeMergeRepo();
  try {
    git(dir, 'checkout', '-q', '-b', 'deleter', 'feature');
    git(dir, 'rm', '-q', 'e.txt');
    git(dir, 'commit', '-qm', 'delete e');
    git(dir, 'checkout', '-q', 'main');
    writeFileSync(path.join(dir, 'e.txt'), 'main also adds e\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'main adds e');
    try { git(dir, 'merge', '--no-ff', '--no-commit', 'feature'); } catch { /* conflicts expected */ }

    const { api } = await start(dir);
    const states = Object.fromEntries(api.session.state.files.map((f) => [f.path, f.hunks.length]));
    assert.ok(existsSync(path.join(dir, 'e.txt')));
    assert.ok(Object.keys(states).length >= 2, `conflicted files: ${JSON.stringify(states)}`);
  } finally {
    await finish(dir);
  }
});
