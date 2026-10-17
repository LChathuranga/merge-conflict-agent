import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/ui/viewmodel/session.js';
import { buildTree, flatten } from '../src/ui/viewmodel/treeModel.js';

const git = (overrides = {}) => ({
  branch: 'main',
  detached: false,
  operation: 'merge',
  theirs: { sha: 'abc', label: 'feature' },
  files: [
    { path: 'auth.js', hunks: [{ startLine: 2, endLine: 8 }] },
    { path: 'price.js', hunks: [{ startLine: 3, endLine: 11 }, { startLine: 20, endLine: 27 }] },
  ],
  ...overrides,
});

const open = () => {
  const session = createSession();
  session.setRepo({ root: '/repo', name: 'repo' });
  session.syncGit(git());
  return session;
};
const byId = (session, id, opts) => flatten(buildTree(session.state, opts)).find((n) => n.id === id);
const stepTexts = (session) => buildTree(session.state).map((n) => `${n.label}: ${n.description}`);

test('no repository, or no merge in progress, shows nothing so the welcome content appears', () => {
  const session = createSession();
  assert.deepEqual(buildTree(session.state), []);
  session.setRepo({ root: '/repo', name: 'repo' });
  session.syncGit(git({ operation: null, files: [] }));
  assert.deepEqual(buildTree(session.state), []);
  session.syncGit(git({ operation: 'rebase' }));
  assert.deepEqual(buildTree(session.state), [], 'only a merge gets the guided steps');
});

test('a conflicted merge shows the four steps with files and hunks', () => {
  const session = open();
  const tree = buildTree(session.state);
  assert.deepEqual(tree.map((n) => n.label), ['1. Merge', '2. Conflicts', '3. Review', '4. Validate']);
  assert.equal(tree[0].description, 'feature into main');
  assert.equal(tree[1].description, '0 of 2 resolved');

  const files = tree[1].children;
  assert.deepEqual(files.map((f) => f.id), ['file:auth.js', 'file:price.js']);
  assert.equal(files[1].children.length, 2);
  assert.deepEqual(files[1].children[1].command.args, ['price.js', 20], 'a hunk opens the file at its line');
  assert.equal(files[0].contextValue, 'conflictFile', 'the resolve button appears on idle conflicted files');
  assert.equal(tree.find((n) => n.id === 'step:next'), undefined, 'not ready to commit yet');
});

test('ids are stable across a refresh, so selection and expansion survive', () => {
  const session = open();
  const before = flatten(buildTree(session.state)).map((n) => n.id);
  session.syncGit(git());
  assert.deepEqual(flatten(buildTree(session.state)).map((n) => n.id), before);
  assert.equal(new Set(before).size, before.length, 'ids are unique');
});

test('run events move a file through working, review and resolved', () => {
  const session = open();
  const hunk = { startLine: 2, endLine: 8 };

  session.handleEvent({ type: 'proposing', file: 'auth.js', hunk, attempt: 0 });
  assert.equal(byId(session, 'file:auth.js').icon.id, 'loading~spin');
  assert.match(byId(session, 'review:current').label, /^Proposing: auth\.js lines 2-8$/);

  session.handleEvent({ type: 'proposed', file: 'auth.js', hunk, asksUser: true, proposal: { confidence: 'low' }, attempt: 0 });
  assert.equal(byId(session, 'file:auth.js').icon.id, 'eye');
  assert.match(byId(session, 'review:current').label, /^Waiting for you: auth\.js lines 2-8$/);
  assert.equal(byId(session, 'file:auth.js').contextValue, 'conflictFileBusy', 'no resolve button while it is being worked on');

  session.handleEvent({ type: 'proposing', file: 'auth.js', hunk, attempt: 1 });
  assert.match(byId(session, 'review:current').label, /attempt 2/);

  session.handleEvent({ type: 'resolved', file: 'auth.js' });
  assert.equal(byId(session, 'file:auth.js').icon.id, 'check');
  assert.equal(byId(session, 'hunk:auth.js:2').icon.id, 'check');
  assert.equal(buildTree(session.state)[1].description, '1 of 2 resolved');
});

