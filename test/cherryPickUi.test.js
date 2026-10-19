import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createFakeVscode } from '../test-support/fakeVscode.js';
import { cleanup, git, makePickRepo } from '../test-support/gitRepo.js';
import { activateWith } from '../src/ui/vscode/activate.js';
import { createAbortError } from '../src/util/abort.js';

const makeRepo = makePickRepo;

const active = [];
const finish = async (...dirs) => {
  for (const api of active.splice(0)) {
    api.gitState.dispose();
    await api.gitState.settled();
  }
  dirs.forEach(cleanup);
};
const open = async (options = {}) => {
  const dir = makeRepo();
  const fake = createFakeVscode({ folders: [dir] });
  const api = await activateWith(fake.vscode, fake.context(), { debounceMs: 20, ...options });
  active.push(api);
  return { dir, fake, api, run: (id, ...args) => fake.commands.get(id)(...args) };
};
const report = (fake) => fake.outputs.get('Merge Assistant Report');

test('a real check finds the hidden prerequisite and leaves the repository untouched unless you apply', { timeout: 300000 }, async () => {
  const { dir, fake, run } = await open();
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    const wanted = git(dir, 'log', 'feature', '--format=%H %s').split('\n').find((l) => l.includes('cart total')).split(' ')[0];

    fake.script.quickPick.push({ label: 'feature' }, { label: 'x', sha: wanted });
    fake.script.information.push('Copy Cherry-pick Command');
    await run('mergeAssistant.checkCherryPick');

    const branches = fake.callsOf('quickPick')[0];
    assert.deepEqual(branches.items.map((i) => i.label), ['feature']);
    const commits = fake.callsOf('quickPick')[1];
    assert.deepEqual(commits.items.map((i) => i.label.replace(/^[0-9a-f]+\s+/, '')), ['Show the cart total on the main page', 'Add computeTotal helper', 'Add a footer']);

    const toast = fake.callsOf('information')[0];
    assert.match(toast.message, /^Cherry-pick check: CONDITIONAL \(local analysis only\)\. Apply these first/);
    assert.match(toast.message, /Your files were not touched\.$/);
    assert.deepEqual(toast.rest, ['Show Report', 'Apply Cherry-pick', 'Copy Cherry-pick Command']);

    const lines = report(fake).lines.join('\n');
    assert.match(lines, /Outcome: CONDITIONAL \(local analysis only\)/);
    assert.match(lines, /confirmed [0-9a-f]{7} Add computeTotal helper/);
    assert.match(lines, /Trial cherry-pick: applied cleanly/);

    assert.equal(fake.vscode.env.clipboard.text, `git cherry-pick ${wanted}`, 'only the command is offered, never run');
    assert.match(fake.messages('information').at(-1), /Run it yourself if you prefer/);

    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
    assert.equal(git(dir, 'status', '--porcelain'), '');
    assert.equal(existsSync(path.join(dir, '.git', 'CHERRY_PICK_HEAD')), false);
    assert.equal(git(dir, 'worktree', 'list').split('\n').length, 1, 'the temporary worktree is gone');
    assert.equal(existsSync(path.join(dir, 'helper.js')), false);
  } finally {
    await finish(dir);
  }
});

test('"Show Report" opens the report, and a blocked outcome offers no way to copy the command', async () => {
  const preflight = async () => ({
    outcome: 'blocked',
    findings: [{ level: 'blocked', text: 'This is a merge commit.' }],
    lines: [{ tone: 'heading', text: 'Cherry-pick abc1234 "x" onto HEAD' }, { tone: 'bad', text: 'Outcome: BLOCKED (local analysis only)' }],
  });
  const { dir, fake, run } = await open({ preflight });
  try {
    fake.script.quickPick.push({ label: 'feature' }, { sha: 'a'.repeat(40) });
    fake.script.information.push('Show Report');
    await run('mergeAssistant.checkCherryPick');

    const toast = fake.callsOf('information')[0];
    assert.deepEqual(toast.rest, ['Show Report'], 'no copy button when blocked');
    assert.match(toast.message, /BLOCKED \(local analysis only\)\. This is a merge commit\./);
    assert.deepEqual(report(fake).lines, ['Cherry-pick abc1234 "x" onto HEAD', 'Outcome: BLOCKED (local analysis only)']);
    assert.equal(fake.callsOf('output.show').filter((c) => c.name === 'Merge Assistant Report').length, 1);
    assert.equal(fake.vscode.env.clipboard.text, '');
  } finally {
    await finish(dir);
  }
});

