import { createSession } from '../viewmodel/session.js';
import { modelStatus } from '../viewmodel/modelSetup.js';
import { keySlot, readSettings } from '../viewmodel/settings.js';
import { cherryPickCommands } from './cherryPickCommands.js';
import { createGitState } from './gitState.js';
import { mergeCommands } from './mergeCommands.js';
import { modelSetupCommands } from './modelSetup.js';
import { createLogger } from './output.js';
import { chooseRepo, findRepos } from './repo.js';
import { resolveCommands } from './resolveCommands.js';
import { stageCommands } from './stageCommands.js';
import { stageableFiles } from '../viewmodel/stageModel.js';
import { apiKeyCommands, createSecretStore } from './secrets.js';
import { createTaskRunner } from './tasks.js';
import { createTreeProvider } from './treeProvider.js';
import { validateCommands } from './validateCommands.js';

// Wires the extension together. `vscode` is passed in (see extension.js), so this whole
// module is exercised in tests with a fake editor.
// `createClient` replaces the model client and `fetchImpl` the network, for tests that script them.
export const activateWith = async (vscode, context, { debounceMs, createClient, preflight, fetchImpl } = {}) => {
  const store = createSecretStore(context.secrets);

  // Keys that exist right now, kept so the logger can mask them if one ever leaks into a message.
  let knownKeys = [];
  const reloadKeys = async () => {
    knownKeys = Object.values(await store.loadAll()).filter(Boolean);
  };
  await reloadKeys();

  const logger = createLogger({ vscode, getSecrets: () => knownKeys });
  const getSettings = () => {
    const configuration = vscode.workspace.getConfiguration('mergeAssistant');
    return readSettings((key, fallback) => configuration.get(key, fallback));
  };

  // A command that fails must tell the user and log why, never fail silently.
  const register = (id, handler) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args) => {
        try {
          return await handler(...args);
        } catch (error) {
          const message = logger.redact(error?.message ?? String(error));
          logger.error(`${id}: ${message}`);
          const choice = await vscode.window.showErrorMessage(`Merge Assistant: ${message}`, 'Show Log');
          if (choice === 'Show Log') logger.show(false);
        }
        return undefined;
      })
    );

  // The repository this window works on. With several open, the user chooses once.
  let repo = null;
  const getRepo = () => repo;
  const session = createSession();

  let provider = null;
  const runner = createTaskRunner({ vscode, session, logger, onBusyChange: () => provider?.refresh() });
  const gitState = createGitState({ vscode, session, getRepo, logger, debounceMs });
  provider = createTreeProvider({ vscode, session, isBusy: () => runner.busy });

  const treeView = vscode.window.createTreeView('mergeAssistant.steps', { treeDataProvider: provider, showCollapseAll: true });
  context.subscriptions.push(treeView, provider, gitState, logger);

  const pickRepo = async ({ ask = false } = {}) => {
    repo = await chooseRepo({ vscode, context, repos: await findRepos({ vscode }), ask });
    logger.info(repo ? `repository: ${repo.root}` : 'no Git repository in the open folders');
    await gitState.refresh();
  };

  // The model in use, shown next to the view title, with a hint when something is missing.
  const refreshModelStatus = async () => {
    const settings = getSettings();
    const apiKey = settings.provider === 'ollama' ? '' : (await store.get(keySlot(settings))) ?? '';
    const status = modelStatus(settings, apiKey);
    treeView.description = status.summary;
    treeView.message = status.ready ? undefined : `${status.problem} Use "Set Up AI Model" (the gear above).`;
    await vscode.commands.executeCommand('setContext', 'mergeAssistant.modelReady', status.ready);
  };
  const onModelChanged = async () => {
    await reloadKeys();
    await refreshModelStatus();
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration?.((event) => {
      if (event.affectsConfiguration('mergeAssistant')) refreshModelStatus().catch((error) => logger.warn(`status refresh failed: ${error.message}`));
    }) ?? { dispose() {} }
  );

  const keys = apiKeyCommands({ vscode, store, getSettings, onChanged: onModelChanged });
  const setup = modelSetupCommands({
    vscode, getSettings, store, logger, onChanged: onModelChanged,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(createClient ? { createClient } : {}),
  });
  register('mergeAssistant.setUpModel', setup.setUpModel);
  register('mergeAssistant.testModel', setup.testCurrent);
  register('mergeAssistant.setApiKey', keys.setApiKey);
  register('mergeAssistant.clearApiKey', keys.clearApiKey);
  register('mergeAssistant.showOutput', () => logger.show(false));
  // The view's colors come from the active theme, so changing the theme restyles it. An extension
  // cannot carry its own palette at runtime, so this opens VS Code's own theme picker.
  register('mergeAssistant.changeTheme', () => vscode.commands.executeCommand('workbench.action.selectTheme'));

  const merge = mergeCommands({ vscode, getRepo, gitState, runner, logger });
  register('mergeAssistant.mergeBranch', merge.mergeBranch);
  register('mergeAssistant.abortMerge', merge.abortMerge);
  register('mergeAssistant.refresh', merge.refresh);
  register('mergeAssistant.openConflict', merge.openConflict);
  const resolver = resolveCommands({
    vscode, context, getRepo, getSettings, store, session, gitState, runner, logger,
    ...(createClient ? { createClient } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  register('mergeAssistant.resolveAll', resolver.resolveAll);
  register('mergeAssistant.resolveFile', resolver.resolveFile);
  const checks = validateCommands({ vscode, getRepo, session, runner, logger });
  register('mergeAssistant.runChecks', checks.runChecks);
  const pick = cherryPickCommands({ vscode, getRepo, runner, logger, ...(preflight ? { preflight } : {}) });
  context.subscriptions.push(pick);
  register('mergeAssistant.checkCherryPick', pick.checkCherryPick);
  const staging = stageCommands({ vscode, getRepo, session, gitState, runner, logger });
  register('mergeAssistant.stageResolved', staging.stageResolved);
  // The Stage button only exists while there is something to stage.
  let stageable = null;
  const syncStageable = () => {
    const next = stageableFiles(session.state).length > 0;
    if (next === stageable) return;
    stageable = next;
    Promise.resolve(vscode.commands.executeCommand('setContext', 'mergeAssistant.hasStageable', next)).catch(() => {});
  };
  context.subscriptions.push({ dispose: session.onDidChange(syncStageable) });
  syncStageable();
  register('mergeAssistant.chooseRepository', () => pickRepo({ ask: true }));
  register('mergeAssistant.cancel', async () => {
    if (!runner.cancel()) await vscode.window.showInformationMessage('Nothing is running.');
  });

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders?.(() => pickRepo()) ?? { dispose() {} });

  await refreshModelStatus();
  await pickRepo();
  await gitState.watch();
  logger.info('Merge Assistant activated.');

  return { logger, store, getSettings, register, session, runner, gitState, pickRepo, getRepo, refreshModelStatus, treeView };
};
