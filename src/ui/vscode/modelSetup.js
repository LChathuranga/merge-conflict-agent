import { FALLBACK_MODELS, PROVIDER_CHOICES, describeModel, explainModelError, formatBytes, isSafeModelName, ollamaBaseUrl, ollamaHasModel, pullCommand, rankOpenAIModels, savedMessage } from '../viewmodel/modelSetup.js';
import { buildEnv, keySlot } from '../viewmodel/settings.js';
import { listAnthropicModels, listOllamaModels, listOpenAIModels } from '../../llm/models.js';
import { testModel } from '../../llm/testConnection.js';
import { isAbort } from '../../util/abort.js';

const TYPE_IT = '$(edit) Type a model name...';
const PLACEHOLDER_KEY = 'not-needed'; // some servers need no key, but the client library insists on one
const lastFour = (key) => (key.length >= 8 ? `ends in ${key.slice(-4)}` : 'saved');

// The "Set Up AI Model" wizard: choose where the AI runs, supply its address, key and model,
// prove it works with one real request, and only then save. Every step can be backed out of
// (Esc), and nothing is saved until the end. `fetchImpl` and `createClient` are replaceable in tests.
export const modelSetupCommands = ({
  vscode, getSettings, store, logger, onChanged = async () => {},
  fetchImpl = globalThis.fetch, createClient, testTimeoutMs,
}) => {
  const ui = vscode.window;
  const warn = (title, detail, ...buttons) => ui.showWarningMessage(title, { modal: true, detail }, ...buttons);

  const writeSetting = async (key, value) => {
    const config = vscode.workspace.getConfiguration('mergeAssistant');
    const info = config.inspect?.(key);
    // Write where the value is currently decided, or a project setting would silently win.
    const target = info?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : info?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await config.update(key, value, target);
  };

  const askAddress = ({ title, value, placeHolder, prompt }) =>
    ui.showInputBox({
      title, prompt, value, placeHolder, ignoreFocusOut: true,
      validateInput: (text) => {
        try {
          const url = new URL(text.trim());
          return url.protocol === 'http:' || url.protocol === 'https:' ? undefined : 'Use an address that starts with http:// or https://';
        } catch {
          return 'Enter a full address, for example http://localhost:1234/v1';
        }
      },
    });

  // Returns the chosen model name, or undefined if the user backed out.
  const chooseModel = async ({ title, models = [], suggestions = [], current = '' }) => {
    const typed = () =>
      ui.showInputBox({
        title, prompt: 'The exact model name, as the provider spells it.', value: current, ignoreFocusOut: true,
        placeHolder: suggestions[0] ? `for example ${suggestions[0]}` : undefined,
        validateInput: (text) => (isSafeModelName(text.trim()) ? undefined : 'Use letters, digits and . : - _ / only, starting with a letter or digit.'),
      }).then((value) => value?.trim());

    if (models.length === 0 && suggestions.length === 0) return typed();

    const items = [
      ...models.map((m) => ({ label: m.label, description: m.description, detail: m.detail, model: m.value })),
      ...(models.length === 0 ? suggestions.map((value) => ({ label: value, description: 'suggestion', model: value })) : []),
      { kind: vscode.QuickPickItemKind.Separator, label: '' },
      { label: TYPE_IT, typeIt: true },
    ];
    const picked = await ui.showQuickPick(items, { title, placeHolder: 'Choose the model', ignoreFocusOut: true, matchOnDescription: true });
    if (!picked) return undefined;
    return picked.typeIt ? typed() : picked.model;
  };

  // The saved key for this server, or a new one typed now. Returns { key, isNew } or undefined.
  const askKey = async ({ title, slot, label, optional = false, forceNew = false }) => {
    const saved = forceNew ? '' : (await store.get(slot)) ?? '';
    if (saved && saved !== PLACEHOLDER_KEY) {
      const choice = await ui.showQuickPick(
        [{ label: `Use the saved key (${lastFour(saved)})`, use: true }, { label: 'Enter a different key', use: false }],
        { title, placeHolder: `A ${label} key is already saved on this computer`, ignoreFocusOut: true }
      );
      if (!choice) return undefined;
      if (choice.use) return { key: saved, isNew: false };
    }
    const key = await ui.showInputBox({
      title,
      prompt: optional
        ? `The key for ${label}. Leave it empty if the server needs none.`
        : `Paste your ${label} API key. It is kept in VS Code's secret storage on this computer, never in a settings file or the log.`,
      password: true, ignoreFocusOut: true,
      validateInput: (text) => (!optional && text.trim().length < 8 ? 'That does not look like an API key.' : undefined),
    });
    if (key === undefined) return undefined;
    const trimmed = key.trim();
    return { key: trimmed === '' && optional ? PLACEHOLDER_KEY : trimmed, isNew: true };
  };

  // --- one function per provider; each returns a candidate setup or undefined (backed out) ---

  const setUpOllama = async (current, title) => {
    let baseUrl = current.provider === 'ollama' ? current.baseUrl : '';
    for (;;) {
      let installed;
      try {
        installed = await listOllamaModels({ baseUrl, fetch: fetchImpl });
      } catch (error) {
        if (isAbort(error)) return undefined;
        const info = explainModelError(error, { provider: 'ollama', baseUrl });
        const choice = await warn(info.title, info.detail, 'Try Again', 'Use a Different Address');
        if (choice === 'Try Again') continue;
        if (choice !== 'Use a Different Address') return undefined;
        const address = await askAddress({ title, value: baseUrl || 'http://localhost:11434', prompt: 'Where is Ollama running?', placeHolder: 'http://localhost:11434' });
        if (address === undefined) return undefined;
        baseUrl = ollamaBaseUrl(address);
        continue;
      }

      if (installed.length === 0) {
        const command = pullCommand('llama3.1');
        const choice = await warn('Ollama is running, but it has no models yet.', `Download one first, for example by running: ${command}\nThen choose Try Again.`, 'Copy Command', 'Try Again');
        if (choice === 'Copy Command') await vscode.env.clipboard.writeText(command);
        if (choice === 'Copy Command' || choice === 'Try Again') continue;
        return undefined;
      }

      const model = await chooseModel({
        title,
        models: installed.map((m) => ({ label: m.name, description: formatBytes(m.sizeBytes), value: m.name })),
        suggestions: [],
        current: current.provider === 'ollama' ? current.model : '',
      });
      if (model === undefined) return undefined;
      if (!ollamaHasModel(installed, model)) {
        const command = pullCommand(model);
        const choice = await warn(`Ollama does not have "${model}" yet.`, `${command ? `Download it by running: ${command}\n` : ''}You can save it anyway and download it later.`, ...(command ? ['Copy Command'] : []), 'Use It Anyway');
        if (choice === 'Copy Command') await vscode.env.clipboard.writeText(command);
        if (choice !== 'Use It Anyway') return undefined;
      }
      return { provider: 'ollama', baseUrl, model };
    }
  };

  const setUpCloud = async (provider, current, title) => {
    const label = provider === 'openai' ? 'OpenAI' : 'Anthropic (Claude)';
    const slot = provider;
    let credentials = await askKey({ title, slot, label });
    if (!credentials) return undefined;

    let ids = [];
    for (;;) {
      try {
        ids = provider === 'openai'
          ? rankOpenAIModels(await listOpenAIModels({ apiKey: credentials.key, fetch: fetchImpl }))
          : await listAnthropicModels({ apiKey: credentials.key, fetch: fetchImpl });
        break;
      } catch (error) {
        if (isAbort(error)) return undefined;
        const info = explainModelError(error, { provider });
        if (error.code === 'unauthorized') {
          const choice = await warn(info.title, info.detail, 'Enter the Key Again');
          if (choice !== 'Enter the Key Again') return undefined;
          credentials = await askKey({ title, slot, label, forceNew: true });
          if (!credentials) return undefined;
          continue;
        }
        // The list is a convenience; without it the model name can still be typed.
        const choice = await warn(`Could not get the list of ${label} models`, `${info.title}. ${info.detail}\n\nYou can still type a model name.`, 'Type a Model Name', 'Try Again');
        if (choice === 'Try Again') continue;
        if (choice !== 'Type a Model Name') return undefined;
        ids = [];
        break;
      }
    }

    const model = await chooseModel({
      title,
      models: ids.slice(0, 60).map((id) => ({ label: id, value: id })),
      suggestions: FALLBACK_MODELS[provider],
      current: current.provider === provider && !current.baseUrl ? current.model : '',
    });
    if (model === undefined) return undefined;
    return { provider, baseUrl: '', model, apiKey: credentials.key, keySlot: slot, keyIsNew: credentials.isNew };
  };

  const setUpCompatible = async (current, title) => {
    const label = 'this server';
    let baseUrl = current.provider === 'openai' ? current.baseUrl : '';
    for (;;) {
      const address = await askAddress({
        title, value: baseUrl, placeHolder: 'http://localhost:1234/v1',
        prompt: 'The address of the OpenAI-compatible server (LM Studio, Groq, a company gateway), usually ending in /v1.',
      });
      if (address === undefined) return undefined;
      baseUrl = address.trim();

      // The key is saved against this address and only ever sent to it.
      const slot = keySlot({ provider: 'openai', baseUrl });
      const credentials = await askKey({ title, slot, label, optional: true });
      if (!credentials) return undefined;

      let ids = [];
      try {
        ids = await listOpenAIModels({ baseUrl, apiKey: credentials.key === PLACEHOLDER_KEY ? '' : credentials.key, fetch: fetchImpl });
      } catch (error) {
        if (isAbort(error)) return undefined;
        const info = explainModelError(error, { provider: 'openai', baseUrl });
        const choice = await warn(info.title, `${info.detail}\n\nYou can type a model name anyway, or change the address.`, 'Type a Model Name', 'Change Address');
        if (choice === 'Change Address') continue;
        if (choice !== 'Type a Model Name') return undefined;
      }

      const model = await chooseModel({
        title, models: ids.slice(0, 60).map((id) => ({ label: id, value: id })), suggestions: [],
        current: current.provider === 'openai' && current.baseUrl === baseUrl ? current.model : '',
      });
      if (model === undefined) return undefined;
      return { provider: 'openai', baseUrl, model, apiKey: credentials.key, keySlot: slot, keyIsNew: credentials.isNew };
    }
  };

  // --- test, then save ---

  const runTest = (candidate, settings) =>
    ui.withProgress({ location: vscode.ProgressLocation.Notification, title: `Testing ${describeModel(candidate)}...`, cancellable: true }, async (_progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      const env = buildEnv({ ...settings, provider: candidate.provider, model: candidate.model, baseUrl: candidate.baseUrl ?? '' }, candidate.apiKey ?? '');
      try {
        return { result: await testModel({ env, createClient, timeoutMs: testTimeoutMs, signal: controller.signal }) };
      } catch (error) {
        if (isAbort(error) || controller.signal.aborted) return { cancelled: true };
        return { error };
      }
    });

  const save = async (candidate) => {
    await writeSetting('provider', candidate.provider);
    await writeSetting('model', candidate.model);
    await writeSetting('baseUrl', candidate.baseUrl ?? '');
    if (candidate.apiKey !== undefined && candidate.keyIsNew) await store.set(candidate.keySlot, candidate.apiKey);
    await onChanged();
    logger.info(`model set up: ${candidate.provider}/${candidate.model}${candidate.baseUrl ? ` at ${candidate.baseUrl}` : ''}`);
  };

  const setUpModel = async () => {
    const settings = getSettings();
    const total = 3;
    for (;;) {
      const title = (step) => `Set Up AI Model (${step}/${total})`;
      const chosen = await ui.showQuickPick(
        PROVIDER_CHOICES.map((c) => ({ label: c.label, description: c.description, id: c.id })),
        { title: title(1), placeHolder: 'Where should the AI run?', ignoreFocusOut: true }
      );
      if (!chosen) return;

      const stepTitle = title(2);
      const candidate = chosen.id === 'ollama' ? await setUpOllama(settings, stepTitle)
        : chosen.id === 'compatible' ? await setUpCompatible(settings, stepTitle)
          : await setUpCloud(chosen.id, settings, stepTitle);
      if (!candidate) return;

      for (;;) {
        const outcome = await runTest(candidate, settings);
        if (outcome.cancelled) return;

        if (outcome.result) {
          await save(candidate);
          const saved = { ...settings, provider: candidate.provider, model: candidate.model, baseUrl: candidate.baseUrl ?? '' };
          await ui.showInformationMessage(savedMessage(saved, outcome.result.ms));
          return;
        }

        const info = explainModelError(outcome.error, { provider: candidate.provider, model: candidate.model, baseUrl: candidate.baseUrl });
        logger.warn(`model test failed: ${info.title}`);
        const choice = await warn(info.title, `${info.detail}\n\nNothing has been saved yet.`, 'Try Again', 'Change Settings', 'Save Anyway');
        if (choice === 'Try Again') continue;
        if (choice === 'Save Anyway') {
          await save(candidate);
          await ui.showWarningMessage(`Saved ${describeModel(candidate)}, but the test did not work: ${info.title}.`);
          return;
        }
        if (choice === 'Change Settings') break; // back to choosing a provider
        return;
      }
    }
  };

  // The same test, against what is saved now.
  const testCurrent = async () => {
    const settings = getSettings();
    const apiKey = settings.provider === 'ollama' ? '' : (await store.get(keySlot(settings))) ?? '';
    const candidate = { provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl, apiKey };
    const outcome = await runTest(candidate, settings);
    if (outcome.cancelled) return;
    if (outcome.result) {
      await ui.showInformationMessage(savedMessage(settings, outcome.result.ms));
      return;
    }
    const info = explainModelError(outcome.error, { provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl });
    const choice = await warn(info.title, info.detail, 'Set Up AI Model');
    if (choice === 'Set Up AI Model') await setUpModel();
  };

  return { setUpModel, testCurrent, writeSetting };
};
