import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createFakeVscode } from '../test-support/fakeVscode.js';
import { cleanup, git, makeMergeRepo } from '../test-support/gitRepo.js';
import { activateWith } from '../src/ui/vscode/activate.js';
import { buildTree } from '../src/ui/viewmodel/treeModel.js';

const active = [];
const finish = async (...dirs) => {
  for (const api of active.splice(0)) {
    api.gitState.dispose();
    await api.gitState.settled();
  }
  dirs.forEach(cleanup);
};

const put = (dir, file, text) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};

// A merge whose conflicts were fixed by hand (no markers left), with a package.json defining the checks.
const open = async ({ scripts = { test: 'node -e "process.exit(0)"' }, resolved = true, packageJson = true } = {}) => {
  const dir = makeMergeRepo();
  try { git(dir, 'merge', '--no-ff', '--no-commit', 'feature'); } catch { /* conflicts expected */ }
  if (resolved) {
    put(dir, 'c.txt', 'c=2\nc=3\n');
    put(dir, 'd.txt', 'd=2\nd=3\n');
  }
  if (packageJson) put(dir, 'package.json', JSON.stringify({ name: 'demo', scripts }));
  const fake = createFakeVscode({ folders: [dir] });
  const api = await activateWith(fake.vscode, fake.context(), { debounceMs: 20 });
  active.push(api);
  return { dir, fake, api, run: (id, ...args) => fake.commands.get(id)(...args) };
};
const validateStep = (api) => buildTree(api.session.state)[3];

test('the user sees the exact commands first, and what they approve is what runs', async () => {
  const { dir, fake, api, run } = await open({ scripts: { test: 'node -e "console.log(\'all good\')"', lint: 'node -e "process.exit(0)"' } });
  try {
    fake.script.warning.push('Run Checks');
    fake.script.information.push('Open Source Control');
    await run('mergeAssistant.runChecks');

    const modal = fake.callsOf('warning')[0];
    assert.equal(modal.message, 'Run 2 checks on the merged code?');
    assert.equal(modal.rest[0].modal, true);
    assert.match(modal.rest[0].detail, /1\. test: npm run test\n2\. lint: npm run lint/);
    assert.match(modal.rest[0].detail, /test, typecheck, lint and build scripts in package\.json/);
    assert.match(modal.rest[0].detail, /brought in code from another branch, which may have changed them/);
    assert.deepEqual(modal.rest.slice(1), ['Run Checks']);

    const steps = api.session.state.validation.steps;
    assert.deepEqual(steps.map((s) => `${s.name}:${s.command}:${s.status}`), ['test:npm run test:passed', 'lint:npm run lint:passed']);
    assert.match(fake.messages('information').at(-1), /^All 2 checks passed\./);
    assert.ok(fake.callsOf('executeCommand').some((c) => c.id === 'workbench.view.scm'));
    assert.equal(validateStep(api).description, 'passed');
    assert.equal(fake.contexts.get('mergeAssistant.busy'), false);
    assert.match(fake.outputs.get('Merge Assistant').lines.join('\n'), /all good/, 'the check output is in the log');
  } finally {
    await finish(dir);
  }
});

test('declining the list runs nothing', async () => {
  const marker = 'ran.txt';
  const { dir, fake, api, run } = await open({ scripts: { test: `node -e "require('fs').writeFileSync('${marker}', 'x')"` } });
  try {
    await run('mergeAssistant.runChecks'); // modal dismissed
    assert.equal(api.session.state.validation, null);
    assert.equal(fake.callsOf('progress').length, 0);
    assert.ok(!(await import('node:fs')).existsSync(path.join(dir, marker)), 'the command was never executed');
  } finally {
    await finish(dir);
  }
});

test('a failing check is named, its output is logged, and the tree shows where it stopped', async () => {
  const { dir, fake, api, run } = await open({ scripts: { test: 'node -e "console.error(\'boom: expected 1 got 2\'); process.exit(3)"', lint: 'node -e "process.exit(0)"' } });
  try {
    fake.script.warning.push('Run Checks', 'Show Log');
    await run('mergeAssistant.runChecks');

    const failure = fake.callsOf('warning')[1];
    assert.match(failure.message, /^Check "test" failed \(exit 3\)\. The merged code is not ready to commit/);
    assert.deepEqual(failure.rest, ['Show Log']);
    assert.equal(fake.callsOf('output.show').length, 1);
    assert.match(fake.outputs.get('Merge Assistant').lines.join('\n'), /boom: expected 1 got 2/);

    const step = validateStep(api);
    assert.equal(step.description, 'failed');
    assert.deepEqual(step.children.map((c) => `${c.label}:${c.description}`), ['test:failed (exit 3)', 'lint:skipped']);
    assert.equal(step.children[0].command.id, 'mergeAssistant.showOutput');
  } finally {
    await finish(dir);
  }
});

