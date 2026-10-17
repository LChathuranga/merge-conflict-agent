// A small, recording stand-in for the parts of the VS Code API the extension uses, so the
// glue code can be tested with node:test. Prompts are answered from queues in `script`;
// an empty queue behaves like the user dismissing the prompt (undefined).

// `settings` are user (global) values written as 'mergeAssistant.key'. `workspaceValues` are project-level
// values by bare key, which win over user values, like in the real editor.
export const createFakeVscode = ({ settings = {}, folders = [], workspaceValues = {} } = {}) => {
  const calls = [];
  const commands = new Map();
  const contexts = new Map();
  const script = { quickPick: [], inputBox: [], information: [], warning: [], error: [], modal: [], review: [] };
  const reviewPanels = [];
  const outputs = new Map();
  const treeViews = [];
  const progressTokens = [];
  const windowStateListeners = new Set();
  const next = (queue) => (queue.length > 0 ? queue.shift() : undefined);
  const record = (kind, detail) => calls.push({ kind, ...detail });

  class EventEmitter {
    constructor() {
      this.listeners = new Set();
      this.event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    }
    fire(value) { [...this.listeners].forEach((l) => l(value)); }
    dispose() { this.listeners.clear(); }
  }

  const configuration = (section) => ({
    get: (key, fallback) => {
      if (workspaceValues[key] !== undefined) return workspaceValues[key];
      return settings[`${section}.${key}`] !== undefined ? settings[`${section}.${key}`] : fallback;
    },
    inspect: (key) => ({ key, globalValue: settings[`${section}.${key}`], workspaceValue: workspaceValues[key] }),
    update: async (key, value, target) => {
      record('config.update', { section, key, value, target });
      if (target === ConfigurationTarget.Workspace) workspaceValues[key] = value;
      else settings[`${section}.${key}`] = value;
    },
  });
  const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

  const fake = {
    gitExtension: undefined, // set to { isActive, exports: { getAPI } } to simulate the built-in Git extension
  };

  const vscode = {
    EventEmitter,
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Range: class { constructor(startLine, startCharacter, endLine, endCharacter) { this.start = { line: startLine, character: startCharacter }; this.end = { line: endLine, character: endCharacter }; } },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    Uri: {
      from: ({ scheme, path = '', query = '' }) => ({ scheme, path, query, fsPath: path, toString: () => `${scheme}:${path}${query ? `?${query}` : ''}` }),
      file: (fsPath) => ({ scheme: 'file', fsPath, path: fsPath.replace(/\\/g, '/'), toString: () => `file:///${fsPath.replace(/\\/g, '/')}` }),
      parse: (value) => ({ scheme: String(value).split(':')[0], toString: () => String(value) }),
    },
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ConfigurationTarget,
    ProgressLocation: { Notification: 15, Window: 10, SourceControl: 1 },
    ViewColumn: { Active: -1, Beside: -2, One: 1 },
    window: {
      createOutputChannel: (name) => {
        const lines = [];
        const channel = { name, lines, appendLine: (line) => lines.push(line), clear: () => { lines.length = 0; }, show: (preserve) => record('output.show', { name, preserve }), dispose: () => {} };
        outputs.set(name, channel);
        return channel;
      },
      createTreeView: (id, options) => {
        const view = { id, options, dispose: () => {} };
        treeViews.push(view);
        return view;
      },
      withProgress: async (options, task) => {
        record('progress', { options });
        const listeners = [];
        const token = { onCancellationRequested: (l) => { listeners.push(l); return { dispose: () => {} }; } };
        progressTokens.push({ options, cancel: () => listeners.forEach((l) => l()) });
        return task({ report: (value) => record('progress.report', { value }) }, token);
      },
      onDidChangeWindowState: (listener) => { windowStateListeners.add(listener); return { dispose: () => windowStateListeners.delete(listener) }; },
      // The review page. `script.review` answers each review that is shown, in order:
      //   'accept' | 'reject'            click that button
      //   { action: 'retry', feedback }   send feedback
      //   'close'                        the user closes the page
      //   'wait'                         nobody answers (for cancellation tests)
      // An unscripted review fails the test loudly instead of hanging it.
      createWebviewPanel: (viewType, title, showOptions, options) => {
        const messageListeners = [];
        const disposeListeners = [];
        let html = '';
        const panel = {
          viewType, title, showOptions, options, disposed: false, htmls: [], reveals: 0,
          webview: {
            cspSource: 'vscode-webview-resource:',
            onDidReceiveMessage: (l) => { messageListeners.push(l); return { dispose() {} }; },
            get html() { return html; },
            set html(value) {
              html = value;
              panel.htmls.push(value);
              const request = /data-request="([^"]+)"/.exec(value)?.[1];
              if (!request) return; // a progress screen, not a review
              record('review.show', { title: panel.title, html: value });
              const answer = next(script.review);
              if (answer === 'wait') return;
              if (answer === undefined) throw new Error('This test did not script an answer for a review page (script.review)');
              queueMicrotask(() => {
                if (answer === 'close') { panel.dispose(); return; }
                const message = typeof answer === 'string' ? { action: answer } : answer;
                panel.send({ type: 'decision', request, ...message });
              });
            },
          },
          onDidDispose: (l) => { disposeListeners.push(l); return { dispose() {} }; },
          reveal: () => { panel.reveals += 1; },
          // What the page would post; tests also use it to send forged or stale messages.
          send: (message) => messageListeners.forEach((l) => l(message)),
          dispose: () => {
            if (panel.disposed) return;
            panel.disposed = true;
            disposeListeners.forEach((l) => l());
          },
        };
        reviewPanels.push(panel);
        return panel;
      },
      showQuickPick: async (items, options) => { record('quickPick', { items, options }); return next(script.quickPick); },
      showInputBox: async (options) => { record('inputBox', { options }); return next(script.inputBox); },
      showInformationMessage: async (message, ...rest) => { record('information', { message, rest }); return next(script.information); },
      showWarningMessage: async (message, ...rest) => { record('warning', { message, rest }); return next(script.warning); },
      showErrorMessage: async (message, ...rest) => { record('error', { message, rest }); return next(script.error); },
    },
    commands: {
      registerCommand: (id, handler) => {
        commands.set(id, handler);
        return { dispose: () => commands.delete(id) };
      },
      executeCommand: async (id, ...args) => {
        record('executeCommand', { id, args });
        if (id === 'setContext') { contexts.set(args[0], args[1]); return undefined; }
        return commands.has(id) ? commands.get(id)(...args) : undefined;
      },
    },
    env: { clipboard: { text: '', writeText: async (text) => { vscode.env.clipboard.text = text; } } },
    extensions: {
      getExtension: (id) => (id === 'vscode.git' ? fake.gitExtension : undefined),
    },
    workspace: {
      workspaceFolders: folders.map((fsPath) => ({ uri: { fsPath }, name: fsPath.split(/[\\/]/).pop() })),
      getConfiguration: configuration,
      textDocuments: [],
      onDidChangeConfiguration: () => ({ dispose: () => {} }),
      onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
    },
  };

  const context = () => {
    const store = new Map();
    const memento = () => ({
      data: new Map(),
      get(key, fallback) { return this.data.has(key) ? this.data.get(key) : fallback; },
      async update(key, value) { this.data.set(key, value); },
    });
    return {
      subscriptions: [],
      secrets: {
        get: async (key) => store.get(key),
        store: async (key, value) => { store.set(key, value); },
        delete: async (key) => { store.delete(key); },
      },
      globalState: memento(),
      workspaceState: memento(),
      extensionUri: vscode.Uri.file('/ext'),
      secretValues: store,
    };
  };

  return {
    vscode,
    context,
    calls,
    commands,
    contexts,
    script,
    outputs,
    treeViews,
    progressTokens,
    state: fake,
    reviewPanels,
    focusWindow: () => windowStateListeners.forEach((l) => l({ focused: true })),
    callsOf: (kind) => calls.filter((c) => c.kind === kind),
    messages: (kind) => calls.filter((c) => c.kind === kind).map((c) => c.message),
  };
};
