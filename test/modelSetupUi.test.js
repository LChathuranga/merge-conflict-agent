import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeVscode } from '../test-support/fakeVscode.js';
import { activateWith } from '../src/ui/vscode/activate.js';
import { json, network, refused } from '../test-support/network.js';

// ---- pretend network and pretend model ------------------------------------------------------

const OLLAMA_URL = 'http://localhost:11434/api/tags';
const ollamaWith = (...names) => json({ models: names.map((name) => ({ name, size: 4_900_000_000 })) });
const OPENAI_URL = 'https://api.openai.com/v1/models';
const openaiWith = (...ids) => json({ data: ids.map((id) => ({ id })) });
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/models';
const anthropicWith = (...ids) => json({ data: ids.map((id) => ({ id })) });

// A model client that records how it was built and answers like a healthy model, or fails on cue.
const model = (behaviour = 'ok') => {
  const built = [];
  return {
    built,
    createClient: (env) => {
      built.push(env);
      return {
        complete: async () => {
          if (behaviour === 'ok') return 'OK';
          if (behaviour === 'unauthorized') throw Object.assign(new Error('401 invalid api key'), { status: 401 });
          if (behaviour === 'missing-model') throw Object.assign(new Error('404 model not found'), { status: 404 });
          if (behaviour === 'refused') throw Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' });
          if (typeof behaviour === 'function') return behaviour(built.length);
          throw new Error(String(behaviour));
        },
      };
    },
  };
};

const KEY = 'sk-test-0123456789abcdef';
const providerItem = (id) => ({ id, label: id });

const open = async ({ settings = {}, fetchImpl, client = model(), workspaceValues } = {}) => {
  const fake = createFakeVscode({ folders: [], settings, workspaceValues });
  const context = fake.context();
  const api = await activateWith(fake.vscode, context, { debounceMs: 20, createClient: client.createClient, fetchImpl });
  return { fake, context, api, client, run: () => fake.commands.get('mergeAssistant.setUpModel')(), secret: (slot) => context.secretValues.get(`mergeAssistant.apiKey.${slot}`) };
};
const updates = (fake) => Object.fromEntries(fake.callsOf('config.update').map((c) => [c.key, c.value]));
const everything = (fake) => JSON.stringify([fake.calls.map((c) => ({ ...c, items: undefined, options: c.options && { title: c.options.title, prompt: c.options.prompt } })), [...fake.outputs.values()].map((o) => o.lines)]);

// ---- Ollama ---------------------------------------------------------------------------------

test('Ollama: the installed models are listed, the choice is tested, then saved, and no key is involved', async () => {
  const net = network({ [OLLAMA_URL]: ollamaWith('llama3.1:latest', 'qwen2.5-coder:7b') });
  const { fake, client, run, context } = await open({ fetchImpl: net });
  fake.script.quickPick.push(providerItem('ollama'), { model: 'qwen2.5-coder:7b' });
  await run();

  const modelPicker = fake.callsOf('quickPick')[1];
  assert.deepEqual(modelPicker.items.filter((i) => i.model).map((i) => `${i.label} ${i.description}`), ['llama3.1:latest 4.6 GB', 'qwen2.5-coder:7b 4.6 GB']);
  assert.ok(modelPicker.items.some((i) => i.typeIt), 'a model that is not listed can still be typed');
  assert.match(fake.callsOf('quickPick')[0].options.title, /^Set Up AI Model \(1\/3\)/);
  assert.match(modelPicker.options.title, /\(2\/3\)/);

  assert.deepEqual(client.built, [{ PROVIDER: 'ollama', LLM_MODEL: 'qwen2.5-coder:7b', JSON_MODE: 'true' }], 'tested exactly what will be saved, with no key');
  assert.deepEqual(updates(fake), { provider: 'ollama', model: 'qwen2.5-coder:7b', baseUrl: '' });
  assert.equal(context.secretValues.size, 0, 'nothing is stored as a key');
  assert.match(fake.messages('information').at(-1), /^Connected to Ollama - qwen2\.5-coder:7b\. It answered in [\d.]+ s\. It runs on your machine, so your code stays here\./);
});

