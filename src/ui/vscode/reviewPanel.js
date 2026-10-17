import { randomBytes, randomUUID } from 'node:crypto';
import { parseDecisionMessage, renderReviewHtml, renderWorkingHtml } from '../viewmodel/reviewPage.js';

const AFTER_DECISION = {
  accept: { title: 'Saved. Continuing...', detail: 'Moving on to the next conflict.' },
  retry: { title: 'Asking the model again...', detail: 'It sees its rejected answer and your feedback.' },
  reject: { title: 'Skipped.', detail: 'This conflict keeps its markers. Continuing with the others.' },
};

// One review page for a whole resolve run: it shows each proposal in turn, with a progress
// screen in between, and is closed when the run ends. Closing it yourself skips the conflict
// being reviewed. The page can only answer the review currently on screen.
// Returns { approve, working, dispose }; `approve` has the shape the orchestrator expects.
export const createReviewer = ({ vscode, signal }) => {
  let panel = null;
  let pending = null;
  let disposed = false;

  const nonce = () => randomBytes(16).toString('base64');
  const show = (html) => {
    if (panel) panel.webview.html = html;
  };
  const showWorking = (text) => {
    if (panel) show(renderWorkingHtml(text, { nonce: nonce(), cspSource: panel.webview.cspSource }));
  };

  const settle = (decision) => {
    if (!pending) return;
    const done = pending;
    pending = null;
    showWorking(AFTER_DECISION[decision.action] ?? AFTER_DECISION.accept);
    done.resolve(decision);
  };

  const open = () => {
    if (panel) return panel;
    panel = vscode.window.createWebviewPanel(
      'mergeAssistant.review',
      'Merge review',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      // Scripts are needed for the buttons; the page loads nothing from disk or the network.
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true }
    );
    panel.webview.onDidReceiveMessage((message) => {
      if (!pending) return;
      const decision = parseDecisionMessage(message, pending.request);
      if (decision) settle(decision);
    });
    panel.onDidDispose(() => {
      panel = null;
      if (pending) {
        const done = pending;
        pending = null;
        done.resolve({ action: 'reject' });
      }
    });
    return panel;
  };

  const dispose = () => {
    disposed = true;
    pending = null;
    const closing = panel;
    panel = null;
    closing?.dispose();
  };
  signal?.addEventListener('abort', dispose, { once: true });

  return {
    approve: ({ file, hunk, proposal, attempt = 0, index = 0, total = 1 }) =>
      new Promise((resolve) => {
        if (disposed) {
          resolve({ action: 'reject' });
          return;
        }
        pending?.resolve({ action: 'reject' });
        const request = randomUUID();
        pending = { request, resolve };
        const view = open();
        view.title = `Review: ${file}`;
        view.webview.html = renderReviewHtml(
          { request, file, index, total, attempt, hunk, proposal },
          { nonce: nonce(), cspSource: view.webview.cspSource }
        );
        view.reveal(vscode.ViewColumn.Active, false);
      }),

    // Progress between reviews. Only updates a page that is already open and not waiting for you.
    working: (text) => {
      if (panel && !pending && text) showWorking(text);
    },

    dispose,
  };
};
