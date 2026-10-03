import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveConflicts } from '../src/orchestrator/index.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

// One file with two far-apart conflicts, so a run asks the model about two hunks.
const makeTwoHunkRepo = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mca-orch-tools-'));
  const filler = Array.from({ length: 10 }, (_, i) => `// filler ${i}`);
  const body = (a, b) => ['export const first = ' + a + ';', ...filler, 'export const second = ' + b + ';', ''].join('\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'merge.conflictstyle', 'diff3');
  writeFileSync(path.join(dir, 'f.js'), body(0, 0));
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  writeFileSync(path.join(dir, 'f.js'), body(2, 2));
  git(dir, 'commit', '-qam', 'feature');
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(path.join(dir, 'f.js'), body(1, 1));
  git(dir, 'commit', '-qam', 'main');
  try { git(dir, 'merge', 'feature'); } catch { /* conflict expected */ }
  return dir;
};

const ANSWER = '{"resolution": "export const first = 3;", "confidence": "high", "ambiguous": false}';
const fakeTool = (name) => ({ name, description: name, parameters: { type: 'object', properties: {}, required: [] }, run: async () => name });
const ALL_TOOL_NAMES = ['read_file', 'find_references', 'list_importers', 'get_conflict_stages', 'git_log', 'git_show', 'git_blame'];

const baseOptions = (dir, llm, extra = {}) => ({
  cwd: dir,
  llm,
  dryRun: true,
  useReferences: false,
  // Accepting keeps the run going to the second hunk; rejecting would end the file early.
  approve: async () => ({ action: 'accept' }),
  ...extra,
});

test('tools are off by default: the model is never given any', async () => {
  const dir = makeTwoHunkRepo();
  try {
    let chats = 0;
    const llm = { chat: async () => { chats += 1; return { text: ANSWER, toolCalls: [] }; }, complete: async () => ANSWER };
    await resolveConflicts(baseOptions(dir, llm, { useIntent: false, toolFactory: () => assert.fail('must not build tools') }));
    assert.equal(chats, 0);
  } finally {
    cleanup(dir);
  }
});

test('with tools on, the Conflict Agent gets every tool and the Intent Agent only history and docs', async () => {
  const dir = makeTwoHunkRepo();
  try {
    const offered = [];
    const llm = {
      chat: async ({ system, tools }) => {
        offered.push({ agent: /Intent Agent/.test(system) ? 'intent' : 'conflict', names: tools.map((t) => t.name) });
        return {
          text: /Intent Agent/.test(system) ? '{"ours": "a", "theirs": "b", "relationship": "c"}' : ANSWER,
          toolCalls: [],
        };
      },
      complete: async () => assert.fail('complete() should not be used when tools work'),
    };
    await resolveConflicts(baseOptions(dir, llm, { useTools: true, toolFactory: () => ALL_TOOL_NAMES.map(fakeTool) }));

    assert.deepEqual(offered[0], { agent: 'intent', names: ['read_file', 'git_log', 'git_show'].sort((a, b) => ALL_TOOL_NAMES.indexOf(a) - ALL_TOOL_NAMES.indexOf(b)) });
    const conflictRequests = offered.filter((o) => o.agent === 'conflict');
    assert.equal(conflictRequests.length, 2, 'one request per hunk');
    assert.deepEqual(conflictRequests[0].names, ALL_TOOL_NAMES);
  } finally {
    cleanup(dir);
  }
});

test('the first tool failure switches tools off for the rest of the run and is reported once', async () => {
  const dir = makeTwoHunkRepo();
  try {
    let chats = 0;
    const llm = {
      chat: async () => { chats += 1; throw new Error('model does not support tools'); },
      complete: async () => ANSWER,
    };
    const events = [];
    const { files } = await resolveConflicts(baseOptions(dir, llm, {
      useIntent: false,
      useTools: true,
      toolFactory: () => [fakeTool('read_file')],
      onEvent: (e) => events.push(e.type),
    }));

    assert.equal(chats, 1, 'the second hunk must not try tools again');
    assert.equal(events.filter((t) => t === 'tools-unavailable').length, 1);
    assert.equal(events.filter((t) => t === 'proposed').length, 2, 'both hunks were still resolved');
    assert.equal(files[0].status, 'would-resolve', 'the run still completed normally');
  } finally {
    cleanup(dir);
  }
});

test('tool calls made by the model are reported live and recorded on the proposal', async () => {
  const dir = makeTwoHunkRepo();
  try {
    const replies = [
      { text: '', toolCalls: [{ id: '1', name: 'read_file', args: { path: 'f.js' } }] },
      { text: ANSWER, toolCalls: [] },
    ];
    const llm = { chat: async () => replies.shift() ?? { text: ANSWER, toolCalls: [] }, complete: async () => ANSWER };
    const events = [];
    let seenProposal;
    await resolveConflicts(baseOptions(dir, llm, {
      useIntent: false,
      useTools: true,
      toolFactory: () => [fakeTool('read_file')],
      onEvent: (e) => events.push(e),
      approve: async ({ proposal }) => { seenProposal ??= proposal; return { action: 'reject' }; },
    }));

    const toolEvent = events.find((e) => e.type === 'tool-call');
    assert.deepEqual({ agent: toolEvent.agent, label: toolEvent.label, ok: toolEvent.ok }, { agent: 'Conflict Agent', label: 'read_file(path="f.js")', ok: true });
    assert.deepEqual(seenProposal.toolCalls, [{ name: 'read_file', args: { path: 'f.js' }, ok: true }]);
  } finally {
    cleanup(dir);
  }
});