test('Ollama not running: the problem and the fix are explained, and Try Again works once it is started', async () => {
  const net = network({ [OLLAMA_URL]: (n) => (n === 1 ? refused() : ollamaWith('llama3.1:latest')) });
  const { fake, run } = await open({ fetchImpl: net });
  fake.script.quickPick.push(providerItem('ollama'), { model: 'llama3.1:latest' });
  fake.script.warning.push('Try Again');
  await run();

  const warning = fake.callsOf('warning')[0];
  assert.equal(warning.message, 'Ollama is not running at http://localhost:11434');
  assert.equal(warning.rest[0].modal, true);
  assert.match(warning.rest[0].detail, /ollama serve/);
  assert.match(warning.rest[0].detail, /ollama\.com/);
  assert.deepEqual(warning.rest.slice(1), ['Try Again', 'Use a Different Address']);
  assert.equal(updates(fake).model, 'llama3.1:latest');
});

test('Ollama on another machine: the address is checked, stored in the form the client needs, and used for the test', async () => {
  const net = network({ 'http://10.0.0.5:9999/api/tags': ollamaWith('llama3.1:latest') });
  const { fake, client, run } = await open({ fetchImpl: net });
  fake.script.quickPick.push(providerItem('ollama'), { model: 'llama3.1:latest' });
  fake.script.warning.push('Use a Different Address');
  fake.script.inputBox.push('http://10.0.0.5:9999');
  await run();

  const ask = fake.callsOf('inputBox')[0].options;
  assert.equal(ask.validateInput('ftp://x'), 'Use an address that starts with http:// or https://');
  assert.match(ask.validateInput('nonsense'), /Enter a full address/);
  assert.equal(ask.validateInput('http://10.0.0.5:9999'), undefined);
  assert.equal(updates(fake).baseUrl, 'http://10.0.0.5:9999/v1');
  assert.equal(client.built[0].BASE_URL, 'http://10.0.0.5:9999/v1');
});

test('Ollama with no models: how to get one is shown, the command is copied, and retrying then works', async () => {
  const net = network({ [OLLAMA_URL]: (n) => (n === 1 ? ollamaWith() : ollamaWith('llama3.1:latest')) });
  const { fake, run } = await open({ fetchImpl: net });
  fake.script.quickPick.push(providerItem('ollama'), { model: 'llama3.1:latest' });
  fake.script.warning.push('Copy Command', 'Try Again');
  await run();
  assert.equal(fake.callsOf('warning')[0].message, 'Ollama is running, but it has no models yet.');
  assert.equal(fake.vscode.env.clipboard.text, 'ollama pull llama3.1');
  assert.equal(updates(fake).model, 'llama3.1:latest');
});

test('Ollama: a typed model that is not downloaded is flagged with the command to get it', async () => {
  const net = network({ [OLLAMA_URL]: ollamaWith('llama3.1:latest') });
  const { fake, run } = await open({ fetchImpl: net });
  fake.script.quickPick.push(providerItem('ollama'), { typeIt: true });
  fake.script.inputBox.push('  mistral  ');
  fake.script.warning.push('Use It Anyway');
  await run();

  const typed = fake.callsOf('inputBox')[0].options;
  assert.equal(typed.validateInput('bad name; rm -rf /'), 'Use letters, digits and . : - _ / only, starting with a letter or digit.');
  assert.equal(typed.validateInput('mistral'), undefined);
  const warning = fake.callsOf('warning')[0];
  assert.equal(warning.message, 'Ollama does not have "mistral" yet.');
  assert.match(warning.rest[0].detail, /ollama pull mistral/);
  assert.equal(updates(fake).model, 'mistral');
});

// ---- OpenAI and Claude ----------------------------------------------------------------------

