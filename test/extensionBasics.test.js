import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeVscode } from '../test-support/fakeVscode.js';
import { activateWith } from '../src/ui/vscode/activate.js';
import { DEFAULTS, buildEnv, dataDestination, readSettings, validateSettings } from '../src/ui/viewmodel/settings.js';
import { redact } from '../src/ui/viewmodel/redact.js';
import { createLLMClient } from '../src/llm/index.js';

const settingsFrom = (values) => readSettings((key, fallback) => (values[key] !== undefined ? values[key] : fallback));

test('settings default to a local Ollama model with tools off', () => {
  const settings = settingsFrom({});
  assert.deepEqual(settings, { ...DEFAULTS });
  assert.equal(settings.useTools, false);
  assert.equal(dataDestination(settings), null, 'nothing leaves this machine');
  assert.deepEqual(validateSettings(settings, ''), { errors: [], warnings: [] });
});

test('settings are cleaned and clamped', () => {
  const settings = settingsFrom({ provider: ' OpenAI ', model: '  gpt-4o-mini ', maxAttempts: '99', jsonMode: false, useIntent: false, useTools: 'yes' });
  assert.equal(settings.provider, 'openai');
  assert.equal(settings.model, 'gpt-4o-mini');
  assert.equal(settings.maxAttempts, 10);
  assert.equal(settings.jsonMode, false);
  assert.equal(settings.useIntent, false);
  assert.equal(settings.useTools, false, 'only a real true turns tools on');
  assert.equal(settingsFrom({ maxAttempts: 'many' }).maxAttempts, DEFAULTS.maxAttempts);
});

test('the env handed to the core never needs process.env or a .env file', () => {
  const env = buildEnv(settingsFrom({ provider: 'anthropic', model: 'claude-x', baseUrl: '' }), 'sk-ant-secret-key');
  assert.deepEqual(env, { PROVIDER: 'anthropic', LLM_MODEL: 'claude-x', API_KEY: 'sk-ant-secret-key', JSON_MODE: 'true' });

  const client = createLLMClient(env);
  assert.equal(typeof client.chat, 'function');
  assert.equal(typeof createLLMClient(buildEnv(settingsFrom({}), '')).complete, 'function', 'ollama needs no key');
});

test('validation reports missing keys, bad URLs and unencrypted remote endpoints', () => {
  assert.match(validateSettings(settingsFrom({ provider: 'openai' }), '').errors[0], /needs an API key/);
  assert.match(validateSettings(settingsFrom({ provider: 'nope' }), '').errors[0], /Provider must be one of/);
  assert.match(validateSettings(settingsFrom({ model: '' }), '').errors[0], /model name/);
  assert.match(validateSettings(settingsFrom({ baseUrl: 'not a url' }), '').errors[0], /not a valid http\(s\) URL/);
  assert.match(validateSettings(settingsFrom({ baseUrl: 'ftp://host' }), '').errors[0], /not a valid http\(s\) URL/);

  const remote = validateSettings(settingsFrom({ provider: 'openai', baseUrl: 'http://models.example.com/v1' }), 'k-12345678');
  assert.deepEqual(remote.errors, []);
  assert.match(remote.warnings[0], /not encrypted/);
  assert.deepEqual(validateSettings(settingsFrom({ provider: 'openai', baseUrl: 'http://localhost:1234/v1' }), 'k-12345678').warnings, []);
  assert.match(validateSettings(settingsFrom({ useTools: true }), '').warnings[0], /Tool calling is on/);
});

test('data destination tells the consent prompt where code would go', () => {
  assert.equal(dataDestination(settingsFrom({ provider: 'openai' })), 'OpenAI (api.openai.com)');
  assert.equal(dataDestination(settingsFrom({ provider: 'anthropic' })), 'Anthropic (api.anthropic.com)');
  assert.equal(dataDestination(settingsFrom({ provider: 'openai', baseUrl: 'http://localhost:1234/v1' })), null);
  assert.equal(dataDestination(settingsFrom({ provider: 'openai', baseUrl: 'https://llm.corp.example/v1' })), 'llm.corp.example');
  assert.equal(dataDestination(settingsFrom({ provider: 'ollama', baseUrl: 'http://gpu-box:11434/v1' })), 'gpu-box:11434');
});

test('redaction masks exact secrets and common key shapes', () => {
  const text = 'failed: sk-ant-abcdefghijkl, Bearer abcdefghijklmnop12, api_key="abcdefgh1234", mine=hunter2-secret';
  const out = redact(text, ['hunter2-secret']);
  assert.ok(!/abcdefghijkl|abcdefghijklmnop12|abcdefgh1234|hunter2-secret/.test(out), out);
  assert.match(out, /\*\*\*/);
  assert.equal(redact('nothing secret here'), 'nothing secret here');
  assert.equal(redact(undefined), '');
  assert.equal(redact('abc', ['abc']), 'abc', 'very short secrets are not masked, to avoid mangling ordinary text');
});

