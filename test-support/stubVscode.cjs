// A CommonJS stand-in for the `vscode` module, used to load the real bundled extension in a
// plain Node process. It only has to be complete enough for activate() to run; registered
// commands are exposed on globalThis.__mcaRegistered for the test to inspect.
const registered = (globalThis.__mcaRegistered = new Map());
const noop = () => undefined;
const disposable = () => ({ dispose: noop });

class EventEmitter {
  constructor() { this.listeners = new Set(); this.event = (l) => { this.listeners.add(l); return { dispose: () => this.listeners.delete(l) }; }; }
  fire(value) { [...this.listeners].forEach((l) => l(value)); }
  dispose() { this.listeners.clear(); }
}

module.exports = {
  EventEmitter,
  QuickPickItemKind: { Separator: -1, Default: 0 },
  Uri: { from: (parts) => ({ ...parts, fsPath: parts.path, toString: () => parts.path }), file: (fsPath) => ({ scheme: 'file', fsPath }), parse: (value) => ({ scheme: 'x', toString: () => String(value) }) },
  Range: class {},
  ThemeIcon: class {},
  ThemeColor: class {},
  TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ProgressLocation: { Notification: 15 },
  window: {
    createOutputChannel: () => ({ appendLine: noop, clear: noop, show: noop, dispose: noop }),
    createTreeView: () => ({ dispose: noop }),
    withProgress: async (options, task) => task({ report: noop }, { onCancellationRequested: disposable }),
    onDidChangeWindowState: disposable,
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
  },
  commands: {
    registerCommand: (id, fn) => { registered.set(id, fn); return disposable(); },
    executeCommand: async () => undefined,
  },
  env: { clipboard: { writeText: async () => undefined } },
  extensions: { getExtension: () => undefined },
  workspace: {
    workspaceFolders: [],
    textDocuments: [],
    registerTextDocumentContentProvider: disposable,
    getConfiguration: () => ({ get: (key, fallback) => fallback }),
    onDidChangeWorkspaceFolders: disposable,
  },
};