test('OpenAI: the key is checked by listing models, chat models are offered, and the key goes to secret storage only', async () => {
  const net = network({ [OPENAI_URL]: openaiWith('gpt-4o', 'text-embedding-3-small', 'gpt-4o-mini', 'whisper-1') });
  const { fake, client, run, secret, context } = await open({ fetchImpl: net });
  fake.script.quickPick.push(providerItem('openai'), { model: 'gpt-4o-mini' });
  fake.script.inputBox.push(KEY);
  await run();

  const keyBox = fake.callsOf('inputBox')[0].options;
  assert.equal(keyBox.password, true, 'the key is masked while typing');
  assert.equal(keyBox.validateInput('short'), 'That does not look like an API key.');
  assert.match(keyBox.prompt, /secret storage on this computer, never in a settings file or the log/);

  assert.deepEqual(fake.callsOf('quickPick')[1].items.filter((i) => i.model).map((i) => i.label), ['gpt-4o-mini', 'gpt-4o'], 'embeddings and speech models are not offered');
  assert.equal(net.calls[0].headers.Authorization, `Bearer ${KEY}`);
  assert.equal(client.built[0].API_KEY, KEY);
  assert.deepEqual(updates(fake), { provider: 'openai', model: 'gpt-4o-mini', baseUrl: '' });
  assert.equal(secret('openai'), KEY);
  assert.ok(!everything(fake).includes(KEY), 'the key is in no message, prompt record or log');
  assert.ok(![...context.secretValues.keys()].some((k) => k.includes(KEY)));
  assert.match(fake.messages('information').at(-1), /the conflicting code is sent to OpenAI \(api\.openai\.com\); you will be asked to confirm before the first run/);
});

test('OpenAI: a rejected key is said so plainly, and a second try can succeed', async () => {
  const net = network({ [OPENAI_URL]: (n) => (n === 1 ? json({}, 401) : openaiWith('gpt-4o-mini')) });
  const { fake, run, secret } = await open({ fetchImpl: net });
  fake.script.quickPick.push(providerItem('openai'), { model: 'gpt-4o-mini' });
  fake.script.inputBox.push('sk-wrong-0123456789', KEY);
  fake.script.warning.push('Enter the Key Again');
  await run();

  assert.equal(fake.callsOf('warning')[0].message, 'OpenAI rejected the key');
  assert.equal(fake.callsOf('inputBox').length, 2);
  assert.equal(secret('openai'), KEY);
  assert.ok(!everything(fake).includes('sk-wrong-0123456789'));
});

test('a saved key can be reused, and a different one entered instead', async () => {
  const net = network({ [OPENAI_URL]: openaiWith('gpt-4o-mini') });
  const first = await open({ fetchImpl: net });
  first.context.secretValues.set('mergeAssistant.apiKey.openai', KEY);
  first.fake.script.quickPick.push(providerItem('openai'), { use: true }, { model: 'gpt-4o-mini' });
  await first.run();
  assert.equal(first.fake.callsOf('inputBox').length, 0, 'no typing when the saved key is reused');
  assert.match(first.fake.callsOf('quickPick')[1].items[0].label, /^Use the saved key \(ends in cdef\)$/);
  assert.equal(net.calls[0].headers.Authorization, `Bearer ${KEY}`);

  const second = await open({ fetchImpl: network({ [OPENAI_URL]: openaiWith('gpt-4o-mini') }) });
  second.context.secretValues.set('mergeAssistant.apiKey.openai', KEY);
  second.fake.script.quickPick.push(providerItem('openai'), { use: false }, { model: 'gpt-4o-mini' });
  second.fake.script.inputBox.push('sk-new-0123456789abcdef');
  await second.run();
  assert.equal(second.secret('openai'), 'sk-new-0123456789abcdef');
});

test('OpenAI when the list cannot be fetched: the model name can still be typed', async () => {
  const net = network({ [OPENAI_URL]: refused() });
  const { fake, run, secret } = await open({ fetchImpl: net });
  fake.script.quickPick.push(providerItem('openai'), { typeIt: true });
  fake.script.inputBox.push(KEY, 'gpt-4o');
  fake.script.warning.push('Type a Model Name');
  await run();

  assert.match(fake.callsOf('warning')[0].message, /Could not get the list of OpenAI models/);
  const offered = fake.callsOf('quickPick')[1].items.filter((i) => i.model).map((i) => i.model);
  assert.deepEqual(offered, ['gpt-4o-mini', 'gpt-4o'], 'known names are suggested');
  assert.equal(updates(fake).model, 'gpt-4o');
  assert.equal(secret('openai'), KEY);
});

