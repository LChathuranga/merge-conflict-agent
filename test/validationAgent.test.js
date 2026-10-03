import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectValidationCommands, runValidation } from '../src/agents/validationAgent.js';

const makeDir = (files = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mca-val-'));
  Object.entries(files).forEach(([name, content]) => writeFileSync(path.join(dir, name), content));
  return dir;
};
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

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
    assert.deepEqual(none, { ran: false, passed: false, steps: [] });
  } finally {
    cleanup(dir);
  }
});
