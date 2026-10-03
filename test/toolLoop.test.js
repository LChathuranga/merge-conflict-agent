import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askWithOptionalTools, runToolLoop, TOOL_USE_RULES } from '../src/llm/toolLoop.js';
import { fromOpenAIMessage, toOpenAIMessages, toOpenAITools } from '../src/llm/adapters/openai.js';
import { fromAnthropicContent, toAnthropicMessages, toAnthropicTools } from '../src/llm/adapters/anthropic.js';
import { proposeResolution } from '../src/agents/conflictAgent.js';
import { summarizeIntent } from '../src/agents/intentAgent.js';
import { parseConflictHunks } from '../src/conflict/parser.js';

// A model that replays scripted replies and records every request it receives.
const scriptedLlm = (replies) => {
  const requests = [];
  return {
    requests,
    chat: async (request) => {
      requests.push({ ...request, messages: [...request.messages] });
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(request) : next;
    },
    complete: async () => assert.fail('complete() should not be used'),
  };
};

const echoTool = (log = []) => ({
  name: 'echo',
  description: 'Echo the value back',
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  run: async ({ value }) => { log.push(value); return `echo:${value}`; },
});

const callOf = (id, name, args) => ({ id, name, args });

test('runs the requested tool and sends its result back as a tool message', async () => {
  const log = [];
  const llm = scriptedLlm([
    { text: 'checking', toolCalls: [callOf('c1', 'echo', { value: 'hi' })] },
    { text: '{"resolution":"x"}', toolCalls: [] },
  ]);
  const seen = [];
  const result = await runToolLoop({
    llm, system: 'sys', messages: [{ role: 'user', content: 'go' }], tools: [echoTool(log)], onToolCall: (c) => seen.push(c.label),
  });

  assert.equal(result.text, '{"resolution":"x"}');
  assert.deepEqual(log, ['hi']);
  assert.deepEqual(result.calls, [{ name: 'echo', args: { value: 'hi' }, ok: true }]);
  assert.deepEqual(seen, ['echo(value="hi")']);

  const second = llm.requests[1].messages;
  assert.deepEqual(second.map((m) => m.role), ['user', 'assistant', 'tool']);
  assert.equal(second[1].toolCalls[0].id, 'c1');
  assert.deepEqual(second[2], { role: 'tool', toolCallId: 'c1', name: 'echo', content: 'echo:hi' });
  assert.equal(llm.requests[0].tools.length, 1);
});

test('a repeated identical call is not run twice, and failures come back as readable errors', async () => {
  const log = [];
  const boom = { name: 'boom', description: 'always fails', parameters: { type: 'object', properties: {}, required: [] }, run: async () => { throw new Error('disk on fire'); } };
  const llm = scriptedLlm([
    { text: '', toolCalls: [callOf('1', 'echo', { value: 'a' }), callOf('2', 'echo', { value: 'a' }), callOf('3', 'boom', {}), callOf('4', 'nope', {})] },
    { text: 'done', toolCalls: [] },
  ]);
  const { calls } = await runToolLoop({ llm, system: 's', messages: [{ role: 'user', content: 'go' }], tools: [echoTool(log), boom] });

  assert.deepEqual(log, ['a']);
  const results = llm.requests[1].messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.equal(results[0], 'echo:a');
  assert.match(results[1], /already made this exact call[\s\S]*echo:a/);
  assert.equal(results[2], 'Error: disk on fire');
  assert.match(results[3], /unknown tool "nope"\. Available tools: echo, boom/);
  assert.deepEqual(calls.map((c) => c.ok), [true, true, false, false]);
});

test('invalid arguments, oversized results and too many parallel calls are all handled', async () => {
  const big = { name: 'big', description: 'long output', parameters: { type: 'object', properties: {}, required: [] }, run: async () => 'x'.repeat(500) };
  const calls = Array.from({ length: 6 }, (_, i) => callOf(`p${i}`, 'big', { n: i }));
  const llm = scriptedLlm([
    { text: '', toolCalls: [{ id: 'bad', name: 'big', args: {}, argsError: 'Unexpected token' }, ...calls] },
    { text: 'done', toolCalls: [] },
  ]);
  await runToolLoop({ llm, system: 's', messages: [{ role: 'user', content: 'go' }], tools: [big], maxResultChars: 100 });

  const tool = llm.requests[1].messages.filter((m) => m.role === 'tool');
  assert.equal(tool.length, 7, 'every requested call gets an answer');
  assert.match(tool[0].content, /arguments were not valid JSON \(Unexpected token\)/);
  assert.match(tool[1].content, /\(truncated, 400 more characters\)$/);
  assert.match(tool[5].content, /too many parallel calls/);
  assert.match(tool[6].content, /too many parallel calls/);
});