test('Claude: models come from Anthropic in its own order, and the key is stored for the anthropic provider', async () => {
  const net = network({ [ANTHROPIC_URL]: anthropicWith('claude-newest', 'claude-older') });
  const { fake, client, run, secret } = await open({ fetchImpl: net });
  fake.script.quickPick.push(providerItem('anthropic'), { model: 'claude-newest' });
  fake.script.inputBox.push('sk-ant-test-0123456789');
  await run();

  assert.deepEqual(fake.callsOf('quickPick')[1].items.filter((i) => i.model).map((i) => i.label), ['claude-newest', 'claude-older']);
  assert.equal(net.calls[0].headers['x-api-key'], 'sk-ant-test-0123456789');
  assert.equal(client.built[0].PROVIDER, 'anthropic');
  assert.deepEqual(updates(fake), { provider: 'anthropic', model: 'claude-newest', baseUrl: '' });
  assert.equal(secret('anthropic'), 'sk-ant-test-0123456789');
});

// ---- another OpenAI-compatible server -------------------------------------------------------

test('another server: its key is kept apart from the real OpenAI key, which is never sent there or changed', async () => {
  const net = network({ 'http://localhost:1234/v1/models': openaiWith('my-local-model') });
  const { fake, client, run, secret, context } = await open({ fetchImpl: net });
  context.secretValues.set('mergeAssistant.apiKey.openai', 'sk-REAL-openai-key-0000');
  fake.script.quickPick.push(providerItem('compatible'), { model: 'my-local-model' });
  fake.script.inputBox.push('http://localhost:1234/v1', ''); // address, then no key
  await run();

  assert.equal(net.calls[0].headers.Authorization, undefined, 'no key was sent to the other server');
  assert.ok(!JSON.stringify(net.calls).includes('sk-REAL'));
  assert.equal(secret('openai'), 'sk-REAL-openai-key-0000', 'the OpenAI key is untouched');
  assert.equal(secret('openai@localhost:1234'), 'not-needed', 'this server has its own placeholder key');
  assert.deepEqual(updates(fake), { provider: 'openai', model: 'my-local-model', baseUrl: 'http://localhost:1234/v1' });
  assert.equal(client.built[0].BASE_URL, 'http://localhost:1234/v1');
  assert.match(fake.messages('information').at(-1), /^Connected to OpenAI-compatible server \(localhost:1234\) - my-local-model\./);
  assert.match(fake.messages('information').at(-1), /your code stays here/, 'a server on this machine keeps code on this machine');
});

test('another server with a key: the key goes to that address only, and an unreachable server offers to change it', async () => {
  const net = network({ 'http://gateway.corp/v1/models': (n) => (n === 1 ? refused() : openaiWith('corp-model')) });
  const { fake, run, secret } = await open({ fetchImpl: net });
  fake.script.quickPick.push(providerItem('compatible'), { model: 'corp-model' });
  fake.script.inputBox.push('http://gateway.corp/v1', 'corp-key-0123456789', 'http://gateway.corp/v1', 'corp-key-0123456789');
  fake.script.warning.push('Change Address');
  await run();
  assert.match(fake.callsOf('warning')[0].message, /Could not reach gateway\.corp/);
  assert.equal(secret('openai@gateway.corp'), 'corp-key-0123456789');
  assert.ok(!everything(fake).includes('corp-key-0123456789'));
});

// ---- the test comes before saving -----------------------------------------------------------