test('the toast never claims a plain "safe": the local-only label is always there', async () => {
  const preflight = async () => ({ outcome: 'safe', findings: [{ level: 'safe', text: 'No missing dependencies or conflicts were found.' }], lines: [] });
  const { dir, fake, run } = await open({ preflight });
  try {
    fake.script.quickPick.push({ label: 'feature' }, { sha: 'b'.repeat(40) });
    await run('mergeAssistant.checkCherryPick');
    assert.match(fake.messages('information')[0], /^Cherry-pick check: SAFE \(local analysis only\)\./);
  } finally {
    await finish(dir);
  }
});

test('cancelling stops the check cleanly', { timeout: 60000 }, async () => {
  let observed;
  const preflight = ({ signal }) => new Promise((resolve, reject) => {
    observed = signal;
    signal.addEventListener('abort', () => reject(createAbortError()));
  });
  const { dir, fake, run } = await open({ preflight });
  try {
    fake.script.quickPick.push({ label: 'feature' }, { sha: 'c'.repeat(40) });
    const running = run('mergeAssistant.checkCherryPick');
    while (fake.callsOf('progress').length === 0) await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(fake.contexts.get('mergeAssistant.busy'), true);
    fake.progressTokens[0].cancel();
    await running;

    assert.equal(observed.aborted, true);
    assert.equal(fake.messages('information').at(-1), 'Cherry-pick check cancelled. Nothing was changed.');
    assert.equal(fake.contexts.get('mergeAssistant.busy'), false);
    assert.equal(fake.callsOf('error').length, 0, 'a cancellation is not an error');
  } finally {
    await finish(dir);
  }
});

test('nothing to pick, or backing out of a picker, ends quietly', async () => {
  const { dir, fake, run } = await open({ preflight: async () => assert.fail('must not run') });
  try {
    await run('mergeAssistant.checkCherryPick'); // branch picker dismissed
    fake.script.quickPick.push({ label: 'feature' });
    await run('mergeAssistant.checkCherryPick'); // commit picker dismissed
    assert.equal(fake.callsOf('progress').length, 0);

    git(dir, 'merge', '--no-ff', '--no-edit', 'feature');
    fake.script.quickPick.push({ label: 'feature' });
    await run('mergeAssistant.checkCherryPick');
    assert.match(fake.messages('information').at(-1), /feature has no commits that this branch lacks/);
  } finally {
    await finish(dir);
  }
});

test('a second check cannot start while something else is running', async () => {
  const { dir, fake, api, run } = await open({ preflight: async () => assert.fail('must not run') });
  try {
    let release;
    const first = api.runner.run('resolve', () => new Promise((resolve) => { release = resolve; }), { title: 'x' });
    await new Promise((resolve) => setImmediate(resolve));
    fake.script.quickPick.push({ label: 'feature' }, { sha: 'd'.repeat(40) });
    await run('mergeAssistant.checkCherryPick');
    assert.match(fake.messages('warning').at(-1), /already resolving conflicts/);
    release();
    await first;
  } finally {
    await finish(dir);
  }
});

test('with no repository open it says so', async () => {
  const fake = createFakeVscode({ folders: [] });
  await activateWith(fake.vscode, fake.context(), { debounceMs: 20 });
  await fake.commands.get('mergeAssistant.checkCherryPick')();
  assert.match(fake.messages('information')[0], /Open a folder that contains a Git repository/);
});

const sha = (dir, subject) => git(dir, 'log', 'feature', '--format=%H %s').split('\n').find((l) => l.includes(subject)).split(' ')[0];
const stubCheck = (outcome) => async () => ({ outcome, findings: [{ level: outcome, text: 'Stub.' }], lines: [{ tone: 'dim', text: 'stub' }] });