test('the step budget withholds tools and asks for a final answer', async () => {
  const llm = scriptedLlm([
    { text: '', toolCalls: [callOf('1', 'echo', { value: '1' })] },
    { text: '', toolCalls: [callOf('2', 'echo', { value: '2' })] },
    (request) => (request.tools ? assert.fail('tools must be withheld') : { text: '{"resolution":"final"}', toolCalls: [] }),
  ]);
  const result = await runToolLoop({ llm, system: 's', messages: [{ role: 'user', content: 'go' }], tools: [echoTool()], maxSteps: 2 });

  assert.equal(result.text, '{"resolution":"final"}');
  assert.equal(llm.requests.length, 3);
  assert.equal(llm.requests[2].tools, undefined);
  assert.match(llm.requests[2].messages.at(-1).content, /tool budget is used up/i);
});

test('an adapter without chat() cannot run the loop', async () => {
  await assert.rejects(
    runToolLoop({ llm: { complete: async () => '' }, system: 's', messages: [], tools: [echoTool()] }),
    /does not support tool calling/
  );
});

test('askWithOptionalTools adds the tool rules, and falls back to a plain request when tools fail', async () => {
  const ok = scriptedLlm([{ text: 'answer', toolCalls: [] }]);
  const events = [];
  const first = await askWithOptionalTools({ llm: ok, system: 'SYS', messages: [], tools: [echoTool()], agent: 'A', onToolEvent: (e) => events.push(e) });
  assert.deepEqual({ text: first.text, toolsFailed: first.toolsFailed }, { text: 'answer', toolsFailed: false });
  assert.equal(ok.requests[0].system, `SYS\n\n${TOOL_USE_RULES}`);

  const broken = { chat: async () => { throw new Error('400 registry.ollama.ai/library/llama3 does not support tools'); }, complete: async (r) => `plain:${r.json}` };
  const second = await askWithOptionalTools({ llm: broken, system: 'SYS', messages: [], tools: [echoTool()], agent: 'A', onToolEvent: (e) => events.push(e) });
  assert.deepEqual({ text: second.text, toolsFailed: second.toolsFailed }, { text: 'plain:true', toolsFailed: true });
  assert.equal(events.at(-1).type, 'tools-unavailable');
  assert.match(events.at(-1).reason, /does not support tools/);

  const none = await askWithOptionalTools({ llm: broken, system: 'SYS', messages: [], tools: null });
  assert.deepEqual({ text: none.text, toolsFailed: none.toolsFailed }, { text: 'plain:true', toolsFailed: false });
});

test('OpenAI conversion: tool definitions, tool calls, results and broken argument JSON', () => {
  assert.deepEqual(toOpenAITools([echoTool()]), [{ type: 'function', function: { name: 'echo', description: 'Echo the value back', parameters: echoTool().parameters } }]);

  const wire = toOpenAIMessages('SYS', [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', toolCalls: [callOf('c1', 'echo', { value: 'a' })] },
    { role: 'tool', toolCallId: 'c1', name: 'echo', content: 'echo:a' },
  ]);
  assert.deepEqual(wire[0], { role: 'system', content: 'SYS' });
  assert.deepEqual(wire[2].tool_calls, [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"value":"a"}' } }]);
  assert.equal(wire[2].content, null);
  assert.deepEqual(wire[3], { role: 'tool', tool_call_id: 'c1', content: 'echo:a' });

  const parsed = fromOpenAIMessage({
    content: null,
    tool_calls: [
      { id: 'a', type: 'function', function: { name: 'echo', arguments: '{"value": "ok"}' } },
      { id: 'b', type: 'function', function: { name: 'echo', arguments: "{'value': 'fixed',}" } },
      { id: 'c', type: 'function', function: { name: 'echo', arguments: 'not json at all' } },
      { id: 'd', type: 'function', function: { name: 'echo', arguments: '' } },
    ],
  });
  assert.equal(parsed.text, '');
  assert.deepEqual(parsed.toolCalls[0].args, { value: 'ok' });
  assert.deepEqual(parsed.toolCalls[1].args, { value: 'fixed' });
  assert.ok(parsed.toolCalls[2].argsError);
  assert.deepEqual(parsed.toolCalls[3].args, {});
});

test('Anthropic conversion: results for one turn are merged into a single user message', () => {
  assert.deepEqual(toAnthropicTools([echoTool()]), [{ name: 'echo', description: 'Echo the value back', input_schema: echoTool().parameters }]);

  const wire = toAnthropicMessages([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'looking', toolCalls: [callOf('t1', 'echo', { value: 'a' }), callOf('t2', 'echo', { value: 'b' })] },
    { role: 'tool', toolCallId: 't1', name: 'echo', content: 'echo:a' },
    { role: 'tool', toolCallId: 't2', name: 'echo', content: 'echo:b' },
    { role: 'user', content: 'now answer' },
  ]);
  assert.equal(wire.length, 4);
  assert.deepEqual(wire[1].content, [
    { type: 'text', text: 'looking' },
    { type: 'tool_use', id: 't1', name: 'echo', input: { value: 'a' } },
    { type: 'tool_use', id: 't2', name: 'echo', input: { value: 'b' } },
  ]);
  assert.deepEqual(wire[2], {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'echo:a' },
      { type: 'tool_result', tool_use_id: 't2', content: 'echo:b' },
    ],
  });
  assert.deepEqual(wire[3], { role: 'user', content: 'now answer' });

  const noText = toAnthropicMessages([{ role: 'assistant', content: '', toolCalls: [callOf('t', 'echo', {})] }]);
  assert.equal(noText[0].content[0].type, 'tool_use');

  assert.deepEqual(
    fromAnthropicContent([{ type: 'text', text: 'hi ' }, { type: 'tool_use', id: 'z', name: 'echo', input: { value: 'q' } }, { type: 'text', text: 'there' }]),
    { text: 'hi there', toolCalls: [{ id: 'z', name: 'echo', args: { value: 'q' } }] }
  );
});

