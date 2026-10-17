import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelListError, listAnthropicModels, listOllamaModels, listOpenAIModels, ollamaOrigin } from '../src/llm/models.js';
import { testModel } from '../src/llm/testConnection.js';
import {
  FALLBACK_MODELS, PROVIDER_CHOICES, describeModel, explainModelError, formatBytes, isSafeModelName, modelProblem,
  modelStatus, ollamaHasModel, pullCommand, rankOpenAIModels, savedMessage,
} from '../src/ui/viewmodel/modelSetup.js';

// A fetch that records what it was asked and answers from a script.
const fakeFetch = (reply) => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    const answer = typeof reply === 'function' ? await reply(String(url), init) : reply;
    if (answer instanceof Error) throw answer;
    return { status: answer.status ?? 200, ok: (answer.status ?? 200) < 400, json: async () => { if (answer.badJson) throw new SyntaxError('x'); return answer.body; } };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
};
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });

test('Ollama models are listed from its own address, whichever form of the address was given', async () => {
  assert.equal(ollamaOrigin(''), 'http://localhost:11434');
  assert.equal(ollamaOrigin('http://localhost:11434/v1'), 'http://localhost:11434');
  assert.equal(ollamaOrigin('http://10.0.0.5:9999/'), 'http://10.0.0.5:9999');
  assert.throws(() => ollamaOrigin('ftp://x'), { code: 'bad-url' });
  assert.throws(() => ollamaOrigin('not a url'), { code: 'bad-url' });

  const fetchImpl = fakeFetch({ body: { models: [{ name: 'llama3.1:latest', size: 4_900_000_000 }, { name: 'qwen2.5-coder:7b' }, { nope: 1 }] } });
  const models = await listOllamaModels({ baseUrl: 'http://localhost:11434/v1', fetch: fetchImpl });
  assert.deepEqual(models, [{ name: 'llama3.1:latest', sizeBytes: 4_900_000_000 }, { name: 'qwen2.5-coder:7b', sizeBytes: undefined }]);
  assert.equal(fetchImpl.calls[0].url, 'http://localhost:11434/api/tags');
});

test('a server that is not running, is not Ollama, or is slow is told apart', async () => {
  await assert.rejects(listOllamaModels({ fetch: fakeFetch(refused()) }), { name: 'ModelListError', code: 'unreachable', cause: 'ECONNREFUSED' });
  await assert.rejects(listOllamaModels({ fetch: fakeFetch({ body: { hello: 'world' } }) }), { code: 'bad-response' });
  await assert.rejects(listOllamaModels({ fetch: fakeFetch({ badJson: true }) }), { code: 'bad-response' });
  await assert.rejects(listOllamaModels({ fetch: fakeFetch({ status: 500 }) }), { code: 'http', status: 500 });

  const hangs = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  await assert.rejects(listOllamaModels({ fetch: fakeFetch(hangs), timeoutMs: 80 }), { code: 'timeout' });
});

