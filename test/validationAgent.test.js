import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectValidationCommands, runValidation } from '../src/agents/validationAgent.js';

const makeDir = (files = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mca-val-'));
  Object.entries(files).forEach(([name, content]) => writeFileSync(path.join(dir, name), content));
  return dir;
};
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });

test('detects checks from package.json in test, typecheck, lint, build order', async () => {
  const dir = makeDir({
    'package.json': JSON.stringify({ scripts: { build: 'x', lint: 'x', 'type-check': 'x', test: 'x', dev: 'x' } }),
  });
  try {
    const { source, commands } = await detectValidationCommands(dir);
    assert.equal(source, 'package.json');
    assert.deepEqual(commands.map((c) => c.command), [
      'npm run test',
      'npm run type-check',
      'npm run lint',
      'npm run build',
    ]);
  } finally {
    cleanup(dir);
  }
});

test('uses the repo package manager and ignores the npm-init placeholder test script', async () => {
  const dir = makeDir({
    'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', lint: 'x' } }),
    'yarn.lock': '',
  });
  try {
    const { commands } = await detectValidationCommands(dir);
    assert.deepEqual(commands.map((c) => c.command), ['yarn run lint']);
  } finally {
    cleanup(dir);
  }
});

test('.merge-agent.json overrides package.json and accepts strings or objects', async () => {
  const dir = makeDir({
    'package.json': JSON.stringify({ scripts: { test: 'x' } }),
    '.merge-agent.json': JSON.stringify({ validate: ['npm run a', { name: 'smoke', command: 'npm run b' }] }),
  });
  try {
    const { source, commands } = await detectValidationCommands(dir);
    assert.equal(source, '.merge-agent.json');
    assert.deepEqual(commands, [
      { name: 'check 1', command: 'npm run a' },
      { name: 'smoke', command: 'npm run b' },
    ]);
  } finally {
    cleanup(dir);
  }
});

test('reports no commands for a repo without package.json, and rejects invalid config JSON', async () => {
  const empty = makeDir();
  const broken = makeDir({ '.merge-agent.json': '{ nope' });
  try {
    assert.deepEqual(await detectValidationCommands(empty), { source: 'none', commands: [] });
    await assert.rejects(detectValidationCommands(broken), /\.merge-agent\.json is not valid JSON/);
  } finally {
    cleanup(empty);
    cleanup(broken);
  }
});

test('runValidation passes when every command succeeds', async () => {
  const dir = makeDir();
  try {
    const result = await runValidation({
      cwd: dir,
      commands: [
        { name: 'one', command: 'node -e "console.log(1)"' },
        { name: 'two', command: 'node -e "console.log(2)"' },
      ],
    });
    assert.equal(result.ran, true);
    assert.equal(result.passed, true);
    assert.deepEqual(result.steps.map((s) => s.status), ['passed', 'passed']);
    assert.match(result.steps[0].output, /1/);
  } finally {
    cleanup(dir);
  }
});

test('runValidation stops at the first failure, keeps its output and skips the rest', async () => {
  const dir = makeDir();
  try {
    const events = [];
    const result = await runValidation({
      cwd: dir,
      onEvent: (e) => events.push(e.name),
      commands: [
        { name: 'ok', command: 'node -e "process.exit(0)"' },
        { name: 'bad', command: 'node -e "console.error(\'type error in x.ts\'); process.exit(3)"' },
        { name: 'never', command: 'node -e "process.exit(0)"' },
      ],
    });
    assert.equal(result.passed, false);
    assert.deepEqual(result.steps.map((s) => s.status), ['passed', 'failed', 'skipped']);
    assert.equal(result.steps[1].exitCode, 3);
    assert.match(result.steps[1].output, /type error in x\.ts/);
    assert.deepEqual(events, ['ok', 'bad']);
  } finally {
    cleanup(dir);
  }
});

test('runValidation fails a command that exceeds the timeout, and never passes with zero commands', async () => {
  const dir = makeDir();
  try {
    const slow = await runValidation({
      cwd: dir,
      timeoutMs: 300,
      commands: [{ name: 'slow', command: 'node -e "setTimeout(() => {}, 20000)"' }],
    });
    assert.equal(slow.passed, false);
    assert.equal(slow.steps[0].timedOut, true);

    const none = await runValidation({ cwd: dir, commands: [] });
    assert.deepEqual(none, { ran: false, passed: false, cancelled: false, steps: [] });
  } finally {
    cleanup(dir);
  }
});

// A process that cannot be killed (a stuck grandchild still holding its output open) used to
// leave the run waiting forever. These simulate it with a kill that does nothing.
// The refused kill remembers the process; the test ends it for real afterwards, because a process
// left running keeps its folder open and Windows then refuses to delete it.
const refusedKills = [];
const NO_KILL = async (child) => { refusedKills.push(child.pid); };
const killForReal = () => {
  for (const pid of refusedKills.splice(0)) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
};
const SLEEPS_20S = 'node -e "setTimeout(() => {}, 20000)"';

test('a check that cannot be killed after a cancel is abandoned after the grace period, not waited for', { timeout: 60000 }, async () => {
  const dir = makeDir();
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    const result = await runValidation({
      cwd: dir, signal: controller.signal, killTree: NO_KILL, killGraceMs: 400,
      commands: [{ name: 'stuck', command: SLEEPS_20S }, { name: 'later', command: 'node -e "process.exit(0)"' }],
    });
    assert.ok(Date.now() - started < 10000, 'it did not wait for the 20 second process');
    assert.deepEqual(result.steps.map((s) => s.status), ['cancelled', 'skipped']);
    assert.equal(result.cancelled, true);
    assert.match(result.steps[0].output, /did not end after being stopped, so it was abandoned/);
  } finally {
    killForReal();
    cleanup(dir);
  }
});

test('a check that cannot be killed after a timeout is reported as timed out and abandoned', { timeout: 60000 }, async () => {
  const dir = makeDir();
  try {
    const started = Date.now();
    const result = await runValidation({
      cwd: dir, timeoutMs: 300, killTree: NO_KILL, killGraceMs: 400,
      commands: [{ name: 'stuck', command: SLEEPS_20S }],
    });
    assert.ok(Date.now() - started < 10000);
    assert.equal(result.passed, false);
    assert.equal(result.steps[0].status, 'failed');
    assert.equal(result.steps[0].timedOut, true);
    assert.match(result.steps[0].output, /abandoned/);
  } finally {
    killForReal();
    cleanup(dir);
  }
});

test('a kill that throws still ends the step, and a normal exit never waits for the grace period', { timeout: 60000 }, async () => {
  const dir = makeDir();
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const exploding = await runValidation({
      cwd: dir, signal: controller.signal, killGraceMs: 300,
      killTree: async (child) => { refusedKills.push(child.pid); throw new Error('taskkill is not available'); },
      commands: [{ name: 'stuck', command: SLEEPS_20S }],
    });
    assert.equal(exploding.steps[0].status, 'cancelled');

    const started = Date.now();
    const quick = await runValidation({ cwd: dir, killGraceMs: 60000, commands: [{ name: 'ok', command: 'node -e "process.exit(0)"' }] });
    assert.equal(quick.passed, true);
    assert.ok(Date.now() - started < 15000, 'a finished check does not wait for the 60 second grace period');
  } finally {
    killForReal();
    cleanup(dir);
  }
});