test('conflict markers still in the files stop the run before anything executes', async () => {
  const { dir, fake, run } = await open({ resolved: false });
  try {
    await run('mergeAssistant.runChecks');
    assert.match(fake.messages('warning')[0], /2 files still have conflict markers \(c\.txt, d\.txt\)\. Resolve or fix them first/);
    assert.equal(fake.callsOf('progress').length, 0);
  } finally {
    await finish(dir);
  }
});

test('a repository with no checks says how to add some', async () => {
  const { dir, fake, run } = await open({ packageJson: false });
  try {
    await run('mergeAssistant.runChecks');
    assert.match(fake.messages('information')[0], /No checks were found\. Add a "test"/);
    assert.equal(fake.callsOf('warning').length, 0, 'no confirmation for an empty list');
  } finally {
    await finish(dir);
  }
});

test('with no merge in progress there is nothing to check', async () => {
  const { dir, fake, run } = await open();
  try {
    git(dir, 'merge', '--abort');
    await fake.commands.get('mergeAssistant.refresh')();
    await run('mergeAssistant.runChecks');
    assert.match(fake.messages('information')[0], /no merge in progress/);
  } finally {
    await finish(dir);
  }
});

test('cancelling kills the running check and reports it without calling it a failure', { timeout: 60000 }, async () => {
  const { dir, fake, api, run } = await open({ scripts: { test: 'node -e "setTimeout(() => {}, 30000)"' } });
  try {
    fake.script.warning.push('Run Checks');
    const running = run('mergeAssistant.runChecks');
    while (fake.callsOf('progress').length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    fake.progressTokens[0].cancel();
    await running;

    assert.ok(Date.now() - started < 15000, 'the 30 second command was stopped');
    assert.equal(fake.messages('warning').at(-1), 'Checks cancelled. Nothing was changed.');
    assert.equal(validateStep(api).description, 'cancelled');
    assert.equal(fake.contexts.get('mergeAssistant.busy'), false);
  } finally {
    await finish(dir);
  }
});

test('tests affected by the resolution run first, and are shown in the list', async () => {
  const { dir, fake, api, run } = await open({ scripts: { test: 'node --test' } });
  try {
    put(dir, 'test/a.test.js', "import { test } from 'node:test'; test('ok', () => {});\n");
    api.session.recordResults([{ file: 'c.txt', status: 'resolved', impact: { importers: [], testFiles: ['test/a.test.js', 'test/gone.test.js'], changes: [] } }]);

    fake.script.warning.push('Run Checks');
    await run('mergeAssistant.runChecks');

    const detail = fake.callsOf('warning')[0].rest[0].detail;
    assert.match(detail, /1\. focused tests: node --test "test\/a\.test\.js"\n2\. test: npm run test/);
    assert.ok(!detail.includes('gone.test.js'), 'a test file that does not exist is not listed');
    assert.deepEqual(api.session.state.validation.steps.map((s) => s.name), ['focused tests', 'test']);
  } finally {
    await finish(dir);
  }
});

test('a .merge-agent.json list replaces the guessed checks and the modal says where they came from', async () => {
  const { dir, fake, api, run } = await open();
  try {
    put(dir, '.merge-agent.json', JSON.stringify({ validate: [{ name: 'smoke', command: 'node -e "process.exit(0)"' }] }));
    fake.script.warning.push('Run Checks');
    await run('mergeAssistant.runChecks');
    const detail = fake.callsOf('warning')[0].rest[0].detail;
    assert.match(detail, /1\. smoke: node -e "process\.exit\(0\)"/);
    assert.match(detail, /the "validate" list in \.merge-agent\.json/);
    assert.equal(api.session.state.validation.source, '.merge-agent.json');
  } finally {
    await finish(dir);
  }
});

test('a check cannot start while another task is running', { timeout: 60000 }, async () => {
  const { dir, fake, api, run } = await open();
  try {
    let release;
    const first = api.runner.run('resolve', () => new Promise((resolve) => { release = resolve; }), { title: 'x' });
    await new Promise((resolve) => setImmediate(resolve));
    fake.script.warning.push('Run Checks');
    await run('mergeAssistant.runChecks');
    assert.match(fake.messages('warning').at(-1), /already resolving conflicts/);
    release();
    await first;
  } finally {
    await finish(dir);
  }
});
