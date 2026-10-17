import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAbortError, isAbort, raceAbort, rethrowIfAborted, throwIfAborted } from '../src/util/abort.js';
import { askWithOptionalTools } from '../src/llm/toolLoop.js';
import { proposeResolution } from '../src/agents/conflictAgent.js';
import { runValidation } from '../src/agents/validationAgent.js';
import { createOpenAIAdapter } from '../src/llm/adapters/openai.js';
import { createAnthropicAdapter } from '../src/llm/adapters/anthropic.js';
import { resolveConflicts } from '../src/orchestrator/index.js';
import { parseConflictHunks } from '../src/conflict/parser.js';
import { cleanup, repoFromTemplate } from '../test-support/gitRepo.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const read = (dir, file) => readFileSync(path.join(dir, file), 'utf8');
const sdkAbort = () => Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' });

// Two files that both conflict (a.txt, b.txt): "a=2" on main vs "a=3" on feature, from "a=0".
// The history is built once for the whole file and copied for each test; only the merge itself
// runs per test. Building it per test is dozens of git calls, which overran the time limits
// whenever the machine was busy.
const buildTwoFileHistory = (dir) => {
  const put = (file, text) => writeFileSync(path.join(dir, file), text);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'merge.conflictstyle', 'diff3');
  put('a.txt', 'a=0\n');
  put('b.txt', 'b=0\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  put('a.txt', 'a=3\n');
  put('b.txt', 'b=3\n');
  git(dir, 'commit', '-qam', 'feature');
  git(dir, 'checkout', '-q', 'main');
  put('a.txt', 'a=2\n');
  put('b.txt', 'b=2\n');
  git(dir, 'commit', '-qam', 'main');
};

const makeTwoFileRepo = () => {
  const dir = repoFromTemplate('abort', buildTwoFileHistory);
  try { git(dir, 'merge', 'feature'); } catch { /* conflicts expected */ }
  return dir;
};

// Keeps both sides, so it is accepted without asking the user.
const bothSides = (name) => JSON.stringify({ resolution: `${name}=2\n${name}=3`, explanation: 'keep both', confidence: 'high', ambiguous: false });
const base = { useIntent: false, useReferences: false };

test('abort helpers: create, detect, throw, rethrow and race', async () => {
  const error = createAbortError('Cancelled', [{ file: 'a' }]);
  assert.equal(error.name, 'AbortError');
  assert.deepEqual(error.results, [{ file: 'a' }]);
  assert.equal(isAbort(error), true);
  assert.equal(isAbort(sdkAbort()), true);
  assert.equal(isAbort(new Error('boom')), false);

  const controller = new AbortController();
  assert.doesNotThrow(() => throwIfAborted(controller.signal));
  assert.doesNotThrow(() => rethrowIfAborted(new Error('ordinary'), controller.signal));
  controller.abort();
  assert.throws(() => throwIfAborted(controller.signal), { name: 'AbortError' });
  assert.throws(() => rethrowIfAborted(new Error('ordinary'), controller.signal), { name: 'AbortError' });

  const live = new AbortController();
  assert.equal(await raceAbort(Promise.resolve('done'), live.signal), 'done');
  const pending = raceAbort(new Promise(() => {}), live.signal);
  live.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(raceAbort(new Promise(() => {}), live.signal), { name: 'AbortError' });
});

test('a cancelled tool-capable request is not retried as a plain request and does not disable tools', async () => {
  const controller = new AbortController();
  const events = [];
  let completes = 0;
  const llm = {
    chat: async ({ signal }) => {
      assert.equal(signal, controller.signal, 'the signal reaches the model call');
      controller.abort();
      throw sdkAbort();
    },
    complete: async () => { completes += 1; return '{}'; },
  };

  await assert.rejects(
    askWithOptionalTools({
      llm, system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 't', description: 'd', parameters: {}, run: async () => '' }],
      signal: controller.signal, onToolEvent: (e) => events.push(e.type),
    }),
    { name: 'AbortError' }
  );
  assert.equal(completes, 0, 'no second model request after cancelling');
  assert.deepEqual(events, [], 'not reported as "tools unavailable"');
});

test('the signal reaches the model call made by the Conflict Agent', async () => {
  const text = ['<<<<<<< a', 'x=2', '||||||| b', 'x=0', '=======', 'x=3', '>>>>>>> c', ''].join('\n');
  const [hunk] = parseConflictHunks(text);
  const controller = new AbortController();
  let seen;
  const llm = { complete: async (req) => { seen = req; return bothSides('x'); } };
  await proposeResolution({ llm, file: 'x.txt', fileText: text, hunk, signal: controller.signal });
  assert.equal(seen.signal, controller.signal);
});

test('cancelling during the second file keeps the first file resolved and reports it', async () => {
  const dir = makeTwoFileRepo();
  try {
    const controller = new AbortController();
    const events = [];
    let calls = 0;
    const llm = {
      complete: async () => {
        calls += 1;
        if (calls === 2) {
          controller.abort();
          throw sdkAbort();
        }
        return bothSides('a');
      },
    };

    const error = await resolveConflicts({
      ...base, cwd: dir, llm, signal: controller.signal, approve: async () => assert.fail('no approval expected'),
      onEvent: (e) => events.push(e.type),
    }).then(() => null, (e) => e);

    assert.equal(error?.name, 'AbortError');
    assert.deepEqual(error.results.map((r) => `${r.status} ${r.file}`), ['resolved a.txt']);
    assert.equal(read(dir, 'a.txt'), 'a=2\na=3\n', 'finished work stays on disk');
    assert.match(read(dir, 'b.txt'), /<<<<<<</, 'the cancelled file is untouched');
    assert.ok(!events.includes('failed'), 'a cancellation is not a model failure');
  } finally {
    cleanup(dir);
  }
});

