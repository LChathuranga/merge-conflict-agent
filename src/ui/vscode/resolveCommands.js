import { createLLMClient } from '../../llm/index.js';
import { resolveConflicts } from '../../orchestrator/index.js';
import { isAbort } from '../../util/abort.js';
import { describeEvent, describeWorking, summarizeRun } from '../viewmodel/runSummary.js';
import { listOllamaModels } from '../../llm/models.js';
import { explainModelError, ollamaHasModel, pullCommand } from '../viewmodel/modelSetup.js';
import { buildEnv, keySlot, validateSettings } from '../viewmodel/settings.js';
import { createReviewer } from './reviewPanel.js';
import { ensureConsent } from './consent.js';
import { ensureSaved } from './dirtyGuard.js';

const fileFromItem = (item) => {
  if (typeof item === 'string') return item;
  if (typeof item?.file === 'string') return item.file;
  return null;
};

// Resolve with AI. `createClient` and `resolve` can be replaced in tests; everything else is the
// real flow: settings checks, privacy consent, unsaved-file guard, the orchestrator run with a
// cancellable progress notification, and the diff-based review.
export const resolveCommands = ({
  vscode, context, getRepo, getSettings, store, session, gitState, runner, logger,
  createClient = createLLMClient,
  resolve = resolveConflicts,
  fetchImpl = globalThis.fetch,
}) => {
  const say = {
    info: (message, ...buttons) => vscode.window.showInformationMessage(message, ...buttons),
    warning: (message, ...buttons) => vscode.window.showWarningMessage(message, ...buttons),
  };

  // A local model that is not running, or not downloaded, would otherwise fail file by file with a
  // vague "connection error". Ask Ollama first; a slow answer is not treated as a failure.
  const ensureOllamaReady = async (settings) => {
    if (settings.provider !== 'ollama') return true;
    let installed;
    try {
      installed = await listOllamaModels({ baseUrl: settings.baseUrl, fetch: fetchImpl, timeoutMs: 2500 });
    } catch (error) {
      if (error.code === 'timeout') return true;
      const info = explainModelError(error, { provider: 'ollama', baseUrl: settings.baseUrl });
      const choice = await vscode.window.showErrorMessage(`${info.title}. ${info.detail}`, 'Set Up AI Model');
      if (choice === 'Set Up AI Model') await vscode.commands.executeCommand('mergeAssistant.setUpModel');
      return false;
    }
    if (ollamaHasModel(installed, settings.model)) return true;

    const command = pullCommand(settings.model);
    const buttons = [...(command ? ['Copy Download Command'] : []), 'Set Up AI Model'];
    const choice = await vscode.window.showErrorMessage(
      `Ollama does not have "${settings.model}" yet.${command ? ` Download it by running: ${command}` : ''}`,
      ...buttons
    );
    if (choice === 'Copy Download Command') await vscode.env.clipboard.writeText(command);
    if (choice === 'Set Up AI Model') await vscode.commands.executeCommand('mergeAssistant.setUpModel');
    return false;
  };

  const run = async (requested) => {
    const repo = getRepo();
    if (!repo) {
      await say.info('Open a folder that contains a Git repository first.');
      return;
    }
    const { state } = session;
    if (state.operation !== 'merge') {
      await say.info('There is no merge in progress. Start one with "Merge a Branch..." first.');
      return;
    }

    const workable = state.files.filter((f) => f.hunks.length > 0).map((f) => f.path);
    const targets = requested ? requested.filter((f) => workable.includes(f)) : workable;
    if (targets.length === 0) {
      await say.info(requested ? 'That file has no conflict markers to resolve.' : 'No conflicted file has conflict markers left to resolve.');
      return;
    }

    const settings = getSettings();
    const apiKey = settings.provider === 'ollama' ? '' : (await store.get(keySlot(settings))) ?? '';
    const { errors, warnings } = validateSettings(settings, apiKey);
    if (errors.length > 0) {
      const choice = await vscode.window.showErrorMessage(errors[0], 'Set Up AI Model', 'Open Settings');
      if (choice === 'Set Up AI Model') await vscode.commands.executeCommand('mergeAssistant.setUpModel');
      if (choice === 'Open Settings') await vscode.commands.executeCommand('workbench.action.openSettings', 'mergeAssistant');
      return;
    }
    warnings.forEach((w) => logger.warn(w));

    if (!(await ensureOllamaReady(settings))) return;

    if (!(await ensureConsent({ vscode, context, settings }))) return;
    if (!(await ensureSaved({ vscode, root: repo.root, files: targets, reason: 'Resolving rewrites these files.' }))) return;

    const llm = createClient(buildEnv(settings, apiKey));
    logger.info(`resolve: ${targets.length} file(s) with ${settings.provider}/${settings.model}`);

    const outcome = await runner.run('resolve', async ({ signal, report }) => {
      const reviewer = createReviewer({ vscode, signal });
      try {
        const result = await resolve({
          cwd: repo.root,
          llm,
          approve: reviewer.approve,
          signal,
          onlyFiles: targets,
          useIntent: settings.useIntent,
          useReferences: settings.useReferences,
          useTools: settings.useTools,
          maxAttempts: settings.maxAttempts,
          // The extension never stages, never validates inside a resolve run, and always writes.
          stage: false,
          validate: false,
          dryRun: false,
          onEvent: (event) => {
            session.handleEvent(event);
            const { log, progress } = describeEvent(event);
            if (log) logger.info(log);
            if (progress) report(progress);
            reviewer.working(describeWorking(event));
          },
        });
        session.recordResults(result.files);
        return { files: result.files, cancelled: false };
      } catch (error) {
        if (!isAbort(error)) throw error;
        session.recordResults(error.results ?? []);
        return { files: error.results ?? [], cancelled: true };
      } finally {
        // The review page belongs to the run: it closes when the run ends or is cancelled.
        reviewer.dispose();
      }
    }, { title: 'Resolving conflicts with AI' });
    if (!outcome) return; // another task was already running

    await gitState.refresh();
    const summary = summarizeRun({ files: outcome.files, cancelled: outcome.cancelled, total: targets.length });
    logger.info(`resolve: ${summary.message}`);

    const choice = await say[summary.level](summary.message, ...summary.buttons);
    if (choice === 'Open Source Control') await vscode.commands.executeCommand('workbench.view.scm');
    else if (choice === 'Show Log') logger.show(false);
    else if (choice === 'Run Checks...') await vscode.commands.executeCommand('mergeAssistant.runChecks');
    else if (choice === 'Stage Resolved Files...') await vscode.commands.executeCommand('mergeAssistant.stageResolved');
  };

  return {
    resolveAll: () => run(null),
    // Invoked from a file's inline button: the argument is the tree item.
    resolveFile: (item) => {
      const file = fileFromItem(item);
      if (!file) return say.info('Choose a conflicted file in the Merge Assistant view.');
      return run([file]);
    },
  };
};