test('a caller who cancels is not told the server was unreachable', async () => {
  const controller = new AbortController();
  const hangs = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))));
  const pending = listOllamaModels({ fetch: fakeFetch(hangs), timeoutMs: 5000, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('OpenAI-style models are listed with the key in a header only, and a rejected key is reported as such', async () => {
  const ok = fakeFetch({ body: { data: [{ id: 'gpt-4o' }, { id: 'text-embedding-3-small' }, { id: 'gpt-4o-mini' }, { nope: true }] } });
  const ids = await listOpenAIModels({ apiKey: 'sk-secret-123456', fetch: ok });
  assert.deepEqual(ids, ['gpt-4o', 'gpt-4o-mini', 'text-embedding-3-small']);
  assert.equal(ok.calls[0].url, 'https://api.openai.com/v1/models');
  assert.equal(ok.calls[0].headers.Authorization, 'Bearer sk-secret-123456');
  assert.ok(!ok.calls[0].url.includes('sk-secret'), 'the key is never put in the address');

  const custom = fakeFetch({ body: { data: [{ id: 'my-model' }] } });
  await listOpenAIModels({ baseUrl: 'http://localhost:1234/v1/', fetch: custom });
  assert.equal(custom.calls[0].url, 'http://localhost:1234/v1/models');
  assert.deepEqual(custom.calls[0].headers, {}, 'no key, no header');

  for (const status of [401, 403]) {
    await assert.rejects(listOpenAIModels({ apiKey: 'sk-secret-123456', fetch: fakeFetch({ status }) }), (error) => {
      assert.equal(error.code, 'unauthorized');
      assert.ok(!error.message.includes('sk-secret'), 'the key never appears in an error');
      return true;
    });
  }
  await assert.rejects(listOpenAIModels({ fetch: fakeFetch({ body: { object: 'list' } }) }), { code: 'bad-response' });
  await assert.rejects(listOpenAIModels({ baseUrl: 'javascript:alert(1)', fetch: fakeFetch({}) }), { code: 'bad-url' });
});

test('Anthropic models use its own headers and keep the order the service gives (newest first)', async () => {
  const fetchImpl = fakeFetch({ body: { data: [{ id: 'claude-b' }, { id: 'claude-a' }] } });
  assert.deepEqual(await listAnthropicModels({ apiKey: 'sk-ant-secret-1', fetch: fetchImpl }), ['claude-b', 'claude-a']);
  assert.match(fetchImpl.calls[0].url, /^https:\/\/api\.anthropic\.com\/v1\/models/);
  assert.equal(fetchImpl.calls[0].headers['x-api-key'], 'sk-ant-secret-1');
  assert.equal(fetchImpl.calls[0].headers['anthropic-version'], '2023-06-01');
  await assert.rejects(listAnthropicModels({ apiKey: 'bad', fetch: fakeFetch({ status: 401 }) }), { code: 'unauthorized' });
});

test('the connection test sends one tiny request through the real client path and reports the time', async () => {
  const seen = [];
  const createClient = (env) => ({ complete: async (request) => { seen.push({ env, request }); return ' OK \n'; } });
  const env = { PROVIDER: 'ollama', LLM_MODEL: 'llama3.1' };
  const result = await testModel({ env, createClient });
  assert.equal(result.ok, true);
  assert.equal(result.reply, 'OK');
  assert.ok(result.ms >= 0);
  assert.equal(seen[0].env, env);
  assert.match(seen[0].request.system, /connection test/);
  assert.equal(seen[0].request.messages.length, 1);
  assert.equal(seen[0].request.messages[0].content, 'ping', 'no repository code is involved');
  assert.ok(seen[0].request.signal);
});

test('the connection test turns silence into a timeout error and passes provider errors through', async () => {
  const silent = () => ({ complete: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  await assert.rejects(testModel({ env: {}, createClient: silent, timeoutMs: 80 }), { code: 'TEST_TIMEOUT' });

  const unauthorized = () => ({ complete: async () => { throw Object.assign(new Error('401 invalid x-api-key'), { status: 401 }); } });
  await assert.rejects(testModel({ env: {}, createClient: unauthorized }), { status: 401 });

  const controller = new AbortController();
  const waits = () => ({ complete: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' })))) });
  const pending = testModel({ env: {}, createClient: waits, timeoutMs: 5000, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('the four ways to choose where the AI runs are offered, with honest descriptions', () => {
  assert.deepEqual(PROVIDER_CHOICES.map((c) => c.id), ['ollama', 'openai', 'anthropic', 'compatible']);
  assert.match(PROVIDER_CHOICES[0].description, /never leaves this machine/);
  assert.match(PROVIDER_CHOICES[1].description, /sent to OpenAI/);
  assert.match(PROVIDER_CHOICES[2].description, /sent to Anthropic/);
});

test('OpenAI model lists are reduced to chat models with the usual choices first', () => {
  const ranked = rankOpenAIModels(['text-embedding-3-small', 'gpt-4o', 'whisper-1', 'gpt-4o-mini', 'gpt-4o-audio-preview', 'o3-mini', 'dall-e-3', 'gpt-3.5-turbo-instruct', 'gpt-4.1', 'gpt-4o']);
  assert.deepEqual(ranked.slice(0, 2), ['gpt-4o-mini', 'gpt-4o']);
  assert.ok(ranked.includes('gpt-4.1') && ranked.includes('o3-mini'));
  assert.ok(!ranked.some((id) => /embedding|whisper|dall-e|audio|instruct/.test(id)));
  assert.equal(new Set(ranked).size, ranked.length, 'no duplicates');
  assert.ok(FALLBACK_MODELS.openai.length > 0 && FALLBACK_MODELS.anthropic.length > 0);
});

test('Ollama model matching accepts the ":latest" form and nothing looser', () => {
  const installed = [{ name: 'llama3.1:latest' }, { name: 'qwen2.5-coder:7b' }];
  assert.equal(ollamaHasModel(installed, 'llama3.1'), true);
  assert.equal(ollamaHasModel(installed, 'llama3.1:latest'), true);
  assert.equal(ollamaHasModel(installed, 'qwen2.5-coder:7b'), true);
  assert.equal(ollamaHasModel(installed, 'qwen2.5-coder'), false, 'a different tag is a different download');
  assert.equal(ollamaHasModel(installed, 'llama3'), false);
  assert.equal(ollamaHasModel(installed, ''), false);
  assert.equal(ollamaHasModel([], 'llama3.1'), false);
});

test('only plain model names can end up in a command the user is asked to run', () => {
  assert.equal(pullCommand('llama3.1'), 'ollama pull llama3.1');
  assert.equal(pullCommand('hf.co/user/model:Q4_K_M'), 'ollama pull hf.co/user/model:Q4_K_M');
  for (const bad of ['llama3; rm -rf /', 'a b', '$(calc)', '`x`', '-rf', '', 'x'.repeat(200), 'a|b', 'a&b', null]) {
    assert.equal(pullCommand(bad), null, String(bad));
    assert.equal(isSafeModelName(bad), false);
  }
  assert.equal(formatBytes(4_900_000_000), '4.6 GB');
  assert.equal(formatBytes(300 * 1024 * 1024), '300 MB');
  assert.equal(formatBytes(undefined), '');
});

test('errors are explained in plain words with the fix that applies to the provider', () => {
  const cases = [
    [Object.assign(new ModelListError('unreachable', 'x'), {}), { provider: 'ollama', model: 'llama3.1' }, 'start-ollama', /Ollama is not running at http:\/\/localhost:11434/],
    [Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' }), { provider: 'ollama', baseUrl: 'http://10.0.0.5:9999/v1' }, 'start-ollama', /10\.0\.0\.5:9999/],
    [Object.assign(new Error('x'), { code: 'unreachable' }), { provider: 'openai', baseUrl: 'http://localhost:1234/v1' }, 'check-address', /Could not reach localhost:1234/],
    [Object.assign(new Error('401'), { status: 401 }), { provider: 'openai' }, 'check-key', /OpenAI rejected the key/],
    [new ModelListError('unauthorized', 'x'), { provider: 'anthropic' }, 'check-key', /Claude \(Anthropic\) rejected the key/],
    [Object.assign(new Error('404 model "llama9" not found'), { status: 404 }), { provider: 'ollama', model: 'llama9' }, 'pull-model', /Ollama does not have "llama9"[\s\S]*/],
    [Object.assign(new Error('The model `gpt-9` does not exist'), { status: 404 }), { provider: 'openai', model: 'gpt-9' }, 'check-model', /does not know a model called "gpt-9"/],
    [Object.assign(new Error('rate'), { status: 429 }), { provider: 'openai' }, 'billing', /refusing requests/],
    [Object.assign(new Error('slow'), { code: 'TEST_TIMEOUT' }), { provider: 'ollama' }, 'wait-and-retry', /No answer yet/],
    [Object.assign(new Error('boom'), { status: 503 }), { provider: 'anthropic' }, 'wait-and-retry', /had a problem \(503\)/],
    [new ModelListError('bad-response', 'That server does not look like Ollama.'), { provider: 'ollama' }, 'check-address', /did not answer as expected/],
    [new Error('something odd'), { provider: 'openai' }, null, /The test did not work/],
  ];
  for (const [error, context, action, title] of cases) {
    const explained = explainModelError(error, context);
    assert.equal(explained.action, action, `${error.message} -> ${explained.title}`);
    assert.match(explained.title, title);
    assert.ok(explained.detail.length > 10);
  }
  assert.match(explainModelError(Object.assign(new Error('x'), { status: 404 }), { provider: 'ollama', model: 'llama9' }).detail, /ollama pull llama9/);
  assert.doesNotMatch(explainModelError(Object.assign(new Error('x'), { status: 404 }), { provider: 'ollama', model: 'a; rm -rf /' }).detail, /ollama pull/, 'an unsafe name is never shown as a command');
});

test('the current model is summarised, and missing pieces are named', () => {
  assert.equal(describeModel({ provider: 'ollama', model: 'llama3.1', baseUrl: '' }), 'Ollama - llama3.1');
  assert.equal(describeModel({ provider: 'anthropic', model: 'claude-sonnet-5', baseUrl: '' }), 'Claude (Anthropic) - claude-sonnet-5');
  assert.equal(describeModel({ provider: 'openai', model: 'my-model', baseUrl: 'http://localhost:1234/v1' }), 'OpenAI-compatible server (localhost:1234) - my-model');
  assert.equal(describeModel({ provider: 'ollama', model: '', baseUrl: '' }), 'Ollama - no model chosen');

  const local = { provider: 'ollama', model: 'llama3.1', baseUrl: '', jsonMode: true };
  assert.equal(modelProblem(local, ''), null);
  assert.equal(modelStatus(local, '').ready, true);
  assert.equal(modelStatus(local, '').where, null);

  const cloud = { provider: 'openai', model: 'gpt-4o-mini', baseUrl: '', jsonMode: true };
  assert.match(modelProblem(cloud, ''), /needs an API key/);
  assert.equal(modelStatus(cloud, '').ready, false);
  assert.equal(modelStatus(cloud, 'sk-xxxxxxxx').ready, true);
  assert.match(modelStatus(cloud, 'sk-xxxxxxxx').where, /OpenAI/);
});

test('the saved message says where code goes, and that local models keep it on this machine', () => {
  const local = savedMessage({ provider: 'ollama', model: 'llama3.1', baseUrl: '' }, 1234);
  assert.match(local, /^Connected to Ollama - llama3\.1\. It answered in 1\.2 s\./);
  assert.match(local, /your code stays here/);
  const cloud = savedMessage({ provider: 'anthropic', model: 'claude-sonnet-5', baseUrl: '' }, undefined);
  assert.doesNotMatch(cloud, /answered in/);
  assert.match(cloud, /the conflicting code is sent to Anthropic \(api\.anthropic\.com\); you will be asked to confirm before the first run/);
});