test('a failed test saves nothing, explains why, and Change Settings returns to the start', async () => {
  const net = network({ [OPENAI_URL]: openaiWith('gpt-4o-mini'), [OLLAMA_URL]: ollamaWith('llama3.1:latest') });
  const failingThenFine = model((n) => (n === 1 ? (() => { throw Object.assign(new Error('401'), { status: 401 }); })() : 'OK'));
  const { fake, run, secret } = await open({ fetchImpl: net, client: failingThenFine });
  fake.script.quickPick.push(providerItem('openai'), { model: 'gpt-4o-mini' }, providerItem('ollama'), { model: 'llama3.1:latest' });
  fake.script.inputBox.push(KEY);
  fake.script.warning.push('Change Settings');
  await run();

  const failure = fake.callsOf('warning')[0];
  assert.equal(failure.message, 'OpenAI rejected the key');
  assert.match(failure.rest[0].detail, /Nothing has been saved yet\./);
  assert.deepEqual(failure.rest.slice(1), ['Try Again', 'Change Settings', 'Save Anyway']);
  assert.equal(secret('openai'), undefined, 'the rejected key was never saved');
  assert.deepEqual(updates(fake), { provider: 'ollama', model: 'llama3.1:latest', baseUrl: '' }, 'only the second, working choice was saved');
});