test('activation registers the key commands and logs through the redactor', async () => {
  const fake = createFakeVscode();
  const context = fake.context();
  context.secretValues.set('mergeAssistant.apiKey.openai', 'sk-live-supersecret-1234');

  const { logger } = await activateWith(fake.vscode, context);
  for (const id of ['mergeAssistant.setApiKey', 'mergeAssistant.clearApiKey', 'mergeAssistant.showOutput']) {
    assert.ok(fake.commands.has(id), `${id} is registered`);
  }

  logger.info('request failed for sk-live-supersecret-1234');
  const lines = fake.outputs.get('Merge Assistant').lines;
  assert.ok(lines.some((l) => l.includes('Merge Assistant activated')));
  assert.ok(!lines.join('\n').includes('supersecret'), 'a stored key is masked even in free text');
});

test('Set API Key stores the key in secret storage only, and never echoes it', async () => {
  const fake = createFakeVscode({ settings: { 'mergeAssistant.provider': 'openai' } });
  const context = fake.context();
  const { logger } = await activateWith(fake.vscode, context);

  fake.script.quickPick.push({ label: 'openai' });
  fake.script.inputBox.push('  sk-new-key-123456  ');
  await fake.commands.get('mergeAssistant.setApiKey')();

  assert.equal(context.secretValues.get('mergeAssistant.apiKey.openai'), 'sk-new-key-123456');
  const prompt = fake.callsOf('inputBox')[0].options;
  assert.equal(prompt.password, true);
  assert.equal(prompt.ignoreFocusOut, true);
  assert.match(prompt.validateInput('short'), /does not look like an API key/);
  assert.equal(prompt.validateInput('long-enough-key'), undefined);
  assert.ok(!fake.callsOf('information').some((c) => c.message.includes('sk-new-key')));

  logger.info('now logging sk-new-key-123456');
  assert.ok(!fake.outputs.get('Merge Assistant').lines.join('\n').includes('sk-new-key-123456'), 'the new key is masked immediately');
});

test('Set API Key does nothing if the user backs out, and Clear removes only the chosen key', async () => {
  const fake = createFakeVscode();
  const context = fake.context();
  await activateWith(fake.vscode, context);

  await fake.commands.get('mergeAssistant.setApiKey')(); // QuickPick dismissed
  fake.script.quickPick.push({ label: 'anthropic' });
  await fake.commands.get('mergeAssistant.setApiKey')(); // input box dismissed
  assert.equal(context.secretValues.size, 0);

  context.secretValues.set('mergeAssistant.apiKey.openai', 'sk-openai-key-1234');
  context.secretValues.set('mergeAssistant.apiKey.anthropic', 'sk-ant-key-1234567');
  fake.script.quickPick.push({ label: 'openai' });
  await fake.commands.get('mergeAssistant.clearApiKey')();
  assert.equal(context.secretValues.has('mergeAssistant.apiKey.openai'), false);
  assert.equal(context.secretValues.has('mergeAssistant.apiKey.anthropic'), true);
});

test('a failing command is reported and logged, not swallowed, and the error text is redacted', async () => {
  const fake = createFakeVscode();
  const context = fake.context();
  context.secretValues.set('mergeAssistant.apiKey.openai', 'sk-live-supersecret-1234');
  const { register, logger } = await activateWith(fake.vscode, context);

  register('mergeAssistant.test', async () => { throw new Error('401 for key sk-live-supersecret-1234'); });
  fake.script.error.push('Show Log');
  await fake.commands.get('mergeAssistant.test')();

  const shown = fake.callsOf('error')[0];
  assert.match(shown.message, /Merge Assistant: 401 for key \*\*\*/);
  assert.ok(!shown.message.includes('supersecret'));
  assert.equal(fake.callsOf('output.show').length, 1, '"Show Log" opens the log');
  assert.ok(fake.outputs.get('Merge Assistant').lines.some((l) => l.includes('ERROR') && l.includes('mergeAssistant.test')));
  assert.ok(logger);
});

test("the Change Color Theme button opens the editor's own theme picker", async () => {
  const fake = createFakeVscode();
  await activateWith(fake.vscode, fake.context());
  await fake.commands.get('mergeAssistant.changeTheme')();
  assert.ok(fake.callsOf('executeCommand').some((c) => c.id === 'workbench.action.selectTheme'));
});
