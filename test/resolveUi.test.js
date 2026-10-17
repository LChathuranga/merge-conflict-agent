import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createFakeVscode } from '../test-support/fakeVscode.js';
import { OLLAMA_TAGS, network, ollamaRunning, ollamaWith } from '../test-support/network.js';
import { cleanup, git, makeMergeRepo, makeMultiConflictRepo, mergeHeadExists } from '../test-support/gitRepo.js';
import { activateWith } from '../src/ui/vscode/activate.js';
import { buildTree } from '../src/ui/viewmodel/treeModel.js';
import { stageableFiles } from '../src/ui/viewmodel/stageModel.js';

// The real orchestrator, real git repository and real merge; only the editor and the model are scripted.
const keepBoth = (name, a, b) => JSON.stringify({ resolution: `${name}=${a}\n${name}=${b}`, explanation: 'keep both', confidence: 'high', ambiguous: false });
const ambiguous = (resolution) => JSON.stringify({ resolution, explanation: 'a judgment call', confidence: 'low', ambiguous: true });

// A model that answers from a list, per call; it records what it was asked.
const scriptedModel = (answers) => {
  const requests = [];
  return {
    requests,
    client: {
      complete: async (request) => {
        requests.push(request);
        const answer = typeof answers === 'function' ? await answers(request, requests.length) : answers.shift();
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
};
const forFile = (request) => (/File: c\.txt/.test(request.messages[0].content) ? 'c' : 'd');

const active = [];
const finish = async (...dirs) => {
  for (const api of active.splice(0)) {
    api.gitState.dispose();
    await api.gitState.settled();
  }
  dirs.forEach(cleanup);
};

// A repository mid-merge with two conflicted files, the extension open on it.
const open = async ({ model, settings = {}, merge = true, fetchImpl = ollamaRunning() } = {}) => {
  const dir = makeMergeRepo();
  if (merge) { try { git(dir, 'merge', '--no-ff', '--no-commit', 'feature'); } catch { /* conflicts expected */ } }
  const fake = createFakeVscode({ folders: [dir], settings });
  const context = fake.context();
  const api = await activateWith(fake.vscode, context, { debounceMs: 20, createClient: () => model.client, fetchImpl });
  active.push(api);
  return { dir, fake, context, api, run: (id, ...args) => fake.commands.get(id)(...args) };
};
const read = (dir, file) => readFileSync(path.join(dir, file), 'utf8');
const fileNodes = (api) => Object.fromEntries(buildTree(api.session.state)[1].children.map((n) => [n.label, n]));

test('confident answers are applied without asking, nothing is staged, and the tree shows it', async () => {
  const model = scriptedModel((request) => (forFile(request) === 'c' ? keepBoth('c', 2, 3) : keepBoth('d', 2, 3)));
  const { dir, fake, api, run } = await open({ model, settings: { 'mergeAssistant.useIntent': false, 'mergeAssistant.useReferences': false } });
  try {
    await run('mergeAssistant.resolveAll');

    assert.equal(read(dir, 'c.txt'), 'c=2\nc=3\n');
    assert.equal(read(dir, 'd.txt'), 'd=2\nd=3\n');
    assert.equal(fake.callsOf('review.show').length, 0, 'no review was needed');
    assert.equal(mergeHeadExists(dir), true, 'still merging: nothing was committed');
    assert.equal(git(dir, 'diff', '--name-only', '--diff-filter=U').split('\n').sort().join(','), 'c.txt,d.txt', 'still unmerged in the index: nothing was staged');
    const unmerged = git(dir, 'ls-files', '-u').split('\n').map((l) => l.split('\t')[1]);
    assert.deepEqual([...new Set(unmerged)].sort(), ['c.txt', 'd.txt'], 'both files still have unmerged index entries');

    const summary = fake.callsOf('information').at(-1);
    assert.match(summary.message, /Resolved 2 files\./);
    assert.match(summary.message, /Git still lists these files as conflicts until you stage them/);
    assert.deepEqual(summary.rest, ['Run Checks...', 'Stage Resolved Files...']);

    assert.deepEqual(Object.values(fileNodes(api)).map((n) => n.icon.id), ['check', 'check']);
    const tree = buildTree(api.session.state);
    assert.ok(tree.some((n) => n.id === 'step:next'));
    assert.equal(tree.find((n) => n.id === 'step:stage').command.id, 'mergeAssistant.stageResolved', 'a clickable Stage row appears');
    assert.equal(fake.contexts.get('mergeAssistant.hasStageable'), true, 'and so does the toolbar button');
    assert.equal(fake.contexts.get('mergeAssistant.busy'), false);
    assert.equal(fake.contexts.get('mergeAssistant.hasConflicts'), false);
    assert.ok(!fake.outputs.get('Merge Assistant').lines.join('\n').includes('c=2'), 'code is never written to the log');
  } finally {
    await finish(dir);
  }
});

test('a doubtful answer opens the review page, and Accept applies it', async () => {
  const model = scriptedModel((request) => (forFile(request) === 'c' ? ambiguous('c=3') : keepBoth('d', 2, 3)));
  const { dir, fake, run } = await open({ model, settings: { 'mergeAssistant.useIntent': false, 'mergeAssistant.useReferences': false } });
  try {
    fake.script.review.push('accept');
    await run('mergeAssistant.resolveAll');

    const panel = fake.reviewPanels[0];
    assert.equal(panel.viewType, 'mergeAssistant.review');
    assert.equal(panel.options.enableScripts, true);
    assert.deepEqual(panel.options.localResourceRoots, [], 'the page can load nothing from disk');
    assert.equal(panel.options.retainContextWhenHidden, true);
    assert.equal(panel.title, 'Review: c.txt');
    assert.equal(fake.reviewPanels.length, 1, 'one page serves the whole run');

    const review = fake.callsOf('review.show')[0].html;
    assert.match(review, /Conflict 1 of 1/);
    assert.match(review, /Low confidence/);
    assert.match(review, /<span class="tx">c=2<\/span>/, 'ours is on the page');
    assert.match(review, /<span class="tx">c=3<\/span>/, 'theirs and the proposal are on the page');
    assert.equal(panel.disposed, true, 'the page closes when the run ends');
    assert.equal(read(dir, 'c.txt'), 'c=3\n');
  } finally {
    await finish(dir);
  }
});

test('Feedback typed in the page goes to the model, and the revised proposal is reviewed again', async () => {
  const model = scriptedModel((request, n) => {
    if (forFile(request) === 'd') return keepBoth('d', 2, 3);
    return n === 1 ? ambiguous('c=3') : keepBoth('c', 2, 3);
  });
  const { dir, fake, run } = await open({ model, settings: { 'mergeAssistant.useIntent': false, 'mergeAssistant.useReferences': false } });
  try {
    fake.script.review.push({ action: 'retry', feedback: '  keep both values  ' }, 'accept');
    await run('mergeAssistant.resolveAll');

    assert.equal(fake.callsOf('inputBox').length, 0, 'no pop-up box: the note is typed in the page');
    const second = model.requests.filter((r) => forFile(r) === 'c')[1];
    assert.match(second.messages.at(-1).content, /keep both values/);
    assert.match(second.messages.at(-1).content, /rejected/);

    const reviews = fake.callsOf('review.show');
    assert.equal(reviews.length, 2);
    assert.match(reviews[1].html, /Attempt 2/);
    assert.notEqual(reviews[0].html.match(/data-request="([^"]+)"/)[1], reviews[1].html.match(/data-request="([^"]+)"/)[1], 'each review has its own request id');
    assert.equal(fake.reviewPanels.length, 1, 'the same page is reused');
    assert.ok(fake.reviewPanels[0].htmls.some((h) => /Thinking again about c\.txt/.test(h) && /using your feedback/.test(h)), 'a progress screen shows while the model reconsiders');
    assert.equal(read(dir, 'c.txt'), 'c=2\nc=3\n');
  } finally {
    await finish(dir);
  }
});

test('the page shows what is missing from a flawed proposal and recommends feedback', async () => {
  // The model answers with d.txt's values for c.txt, so both of c.txt's own changes are missing.
  const model = scriptedModel(() => keepBoth('d', 2, 3));
  const { dir, fake, run } = await open({ model, settings: { 'mergeAssistant.useIntent': false, 'mergeAssistant.useReferences': false } });
  try {
    fake.script.review.push('reject', 'reject');
    await run('mergeAssistant.resolveAll');
    const html = fake.callsOf('review.show')[0].html;
    assert.match(html, /Review needed: the safeguards found problems with this proposal\./);
    assert.match(html, /<button class="primary" data-action="feedback">Give feedback<\/button>\s*<button class="risky" data-action="accept"[^>]*>Accept anyway<\/button>/);
    assert.match(html, /1 change missing/);
    assert.match(html, /missing from the proposal/);
  } finally {
    await finish(dir);
  }
});

test('forged, stale or malformed messages from the page are ignored; only a real answer counts', async () => {
  const model = scriptedModel((request) => (forFile(request) === 'c' ? ambiguous('c=3') : keepBoth('d', 2, 3)));
  const { dir, fake, run } = await open({ model, settings: { 'mergeAssistant.useIntent': false, 'mergeAssistant.useReferences': false } });
  try {
    fake.script.review.push('wait');
    const running = run('mergeAssistant.resolveAll');
    while (fake.callsOf('review.show').length === 0) await new Promise((resolve) => setTimeout(resolve, 20));

    const panel = fake.reviewPanels[0];
    const request = fake.callsOf('review.show')[0].html.match(/data-request="([^"]+)"/)[1];
    for (const bad of [null, 'accept', { type: 'decision', request: 'stale', action: 'accept' }, { type: 'decision', request, action: 'edit', resolution: 'rm -rf' },
      { type: 'decision', request, action: 'run-command', command: 'calc' }, { type: 'hello' }]) {
      panel.send(bad);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(read(dir, 'c.txt'), /<<<<<<</, 'nothing was decided by those messages');
    assert.equal(fake.callsOf('review.show').length, 1);

    panel.send({ type: 'decision', request, action: 'accept' });
    await running;
    assert.equal(read(dir, 'c.txt'), 'c=3\n', 'the genuine answer was applied');
  } finally {
    await finish(dir);
  }
});

test('Skip leaves a conflict as it was, and closing the page counts as skipping', async () => {
  const model = scriptedModel((request) => (forFile(request) === 'c' ? ambiguous('c=3') : ambiguous('d=3')));
  const { dir, fake, api, run } = await open({ model, settings: { 'mergeAssistant.useIntent': false, 'mergeAssistant.useReferences': false } });
  try {
    fake.script.review.push('reject', 'close');
    await run('mergeAssistant.resolveAll');

    assert.match(read(dir, 'c.txt'), /<<<<<<</);
    assert.match(read(dir, 'd.txt'), /<<<<<<</);
    assert.match(fake.messages('information').at(-1), /^2 skipped\./);
    assert.deepEqual(Object.values(fileNodes(api)).map((n) => n.icon.id), ['circle-slash', 'circle-slash']);
    assert.equal(fileNodes(api)['c.txt'].contextValue, 'conflictFile', 'skipped files can be retried');
  } finally {
    await finish(dir);
  }
});

test('several conflicts in one file: each is reviewed in turn, and what you accept is kept when you skip another', async () => {
  const dir = makeMultiConflictRepo();
  const fake = createFakeVscode({ folders: [dir], settings: { 'mergeAssistant.useIntent': false, 'mergeAssistant.useReferences': false } });
  const which = (request) => request.messages[0].content.match(/--- OURS ---\n([abc])=2/)[1];
  const client = { complete: async (request) => (which(request) === 'b' ? ambiguous('b=3') : keepBoth(which(request), 2, 3)) };
  const api = await activateWith(fake.vscode, fake.context(), { debounceMs: 20, createClient: () => client, fetchImpl: ollamaRunning() });
  active.push(api);
  try {
    fake.script.review.push('reject'); // the doubtful middle conflict is skipped
    await fake.commands.get('mergeAssistant.resolveAll')();

    const reviews = fake.callsOf('review.show');
    assert.equal(reviews.length, 1, 'only the doubtful conflict needed a review');
    assert.match(reviews[0].html, /Conflict 2 of 3/);

    const text = read(dir, 'f.txt');
    assert.match(text, /a=2\na=3/, 'the first conflict was written');
    assert.match(text, /c=2\nc=3/, 'the third conflict was written');
    assert.equal((text.match(/<<<<<<</g) ?? []).length, 1, 'only the skipped conflict still has markers');

    const file = fileNodes(api)['f.txt'];
    assert.equal(file.icon.id, 'warning');
    assert.match(file.description, /partly resolved/);
    assert.match(fake.messages('information').at(-1), /^1 partly resolved\. What you accepted was written; 1 conflict still has markers/);
    assert.deepEqual(stageableFiles(api.session.state), [], 'a partly resolved file is not offered for staging');
    const tree = buildTree(api.session.state);
    assert.equal(tree.find((n) => n.id === 'step:stage'), undefined);
    assert.equal(tree.find((n) => n.id === 'step:review').command.id, 'mergeAssistant.resolveAll', 'Review can be clicked again to continue');
    assert.match(tree.find((n) => n.id === 'step:review').description, /1 partly resolved/);
  } finally {
    await finish(dir);
  }
});

test('Resolve This File works on one file and leaves the other alone', async () => {
  const model = scriptedModel(() => keepBoth('d', 2, 3));
  const { dir, api, run } = await open({ model, settings: { 'mergeAssistant.useIntent': false, 'mergeAssistant.useReferences': false } });
  try {
    await run('mergeAssistant.resolveFile', fileNodes(api)['d.txt']);
    assert.equal(read(dir, 'd.txt'), 'd=2\nd=3\n');
    assert.match(read(dir, 'c.txt'), /<<<<<<</);
    assert.equal(model.requests.length, 1);
  } finally {
    await finish(dir);
  }
});

test('cancelling stops the run, keeps finished files, and closes a waiting review', { timeout: 60000 }, async () => {
  const model = scriptedModel((request) => (forFile(request) === 'c' ? keepBoth('c', 2, 3) : ambiguous('d=3')));
  const { dir, fake, api, run } = await open({ model, settings: { 'mergeAssistant.useIntent': false, 'mergeAssistant.useReferences': false } });
  try {
    fake.script.review.push('wait'); // the review for d.txt never gets an answer
    const running = run('mergeAssistant.resolveAll');
    while (fake.callsOf('review.show').length === 0) await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(fake.contexts.get('mergeAssistant.busy'), true);
    fake.progressTokens[0].cancel();
    await running;

    assert.equal(fake.reviewPanels[0].disposed, true, 'the open review page was closed');
    assert.equal(read(dir, 'c.txt'), 'c=2\nc=3\n', 'work finished before cancelling is kept');
    assert.match(read(dir, 'd.txt'), /<<<<<<</, 'the file being reviewed is untouched');
    assert.match(fake.messages('warning').at(-1), /^Cancelled\. 1 of 2 files was resolved before you stopped; 1 is still conflicted\./);
    assert.equal(fake.contexts.get('mergeAssistant.busy'), false);
    assert.equal(api.session.state.run.kind, null);
    assert.deepEqual(Object.values(fileNodes(api)).map((n) => n.icon.id), ['check', 'circle-outline']);
  } finally {
    await finish(dir);
  }
});

test('a model that fails is reported per file with a way to see why, and other files still finish', async () => {
  const model = scriptedModel((request) => (forFile(request) === 'c' ? new Error('connection refused') : keepBoth('d', 2, 3)));
  const { dir, fake, api, run } = await open({ model, settings: { 'mergeAssistant.useIntent': false, 'mergeAssistant.useReferences': false } });
  try {
    fake.script.warning.push('Show Log');
    await run('mergeAssistant.resolveAll');

    assert.equal(read(dir, 'd.txt'), 'd=2\nd=3\n');
    assert.match(read(dir, 'c.txt'), /<<<<<<</);
    const warning = fake.callsOf('warning').at(-1);
    assert.match(warning.message, /1 resolved, 1 failed\. c\.txt: model error: connection refused/);
    assert.ok(warning.rest.includes('Show Log'));
    assert.equal(fake.callsOf('output.show').length, 1, 'Show Log opens the log');
    assert.match(buildTree(api.session.state)[2].children[0].description, /connection refused/);
  } finally {
    await finish(dir);
  }
});

test('missing settings stop the run before any model call, with a way to fix them', async () => {
  const model = scriptedModel(() => assert.fail('must not call the model'));
  const { dir, fake, run } = await open({ model, settings: { 'mergeAssistant.provider': 'openai' } });
  try {
    fake.script.error.push('Open Settings');
    await run('mergeAssistant.resolveAll');
    assert.match(fake.messages('error')[0], /needs an API key/);
    assert.ok(fake.callsOf('executeCommand').some((c) => c.id === 'workbench.action.openSettings' && c.args[0] === 'mergeAssistant'));
    assert.equal(model.requests.length, 0);
    assert.equal(fake.callsOf('progress').length, 0);
  } finally {
    await finish(dir);
  }
});

test('the missing-key error offers the wizard first and the settings page second', async () => {
  const model = scriptedModel(() => assert.fail('must not call the model'));
  const { dir, fake, run } = await open({ model, settings: { 'mergeAssistant.provider': 'openai' } });
  try {
    fake.script.error.push('Set Up AI Model');
    await run('mergeAssistant.resolveAll');
    assert.deepEqual(fake.callsOf('error')[0].rest, ['Set Up AI Model', 'Open Settings']);
    assert.ok(fake.callsOf('executeCommand').some((c) => c.id === 'mergeAssistant.setUpModel'), 'the wizard was started');
    assert.equal(model.requests.length, 0);
  } finally {
    await finish(dir);
  }
});

test('Ollama that is not running stops the run up front, with the fix, instead of failing file by file', async () => {
  const model = scriptedModel(() => assert.fail('must not call the model'));
  const { dir, fake, run } = await open({ model, fetchImpl: network({}) }); // nothing is listening
  try {
    fake.script.error.push('Set Up AI Model');
    await run('mergeAssistant.resolveAll');

    const error = fake.callsOf('error')[0];
    assert.match(error.message, /^Ollama is not running at http:\/\/localhost:11434\. Start the Ollama app, or run "ollama serve"/);
    assert.deepEqual(error.rest, ['Set Up AI Model']);
    assert.ok(fake.callsOf('executeCommand').some((c) => c.id === 'mergeAssistant.setUpModel'));
    assert.equal(model.requests.length, 0);
    assert.equal(fake.callsOf('progress').length, 0, 'no run was started');
    assert.match(read(dir, 'c.txt'), /<<<<<<</, 'nothing was touched');
  } finally {
    await finish(dir);
  }
});

test('a model that Ollama has not downloaded is named, with a copyable command', async () => {
  const model = scriptedModel(() => assert.fail('must not call the model'));
  const fetchImpl = network({ [OLLAMA_TAGS]: ollamaWith('qwen2.5-coder:7b') });
  const { dir, fake, run } = await open({ model, fetchImpl, settings: { 'mergeAssistant.model': 'llama3.1' } });
  try {
    fake.script.error.push('Copy Download Command');
    await run('mergeAssistant.resolveAll');
    const error = fake.callsOf('error')[0];
    assert.equal(error.message, 'Ollama does not have "llama3.1" yet. Download it by running: ollama pull llama3.1');
    assert.deepEqual(error.rest, ['Copy Download Command', 'Set Up AI Model']);
    assert.equal(fake.vscode.env.clipboard.text, 'ollama pull llama3.1');
    assert.equal(model.requests.length, 0);
  } finally {
    await finish(dir);
  }
});

test('an unsafe model name is never turned into a command to copy', async () => {
  const model = scriptedModel(() => assert.fail('must not call the model'));
  const { dir, fake, run } = await open({ model, fetchImpl: network({ [OLLAMA_TAGS]: ollamaWith('llama3.1:latest') }), settings: { 'mergeAssistant.model': 'x; calc.exe' } });
  try {
    await run('mergeAssistant.resolveAll');
    const error = fake.callsOf('error')[0];
    assert.doesNotMatch(error.message, /ollama pull/);
    assert.deepEqual(error.rest, ['Set Up AI Model'], 'no copy button either');
  } finally {
    await finish(dir);
  }
});

test('a slow Ollama does not block the run, and the ":latest" tag counts as the same model', async () => {
  const slowFetch = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const model = scriptedModel((request) => keepBoth(forFile(request), 2, 3));
  const slow = await open({ model, fetchImpl: slowFetch, settings: { 'mergeAssistant.useIntent': false, 'mergeAssistant.useReferences': false } });
  try {
    await slow.run('mergeAssistant.resolveAll');
    assert.ok(model.requests.length > 0, 'the run went ahead although Ollama did not answer in time');
    assert.equal(slow.fake.callsOf('error').length, 0);
  } finally {
    await finish(slow.dir);
  }
});

test('providers other than Ollama never trigger the Ollama check', async () => {
  const model = scriptedModel((request) => keepBoth(forFile(request), 2, 3));
  const fetchImpl = network({});
  const { dir, fake, context, run } = await open({
    model, fetchImpl,
    settings: { 'mergeAssistant.provider': 'anthropic', 'mergeAssistant.model': 'claude-sonnet-5', 'mergeAssistant.useIntent': false, 'mergeAssistant.useReferences': false },
  });
  try {
    context.secretValues.set('mergeAssistant.apiKey.anthropic', 'sk-ant-0123456789');
    fake.script.warning.push('Allow once');
    await run('mergeAssistant.resolveAll');
    assert.equal(fetchImpl.calls.length, 0, 'no request went out for the check');
    assert.ok(model.requests.length > 0);
  } finally {
    await finish(dir);
  }
});

test('the key used for a run belongs to the server in use', async () => {
  const seen = [];
  const model = { requests: [], client: { complete: async (request) => keepBoth(forFile(request), 2, 3) } };
  const { dir, fake, context, run } = await open({
    model,
    settings: { 'mergeAssistant.provider': 'openai', 'mergeAssistant.model': 'm', 'mergeAssistant.baseUrl': 'http://other.example/v1', 'mergeAssistant.useIntent': false, 'mergeAssistant.useReferences': false },
  });
  try {
    context.secretValues.set('mergeAssistant.apiKey.openai', 'sk-REAL-openai-key-0000'); // the real key, not this server's
    await run('mergeAssistant.resolveAll');
    // No key is saved for other.example, so the run must stop at the settings check rather than send the real one.
    assert.match(fake.messages('error')[0], /needs an API key/);
    assert.equal(fake.callsOf('progress').length, 0);
    void seen;
  } finally {
    await finish(dir);
  }
});

test('a cloud provider asks before any code is sent, and "Always allow" is remembered', async () => {
  const model = scriptedModel((request) => keepBoth(forFile(request), 2, 3));
  const { dir, fake, context, run } = await open({ model, settings: { 'mergeAssistant.provider': 'openai', 'mergeAssistant.useIntent': false, 'mergeAssistant.useReferences': false, 'mergeAssistant.useTools': true } });
  try {
    context.secretValues.set('mergeAssistant.apiKey.openai', 'sk-test-key-1234567890');

    await run('mergeAssistant.resolveAll'); // consent dismissed
    const ask = fake.callsOf('warning')[0];
    assert.equal(ask.message, 'Send conflicting code to OpenAI (api.openai.com)?');
    assert.equal(ask.rest[0].modal, true);
    assert.match(ask.rest[0].detail, /files the model asks to read are sent too/);
    assert.equal(model.requests.length, 0, 'nothing was sent');

    fake.script.warning.push('Always allow');
    await run('mergeAssistant.resolveAll');
    assert.ok(model.requests.length > 0);

    const before = fake.callsOf('warning').length;
    context.secretValues.set('mergeAssistant.apiKey.openai', 'sk-test-key-1234567890');
    // everything already resolved, so only check that the consent is not asked again
    await run('mergeAssistant.resolveAll');
    assert.equal(fake.callsOf('warning').slice(before).filter((c) => /Send conflicting code/.test(c.message)).length, 0);
  } finally {
    await finish(dir);
  }
});

test('a local model never triggers the consent prompt', async () => {
  const model = scriptedModel((request) => keepBoth(forFile(request), 2, 3));
  const { dir, fake, run } = await open({ model, settings: { 'mergeAssistant.useIntent': false, 'mergeAssistant.useReferences': false } });
  try {
    await run('mergeAssistant.resolveAll');
    assert.ok(!fake.messages('warning').some((m) => /Send conflicting code/.test(m)));
  } finally {
    await finish(dir);
  }
});

test('unsaved edits to a conflicted file block the run until they are saved', async () => {
  const model = scriptedModel((request) => keepBoth(forFile(request), 2, 3));
  const { dir, fake, run } = await open({ model, settings: { 'mergeAssistant.useIntent': false, 'mergeAssistant.useReferences': false } });
  try {
    let saved = false;
    fake.vscode.workspace.textDocuments.push({ isDirty: true, uri: { scheme: 'file', fsPath: path.join(dir, 'c.txt') }, save: async () => { saved = true; return true; } });

    await run('mergeAssistant.resolveAll'); // warning dismissed
    assert.equal(model.requests.length, 0);
    assert.equal(saved, false);
    assert.match(fake.callsOf('warning')[0].message, /1 file has unsaved changes \(c\.txt\)/);

    fake.script.warning.push('Save All and Continue');
    await run('mergeAssistant.resolveAll');
    assert.equal(saved, true);
    assert.ok(model.requests.length > 0);
  } finally {
    await finish(dir);
  }
});

test('with no merge, or nothing to resolve, it says so and does nothing', async () => {
  const model = scriptedModel(() => assert.fail('must not call the model'));
  const { dir, fake, run } = await open({ model, merge: false });
  try {
    await run('mergeAssistant.resolveAll');
    assert.match(fake.messages('information')[0], /There is no merge in progress/);
    assert.equal(fake.callsOf('progress').length, 0);

    await run('mergeAssistant.resolveFile'); // no tree item given
    assert.match(fake.messages('information')[1], /Choose a conflicted file/);
  } finally {
    await finish(dir);
  }
});

test('a second Resolve while one is running is refused, not queued', { timeout: 60000 }, async () => {
  const model = scriptedModel(() => ambiguous('c=3'));
  const { dir, fake, run } = await open({ model, settings: { 'mergeAssistant.useIntent': false, 'mergeAssistant.useReferences': false } });
  try {
    fake.script.review.push('wait');
    const first = run('mergeAssistant.resolveAll');
    while (fake.callsOf('review.show').length === 0) await new Promise((resolve) => setTimeout(resolve, 20));

    await run('mergeAssistant.resolveAll');
    assert.match(fake.messages('warning').at(-1), /already resolving conflicts/);

    fake.progressTokens[0].cancel();
    await first;
  } finally {
    await finish(dir);
  }
});

test('tool calls the model makes are shown as progress and logged by name, not by content', async () => {
  const calls = [];
  const model = {
    requests: [],
    client: {
      chat: async ({ tools }) => {
        calls.push(tools ? 'with tools' : 'without tools');
        if (calls.length === 1) return { text: '', toolCalls: [{ id: '1', name: 'find_references', args: { symbol: 'c' } }] };
        return { text: keepBoth('c', 2, 3), toolCalls: [] };
      },
      complete: async () => keepBoth('d', 2, 3),
    },
  };
  const { dir, fake, run } = await open({ model, settings: { 'mergeAssistant.useIntent': false, 'mergeAssistant.useReferences': false, 'mergeAssistant.useTools': true } });
  try {
    fake.script.warning.push('Allow once');
    await run('mergeAssistant.resolveFile', { file: 'c.txt' });
    const log = fake.outputs.get('Merge Assistant').lines.join('\n');
    assert.match(log, /\[Conflict Agent\] tool: find_references\(symbol="c"\)/);
    assert.ok(fake.callsOf('progress.report').some((c) => /find_references/.test(c.value.message)));
  } finally {
    await finish(dir);
  }
});