test('skipped and failed files stay visible in Review with their reasons', () => {
  const session = open();
  session.beginRun('resolve');
  session.handleEvent({ type: 'rejected', file: 'auth.js' });
  session.handleEvent({ type: 'failed', file: 'price.js' });
  session.recordResults([{ file: 'price.js', status: 'failed', reason: 'model error: bad JSON' }]);
  session.endRun();

  const review = buildTree(session.state)[2];
  assert.equal(review.description, '1 skipped, 1 failed');
  assert.deepEqual(review.children.map((c) => `${c.label}: ${c.description}`), ['auth.js: skipped by you', 'price.js: model error: bad JSON']);
  assert.equal(byId(session, 'file:auth.js').contextValue, 'conflictFile', 'a skipped file can be retried');
});

test('after a run ends nothing is left looking busy', () => {
  const session = open();
  session.beginRun('resolve');
  session.handleEvent({ type: 'proposing', file: 'auth.js', hunk: { startLine: 2, endLine: 8 }, attempt: 0 });
  session.endRun();
  assert.equal(byId(session, 'file:auth.js').icon.id, 'circle-outline');
  assert.equal(byId(session, 'hunk:auth.js:2').icon.id, 'circle-outline');
  assert.equal(buildTree(session.state)[2].children.length, 0);
});

test('a reload mid-merge rebuilds the same view from git alone', () => {
  const live = open();
  live.beginRun('resolve');
  live.handleEvent({ type: 'resolved', file: 'auth.js' });
  live.endRun();

  const reloaded = createSession();
  reloaded.setRepo({ root: '/repo', name: 'repo' });
  reloaded.syncGit(git({ files: [{ path: 'price.js', hunks: [{ startLine: 3, endLine: 11 }] }, { path: 'auth.js', hunks: [] }] }));
  assert.equal(byId(reloaded, 'file:auth.js').icon.id, 'tools', 'a file without markers is honestly reported, not assumed resolved');
  assert.match(byId(reloaded, 'file:auth.js').description, /no conflict markers/);
  assert.equal(byId(reloaded, 'file:price.js').icon.id, 'circle-outline');
});

test('files resolved by this session stay resolved even though git still lists them as unmerged', () => {
  const session = open();
  session.beginRun('resolve');
  session.handleEvent({ type: 'resolved', file: 'auth.js' });
  session.endRun();
  session.syncGit(git({ files: [{ path: 'auth.js', hunks: [] }, { path: 'price.js', hunks: [{ startLine: 3, endLine: 11 }] }] }));
  assert.equal(byId(session, 'file:auth.js').icon.id, 'check');
  assert.equal(byId(session, 'file:auth.js').contextValue, 'conflictFileBusy');
});

test('when every conflict is resolved the only next step is to commit in Source Control', () => {
  const session = open();
  session.beginRun('resolve');
  ['auth.js', 'price.js'].forEach((file) => session.handleEvent({ type: 'resolved', file }));
  session.endRun();

  const next = buildTree(session.state).find((n) => n.id === 'step:next');
  assert.equal(next.command.id, 'workbench.view.scm');
  assert.match(next.tooltip, /never stages or commits/);
  assert.equal(buildTree(session.state, { busy: true }).find((n) => n.id === 'step:next'), undefined);
});

test('a clean merge has no conflicts and goes straight to review-and-commit', () => {
  const session = createSession();
  session.setRepo({ root: '/repo', name: 'repo' });
  session.syncGit(git({ files: [] }));
  const tree = buildTree(session.state);
  assert.equal(tree[0].children[0].label, 'Merged without conflicts');
  assert.equal(tree[1].description, 'none');
  assert.ok(tree.some((n) => n.id === 'step:next'));
});

test('validation progress and results appear under step 4', () => {
  const session = open();
  assert.equal(stepTexts(session)[3], '4. Validate: not run');

  session.beginRun('validate');
  session.handleEvent({ type: 'validating', name: 'focused tests', command: 'node --test' });
  assert.equal(stepTexts(session)[3], '4. Validate: running focused tests');

  session.setValidation({ ran: true, passed: false, cancelled: false, steps: [
    { name: 'focused tests', command: 'node --test "a.test.js"', status: 'failed', exitCode: 1 },
    { name: 'test', command: 'npm run test', status: 'skipped' },
  ] });
  session.endRun();
  const validate = buildTree(session.state)[3];
  assert.equal(validate.description, 'failed');
  assert.deepEqual(validate.children.map((c) => c.description), ['failed (exit 1)', 'skipped']);
  assert.equal(validate.children[0].command.id, 'mergeAssistant.showOutput');

  session.setValidation({ ran: true, passed: true, cancelled: false, steps: [{ name: 'test', command: 'npm run test', status: 'passed' }] });
  assert.equal(buildTree(session.state)[3].description, 'passed');
});