const HUNK_TEXT = ['<<<<<<< HEAD', 'const a = 1;', '||||||| base', 'const a = 0;', '=======', 'const a = 2;', '>>>>>>> feature'].join('\n');

test('Conflict Agent can use tools, reports what it called, and keeps the same safeguards', async () => {
  const [hunk] = parseConflictHunks(HUNK_TEXT);
  const llm = scriptedLlm([
    { text: '', toolCalls: [callOf('1', 'echo', { value: 'look' })] },
    { text: '{"resolution": "const a = 1;", "confidence": "high", "ambiguous": false}', toolCalls: [] },
  ]);
  const events = [];
  const proposal = await proposeResolution({ llm, file: 'a.js', fileText: HUNK_TEXT, hunk, tools: [echoTool()], onToolEvent: (e) => events.push(e.type) });

  assert.deepEqual(proposal.toolCalls, [{ name: 'echo', args: { value: 'look' }, ok: true }]);
  assert.deepEqual(events, ['tool-call']);
  assert.match(llm.requests[0].system, /read-only tools/);
  assert.equal(proposal.needsApproval, true, 'keeping only one side is still flagged');
});

test('Conflict Agent falls back to a plain request, once, when the model cannot use tools', async () => {
  const [hunk] = parseConflictHunks(HUNK_TEXT);
  let chatCalls = 0;
  const replies = ['not json', '{"resolution": "const a = 3;", "confidence": "high", "ambiguous": false}'];
  const llm = {
    chat: async () => { chatCalls += 1; throw new Error('this model does not support tools'); },
    complete: async () => replies.shift(),
  };
  const events = [];
  const proposal = await proposeResolution({ llm, file: 'a.js', fileText: HUNK_TEXT, hunk, tools: [echoTool()], onToolEvent: (e) => events.push(e.type) });

  assert.equal(proposal.resolution, 'const a = 3;');
  assert.equal(chatCalls, 1, 'the JSON retry must not try tools again');
  assert.deepEqual(events, ['tools-unavailable']);
  assert.deepEqual(proposal.toolCalls, []);
});

test('Intent Agent can look closer at commits with the tools it is given', async () => {
  const evidence = {
    operation: 'merge',
    files: ['f.txt'],
    ours: { label: 'main', commits: [] },
    theirs: { label: 'feature', commits: [] },
  };
  const llm = scriptedLlm([
    { text: '', toolCalls: [callOf('1', 'echo', { value: 'abc1234' })] },
    { text: '{"ours": "fast", "theirs": "slow networks", "relationship": "opposite"}', toolCalls: [] },
  ]);
  const intent = await summarizeIntent({ llm, evidence, tools: [echoTool()] });
  assert.equal(intent.theirs.summary, 'slow networks');
  assert.equal(llm.requests.length, 2);
});