test('Try Again repeats only the test; Save Anyway keeps the setup and says the test failed', async () => {
  const net = network({ [OLLAMA_URL]: ollamaWith('llama3.1:latest') });
  const flaky = model((n) => (n === 1 ? (() => { throw Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' }); })() : 'OK'));
  const retry = await open({ fetchImpl: net, client: flaky });
  retry.fake.script.quickPick.push(providerItem('ollama'), { model: 'llama3.1:latest' });
  retry.fake.script.warning.push('Try Again');
  await retry.run();
  assert.equal(retry.fake.callsOf('quickPick').length, 2, 'no questions were asked again');
  assert.equal(retry.client.built.length, 2);
  assert.equal(updates(retry.fake).model, 'llama3.1:latest');

  const stubborn = await open({ fetchImpl: net, client: model('refused') });
  stubborn.fake.script.quickPick.push(providerItem('ollama'), { model: 'llama3.1:latest' });
  stubborn.fake.script.warning.push('Save Anyway');
  await stubborn.run();
  assert.equal(updates(stubborn.fake).model, 'llama3.1:latest');
  assert.match(stubborn.fake.messages('warning').at(-1), /^Saved Ollama - llama3\.1:latest, but the test did not work: Ollama is not running/);
});

test('a missing model is explained for Ollama and for the cloud providers differently', async () => {
  const net = network({ [OLLAMA_URL]: ollamaWith('llama3.1:latest'), [OPENAI_URL]: openaiWith('gpt-4o-mini') });
  const local = await open({ fetchImpl: net, client: model('missing-model') });
  local.fake.script.quickPick.push(providerItem('ollama'), { model: 'llama3.1:latest' });
  await local.run();
  assert.match(local.fake.callsOf('warning')[0].rest[0].detail, /ollama pull llama3\.1:latest/);

  const cloud = await open({ fetchImpl: net, client: model('missing-model') });
  cloud.fake.script.quickPick.push(providerItem('openai'), { model: 'gpt-4o-mini' });
  cloud.fake.script.inputBox.push(KEY);
  await cloud.run();
  assert.match(cloud.fake.callsOf('warning')[0].message, /OpenAI does not know a model called "gpt-4o-mini"/);
});

// ---- backing out, and where settings are written --------------------------------------------

test('backing out at any step saves nothing', async () => {
  const net = network({ [OLLAMA_URL]: ollamaWith('llama3.1:latest'), [OPENAI_URL]: openaiWith('gpt-4o-mini'), [ANTHROPIC_URL]: anthropicWith('claude-x') });
  const plans = [
    { name: 'the provider pick', quick: [], input: [] },
    { name: 'the Ollama model pick', quick: [providerItem('ollama')], input: [] },
    { name: 'the OpenAI key box', quick: [providerItem('openai')], input: [] },
    { name: 'the OpenAI model pick', quick: [providerItem('openai')], input: [KEY] },
    { name: 'the Claude key box', quick: [providerItem('anthropic')], input: [] },
    { name: 'the server address box', quick: [providerItem('compatible')], input: [] },
    { name: 'the server key box', quick: [providerItem('compatible')], input: ['http://localhost:1234/v1'] },
  ];
  for (const plan of plans) {
    const { fake, run, context } = await open({ fetchImpl: net });
    fake.script.quickPick.push(...plan.quick);
    fake.script.inputBox.push(...plan.input);
    await run();
    assert.deepEqual(updates(fake), {}, `${plan.name}: no setting was written`);
    assert.equal(context.secretValues.size, 0, `${plan.name}: no key was stored`);
    assert.equal(fake.callsOf('error').length, 0, `${plan.name}: backing out is not an error`);
  }
});

test('cancelling the test while it runs saves nothing', async () => {
  const net = network({ [OLLAMA_URL]: ollamaWith('llama3.1:latest') });
  const hangs = model((n) => new Promise(() => {}));
  const { fake, run, context } = await open({ fetchImpl: net, client: { built: [], createClient: () => ({ complete: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' })))) }) } });
  fake.script.quickPick.push(providerItem('ollama'), { model: 'llama3.1:latest' });
  const running = run();
  while (fake.progressTokens.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(fake.progressTokens[0].options.title, /^Testing Ollama - llama3\.1:latest\.\.\./);
  assert.equal(fake.progressTokens[0].options.cancellable, true);
  fake.progressTokens[0].cancel();
  await running;
  assert.deepEqual(updates(fake), {});
  assert.equal(context.secretValues.size, 0);
  void hangs;
});

test('a value set for the project is changed there, so a project setting cannot silently override the choice', async () => {
  const net = network({ [OLLAMA_URL]: ollamaWith('llama3.1:latest') });
  const { fake, run } = await open({ fetchImpl: net, workspaceValues: { model: 'something-old' } });
  fake.script.quickPick.push(providerItem('ollama'), { model: 'llama3.1:latest' });
  await run();
  const writes = fake.callsOf('config.update');
  assert.equal(writes.find((w) => w.key === 'model').target, fake.vscode.ConfigurationTarget.Workspace);
  assert.equal(writes.find((w) => w.key === 'provider').target, fake.vscode.ConfigurationTarget.Global);
});

// ---- the quick test of what is saved now ---------------------------------------------------

test('Test AI Model Connection checks what is saved, and a failure offers the wizard', async () => {
  const ok = await open({ settings: { 'mergeAssistant.provider': 'ollama', 'mergeAssistant.model': 'llama3.1' }, fetchImpl: network({}) });
  await ok.fake.commands.get('mergeAssistant.testModel')();
  assert.match(ok.fake.messages('information').at(-1), /^Connected to Ollama - llama3\.1\./);
  assert.deepEqual(updates(ok.fake), {}, 'testing changes nothing');

  const bad = await open({ settings: { 'mergeAssistant.provider': 'openai', 'mergeAssistant.model': 'gpt-4o-mini' }, fetchImpl: network({ [OPENAI_URL]: openaiWith('gpt-4o-mini') }), client: model('unauthorized') });
  bad.context.secretValues.set('mergeAssistant.apiKey.openai', KEY);
  bad.fake.script.warning.push('Set Up AI Model');
  await bad.fake.commands.get('mergeAssistant.testModel')();
  assert.equal(bad.fake.callsOf('warning')[0].message, 'OpenAI rejected the key');
  assert.equal(bad.fake.callsOf('quickPick').length, 1, 'the wizard opened (its first question is on screen)');
  assert.equal(bad.client.built[0].API_KEY, KEY, 'the saved key for this provider was used');
});

test('the saved key for another server is never used for this one', async () => {
  // A project setting points the extension at some other server. The real OpenAI key must not follow it.
  const { fake, context, client } = await open({
    settings: { 'mergeAssistant.provider': 'openai', 'mergeAssistant.model': 'm', 'mergeAssistant.baseUrl': 'http://evil.example/v1' },
    fetchImpl: network({}),
  });
  context.secretValues.set('mergeAssistant.apiKey.openai', 'sk-REAL-openai-key-0000');
  await fake.commands.get('mergeAssistant.testModel')();

  assert.equal(client.built.length, 1, 'the test ran');
  assert.equal(client.built[0].BASE_URL, 'http://evil.example/v1');
  assert.equal(client.built[0].API_KEY, undefined, 'the OpenAI key was not handed to the client for another server');
  assert.ok(!JSON.stringify(client.built).includes('sk-REAL'));
  assert.ok(!JSON.stringify(fake.calls).includes('sk-REAL'));

  // The same key IS used for real OpenAI itself, including when the official address is spelled out.
  for (const baseUrl of ['', 'https://api.openai.com/v1']) {
    const real = await open({ settings: { 'mergeAssistant.provider': 'openai', 'mergeAssistant.model': 'm', 'mergeAssistant.baseUrl': baseUrl }, fetchImpl: network({}) });
    real.context.secretValues.set('mergeAssistant.apiKey.openai', 'sk-REAL-openai-key-0000');
    await real.fake.commands.get('mergeAssistant.testModel')();
    assert.equal(real.client.built[0].API_KEY, 'sk-REAL-openai-key-0000', `baseUrl "${baseUrl}"`);
  }
});

test('Set API Key offers the server the settings point at, and Clear lists every stored slot', async () => {
  const { fake, context } = await open({
    settings: { 'mergeAssistant.provider': 'openai', 'mergeAssistant.model': 'm', 'mergeAssistant.baseUrl': 'http://localhost:1234/v1' },
    fetchImpl: network({}),
  });
  fake.script.quickPick.push({ label: 'openai@localhost:1234' });
  fake.script.inputBox.push('local-key-0123456789');
  await fake.commands.get('mergeAssistant.setApiKey')();
  const offered = fake.callsOf('quickPick')[0].items.map((i) => i.label);
  assert.deepEqual(offered, ['openai', 'anthropic', 'openai@localhost:1234']);
  assert.equal(context.secretValues.get('mergeAssistant.apiKey.openai@localhost:1234'), 'local-key-0123456789');

  context.secretValues.set('mergeAssistant.apiKey.anthropic', 'sk-ant-0123456789');
  fake.script.quickPick.push({ label: 'openai@localhost:1234' });
  await fake.commands.get('mergeAssistant.clearApiKey')();
  const stored = fake.callsOf('quickPick').at(-1).items.map((i) => i.label);
  assert.deepEqual(stored.sort(), ['anthropic', 'openai@localhost:1234']);
  assert.equal(context.secretValues.get('mergeAssistant.apiKey.openai@localhost:1234'), undefined, 'cleared');
  assert.equal(JSON.parse(context.secretValues.get('mergeAssistant.keySlots')).length, 0, 'and removed from the index');
});

test('the sidebar shows the model in use, and says what is missing', async () => {
  const ready = await open({ settings: { 'mergeAssistant.provider': 'ollama', 'mergeAssistant.model': 'llama3.1' }, fetchImpl: network({}) });
  assert.equal(ready.api.treeView.description, 'Ollama - llama3.1');
  assert.equal(ready.api.treeView.message, undefined);
  assert.equal(ready.fake.contexts.get('mergeAssistant.modelReady'), true);

  const missing = await open({ settings: { 'mergeAssistant.provider': 'anthropic', 'mergeAssistant.model': 'claude-sonnet-5' }, fetchImpl: network({}) });
  assert.equal(missing.api.treeView.description, 'Claude (Anthropic) - claude-sonnet-5');
  assert.match(missing.api.treeView.message, /needs an API key\. Use "Set Up AI Model" \(the gear above\)\./);
  assert.equal(missing.fake.contexts.get('mergeAssistant.modelReady'), false, 'so the toolbar gear is shown');

  // Saving a key through the wizard's command makes it ready without restarting anything.
  missing.fake.script.quickPick.push({ label: 'anthropic' });
  missing.fake.script.inputBox.push('sk-ant-0123456789');
  await missing.fake.commands.get('mergeAssistant.setApiKey')();
  assert.equal(missing.fake.contexts.get('mergeAssistant.modelReady'), true);
  assert.equal(missing.api.treeView.message, undefined);
});