test('finishing or aborting the merge clears everything, and changes notify listeners', () => {
  const session = open();
  let changes = 0;
  const stop = session.onDidChange(() => { changes += 1; });
  session.setValidation({ ran: true, passed: true, cancelled: false, steps: [] });
  assert.equal(changes, 1);

  session.syncGit(git({ operation: null, files: [] }));
  assert.deepEqual(buildTree(session.state), []);
  assert.equal(session.state.validation, null);
  assert.equal(session.state.files.length, 0);

  stop();
  session.setValidation(null);
  assert.equal(changes, 2, 'unsubscribed listeners are not called');
});

test('once staged, an empty conflict list means "handled", not "never had conflicts"', () => {
  const session = open();
  session.syncGit(git({ files: [] }));
  const tree = buildTree(session.state);
  assert.equal(tree[0].children[0].label, 'All conflicts are handled');
  assert.equal(tree[1].description, 'all handled');
  assert.ok(tree.some((n) => n.id === 'step:next'));
});

test('a refresh from git keeps what a run decided about files that still have conflicts', () => {
  const session = open();
  session.beginRun('resolve');
  session.handleEvent({ type: 'rejected', file: 'auth.js' });
  session.handleEvent({ type: 'failed', file: 'price.js' });
  session.recordResults([
    { file: 'auth.js', status: 'rejected' },
    { file: 'price.js', status: 'failed', reason: 'model error: timeout' },
  ]);
  session.endRun();

  session.syncGit(git()); // what happens after every run and every git change
  assert.equal(byId(session, 'file:auth.js').icon.id, 'circle-slash', 'skipped stays skipped');
  assert.equal(byId(session, 'file:price.js').icon.id, 'error', 'failed stays failed');
  assert.equal(byId(session, 'review:price.js').description, 'model error: timeout', 'and keeps its reason');

  // Once the file has no markers left, the old decision no longer applies.
  session.syncGit(git({ files: [{ path: 'auth.js', hunks: [] }, { path: 'price.js', hunks: [{ startLine: 3, endLine: 11 }] }] }));
  assert.equal(byId(session, 'file:auth.js').icon.id, 'tools');
});

test('a different repository starts from a blank session', () => {
  const session = open();
  session.setRepo({ root: '/other', name: 'other' });
  assert.equal(session.state.files.length, 0);
  assert.equal(session.state.branch, null);
});

test('step rows that name an action perform it when clicked, and only when it can run', () => {
  const session = open();

  // Conflicts still unresolved: Review offers to resolve, Validate does not offer checks yet.
  let tree = buildTree(session.state);
  const review = tree.find((n) => n.id === 'step:review');
  const validate = tree.find((n) => n.id === 'step:validate');
  assert.equal(review.command.id, 'mergeAssistant.resolveAll');
  assert.match(review.description, /click to resolve with AI/);
  assert.equal(validate.command, undefined, 'checks need code that can run');
  assert.match(validate.tooltip, /Resolve the conflicts first/);

  // While a run is busy, neither row starts another task.
  tree = buildTree(session.state, { busy: true });
  assert.equal(tree.find((n) => n.id === 'step:review').command, undefined);
  assert.equal(tree.find((n) => n.id === 'step:validate').command, undefined);

  // Everything resolved: nothing left to resolve, checks can run.
  session.syncGit(git({ files: [{ path: 'auth.js', hunks: [] }, { path: 'price.js', hunks: [] }] }));
  tree = buildTree(session.state);
  assert.equal(tree.find((n) => n.id === 'step:review').command, undefined);
  assert.equal(tree.find((n) => n.id === 'step:validate').command.id, 'mergeAssistant.runChecks');
  assert.match(tree.find((n) => n.id === 'step:validate').description, /click to run checks/);
});
