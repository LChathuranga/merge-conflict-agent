import { getMergeState } from '../../git/merge.js';
import { readWorkingFile } from '../../git/index.js';
import { parseConflictHunks } from '../../conflict/parser.js';

const DEBOUNCE_MS = 300;

// Keeps the session in step with what git says, and publishes it as context keys that the
// view's menus and welcome text depend on. Refreshes are coalesced: a burst of change events
// (a merge touches many files) causes one refresh at a time, then one more if needed.
export const createGitState = ({ vscode, session, getRepo, logger, debounceMs = DEBOUNCE_MS }) => {
  let running = null;
  let again = false;
  let timer = null;
  const disposables = [];

  const setContext = (key, value) => vscode.commands.executeCommand('setContext', key, value);

  const load = async () => {
    const repo = getRepo();
    session.setRepo(repo);
    if (!repo) {
      await Promise.all([
        setContext('mergeAssistant.hasRepo', false),
        setContext('mergeAssistant.mergeInProgress', false),
        setContext('mergeAssistant.otherOperation', false),
        setContext('mergeAssistant.hasConflicts', false),
      ]);
      return;
    }

    const merge = await getMergeState(repo.root);
    const files = [];
    if (merge.resolvable) {
      for (const path of merge.conflictedFiles) {
        let hunks = [];
        try {
          hunks = parseConflictHunks(await readWorkingFile(repo.root, path));
        } catch {
          // deleted on one side, or unreadable: shown as needing manual work
        }
        files.push({ path, hunks });
      }
    }
    session.syncGit({ ...merge, files });

    await Promise.all([
      setContext('mergeAssistant.hasRepo', true),
      setContext('mergeAssistant.mergeInProgress', merge.resolvable),
      setContext('mergeAssistant.otherOperation', Boolean(merge.operation) && !merge.resolvable),
      setContext('mergeAssistant.hasConflicts', files.some((f) => f.hunks.length > 0)),
    ]);
  };

  const refresh = async () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        try {
          await load();
        } catch (error) {
          logger.error(`refresh failed: ${error.message}`);
        }
      } while (again);
    })().finally(() => { running = null; });
    return running;
  };

  const refreshSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      refresh();
    }, debounceMs);
  };

  // Commits, aborts and staging done outside the extension should update the view too.
  const watch = async () => {
    disposables.push(vscode.window.onDidChangeWindowState?.((state) => { if (state.focused) refreshSoon(); }));
    try {
      const extension = vscode.extensions.getExtension('vscode.git');
      const api = (extension?.isActive ? extension.exports : await extension?.activate())?.getAPI(1);
      if (!api) return;
      const follow = (repository) => disposables.push(repository.state.onDidChange(refreshSoon));
      api.repositories.forEach(follow);
      disposables.push(api.onDidOpenRepository(follow));
    } catch (error) {
      logger.warn(`Could not follow the Git extension (${error.message}); the view refreshes when the window gets focus.`);
    }
  };

  // Resolves once no refresh is scheduled or running.
  const settled = async () => {
    while (timer !== null || running !== null) {
      if (running) await running;
      else await new Promise((resolve) => setTimeout(resolve, debounceMs + 5));
    }
  };

  return {
    refresh,
    watch,
    settled,
    dispose() {
      clearTimeout(timer);
      timer = null;
      disposables.filter(Boolean).forEach((d) => d.dispose?.());
    },
  };
};