test('cancelling while waiting for the user ends the run instead of hanging', { timeout: 120000 }, async () => {
  const dir = makeTwoFileRepo();
  try {
    const controller = new AbortController();
    const llm = { complete: async () => JSON.stringify({ resolution: 'a=3', confidence: 'high', ambiguous: false }) };
    const started = Date.now();
    const run = resolveConflicts({
      ...base, cwd: dir, llm, signal: controller.signal,
      approve: async () => new Promise(() => {}), // a prompt nobody ever answers
    });
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(run, { name: 'AbortError' });
    assert.ok(Date.now() - started < 5000);
  } finally {
    cleanup(dir);
  }
});

test('an already-cancelled run does nothing', async () => {
  const dir = makeTwoFileRepo();
  try {
    const controller = new AbortController();
    controller.abort();
    const error = await resolveConflicts({
      ...base, cwd: dir, llm: { complete: async () => assert.fail('no model call') }, signal: controller.signal, approve: async () => assert.fail('no prompt'),
    }).then(() => null, (e) => e);
    assert.equal(error?.name, 'AbortError');
    assert.deepEqual(error.results, []);
    assert.match(read(dir, 'a.txt'), /<<<<<<</);
  } finally {
    cleanup(dir);
  }
});

test('onlyFiles limits a run to the listed files', async () => {
  const dir = makeTwoFileRepo();
  try {
    const { files } = await resolveConflicts({
      ...base, cwd: dir, dryRun: true, onlyFiles: ['b.txt'],
      llm: { complete: async () => bothSides('b') }, approve: async () => assert.fail('no approval expected'),
    });
    assert.deepEqual(files.map((f) => f.file), ['b.txt']);
  } finally {
    cleanup(dir);
  }
});

const SLOW = 'node -e "setTimeout(() => {}, 20000)"';

test('cancelling validation kills the running command and skips the rest', { timeout: 120000 }, async () => {
  const dir = makeTwoFileRepo();
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);
    const started = Date.now();
    const result = await runValidation({
      cwd: dir, signal: controller.signal,
      commands: [{ name: 'slow', command: SLOW }, { name: 'later', command: 'node -e "process.exit(0)"' }],
    });
    assert.ok(Date.now() - started < 15000, 'the 20 second command was stopped, not waited for');
    assert.deepEqual(result.steps.map((s) => s.status), ['cancelled', 'skipped']);
    assert.equal(result.cancelled, true);
    assert.equal(result.passed, false);

    const before = new AbortController();
    before.abort();
    const never = await runValidation({ cwd: dir, signal: before.signal, commands: [{ name: 'x', command: SLOW }] });
    assert.deepEqual(never.steps.map((s) => s.status), ['cancelled']);
    assert.equal(never.ran, false);
  } finally {
    cleanup(dir);
  }
});

test('cancelling during validation rejects the run but keeps the resolved files', { timeout: 120000 }, async () => {
  const dir = makeTwoFileRepo();
  try {
    const controller = new AbortController();
    const events = [];
    const error = await resolveConflicts({
      ...base, cwd: dir, validate: true, signal: controller.signal,
      llm: { complete: async (req) => bothSides(/b=/.test(req.messages[0].content) ? 'b' : 'a') },
      approve: async () => assert.fail('no approval expected'),
      validator: async ({ signal }) => {
        setTimeout(() => controller.abort(), 300);
        return runValidation({ cwd: dir, signal, commands: [{ name: 'slow', command: SLOW }] });
      },
      onEvent: (e) => events.push(e.type),
    }).then(() => null, (e) => e);

    assert.equal(error?.name, 'AbortError');
    assert.deepEqual(error.results.map((r) => r.status), ['resolved', 'resolved']);
    assert.ok(!events.includes('validated'));
    assert.equal(read(dir, 'a.txt'), 'a=2\na=3\n');
  } finally {
    cleanup(dir);
  }
});

// A server that accepts the request and never answers, so only the signal can end the call.
const withHangingServer = async (run) => {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};

test('cancelling interrupts a real OpenAI-compatible request', { timeout: 120000 }, async () => {
  await withHangingServer(async (url) => {
    const adapter = createOpenAIAdapter({ provider: 'ollama', model: 'm', apiKey: 'k', baseURL: `${url}/v1`, jsonMode: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    await assert.rejects(adapter.chat({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal }));
    assert.ok(Date.now() - started < 5000);
  });
});

test('cancelling interrupts a real Anthropic request', { timeout: 120000 }, async () => {
  await withHangingServer(async (url) => {
    const previous = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = url;
    try {
      const adapter = createAnthropicAdapter({ model: 'm', apiKey: 'k' });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      const started = Date.now();
      await assert.rejects(adapter.chat({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal }));
      assert.ok(Date.now() - started < 5000);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = previous;
    }
  });
});
