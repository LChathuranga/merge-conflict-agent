import path from 'node:path';
import { sameRoot } from './repo.js';

const SAVE = 'Save All and Continue';

// Resolving rewrites files on disk. An editor holding unsaved edits to the same file would
// either lose them or fight the new content, so those are saved (or the run is refused) first.
//   scope.files: only these repo-relative files matter; omit it to cover the whole repository.
export const ensureSaved = async ({ vscode, root, files = null, reason }) => {
  const watched = files ? files.map((f) => path.join(root, f)) : null;
  const inRepo = (fsPath) => {
    const relative = path.relative(root, fsPath);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  };

  const dirty = vscode.workspace.textDocuments.filter(
    (doc) => doc.isDirty && doc.uri.scheme === 'file' && inRepo(doc.uri.fsPath) && (!watched || watched.some((w) => sameRoot(w, doc.uri.fsPath)))
  );
  if (dirty.length === 0) return true;

  const names = dirty.slice(0, 5).map((d) => path.relative(root, d.uri.fsPath)).join(', ');
  const choice = await vscode.window.showWarningMessage(
    `${dirty.length} file${dirty.length === 1 ? ' has' : 's have'} unsaved changes (${names}${dirty.length > 5 ? ', ...' : ''}).`,
    { modal: true, detail: `${reason} Save them first so nothing is lost or overwritten.` },
    SAVE
  );
  if (choice !== SAVE) return false;

  const results = await Promise.all(dirty.map((doc) => doc.save()));
  return results.every(Boolean);
};