test('a safe check can be applied after a confirmation that says a commit is created', { timeout: 300000 }, async () => {
  const { dir, fake, run } = await open({ preflight: stubCheck('safe') });
  try {
    const wanted = sha(dir, 'Add a footer');
    fake.script.quickPick.push({ label: 'feature' }, { sha: wanted });
    fake.script.information.push('Apply Cherry-pick');
    fake.script.warning.push('Apply Cherry-pick');
    const before = git(dir, 'rev-list', '--count', 'HEAD');
    await run('mergeAssistant.checkCherryPick');

    const confirm = fake.callsOf('warning')[0];
    assert.match(confirm.message, /^Cherry-pick [0-9a-f]{7} onto "main"\?/);
    assert.match(confirm.rest[0].detail ?? '', /Git creates a new commit right away/);
    assert.equal(fake.callsOf('inputBox').length, 0, 'a safe check needs no typed word');
    assert.equal(Number(git(dir, 'rev-list', '--count', 'HEAD')), Number(before) + 1);
    assert.equal(existsSync(path.join(dir, 'footer.js')), true);
    assert.match(fake.messages('information').at(-1), /Git created the commit/);
  } finally {
    await finish(dir);
  }
});

test('declining the confirmation, or a wrong typed word, changes nothing', { timeout: 300000 }, async () => {
  const { dir, fake, run } = await open({ preflight: stubCheck('risky') });
  try {
    const wanted = sha(dir, 'Add a footer');
    const head = git(dir, 'rev-parse', 'HEAD');
    fake.script.quickPick.push({ label: 'feature' }, { sha: wanted }, { label: 'feature' }, { sha: wanted });
    fake.script.information.push('Apply Cherry-pick', 'Apply Cherry-pick');
    fake.script.warning.push(undefined);
    await run('mergeAssistant.checkCherryPick'); // confirmation dismissed
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);

    fake.script.warning.push('Apply Cherry-pick');
    fake.script.inputBox.push('yes please');
    await run('mergeAssistant.checkCherryPick'); // risky needs the word "apply"
    assert.equal(fake.callsOf('inputBox').length, 1);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
    assert.equal(existsSync(path.join(dir, 'footer.js')), false);
  } finally {
    await finish(dir);
  }
});

test('a blocked check cannot be applied, and uncommitted changes stop an apply', { timeout: 300000 }, async () => {
  const blocked = await open({ preflight: stubCheck('blocked') });
  try {
    blocked.fake.script.quickPick.push({ label: 'feature' }, { sha: sha(blocked.dir, 'Add a footer') });
    await blocked.run('mergeAssistant.checkCherryPick');
    assert.ok(!blocked.fake.callsOf('information')[0].rest.includes('Apply Cherry-pick'));
  } finally {
    await finish(blocked.dir);
  }

  const { dir, fake, run } = await open({ preflight: stubCheck('safe') });
  try {
    writeFileSync(path.join(dir, 'main.js'), 'changed\n');
    fake.script.quickPick.push({ label: 'feature' }, { sha: sha(dir, 'Add a footer') });
    fake.script.information.push('Apply Cherry-pick');
    await run('mergeAssistant.checkCherryPick');
    assert.match(fake.messages('warning')[0], /uncommitted changes/);
    assert.equal(existsSync(path.join(dir, 'footer.js')), false);
  } finally {
    await finish(dir);
  }
});

test('a pick that conflicts continues into the normal steps, and Abort undoes it', { timeout: 300000 }, async () => {
  const { dir, fake, api, run } = await open({ preflight: stubCheck('conditional') });
  try {
    writeFileSync(path.join(dir, 'main.js'), 'export const title = "main side";\n');
    git(dir, 'commit', '-qam', 'Change the title on main');
    const head = git(dir, 'rev-parse', 'HEAD');
    await run('mergeAssistant.refresh');

    fake.script.quickPick.push({ label: 'feature' }, { sha: sha(dir, 'Show the cart total') });
    fake.script.information.push('Apply Cherry-pick');
    fake.script.warning.push('Apply Cherry-pick');
    fake.script.inputBox.push('apply');
    await run('mergeAssistant.checkCherryPick');

    assert.match(fake.messages('information').at(-1), /The cherry-pick stopped: 1 file with conflicts/);
    assert.equal(fake.contexts.get('mergeAssistant.mergeInProgress'), true);
    assert.equal(api.session.state.operation, 'cherry-pick');
    assert.deepEqual(api.session.state.files.map((f) => f.path), ['main.js']);
    assert.equal(api.session.state.files[0].hunks.length, 1);

    fake.script.warning.push('Abort Merge');
    await run('mergeAssistant.abortMerge');
    assert.match(fake.callsOf('warning').at(-1).message, /^Abort the cherry-pick\?/);
    assert.match(fake.messages('information').at(-1), /Cherry-pick aborted/);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
    assert.equal(existsSync(path.join(dir, '.git', 'CHERRY_PICK_HEAD')), false);
  } finally {
    await finish(dir);
  }
});
