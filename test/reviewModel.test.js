import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewNotes } from '../src/ui/viewmodel/approvalModel.js';
import { describeEvent, summarizeRun } from '../src/ui/viewmodel/runSummary.js';

const hunk = { startLine: 2, endLine: 8 };
const base = { explanation: 'Keeps the longer session.', confidence: 'high', flags: [], usedElsewhere: [], toolCalls: [] };

test('safeguard flags come first, then usages, then the tools the model used', () => {
  const proposal = {
    ...base,
    flags: ['resolution keeps only one side, so the ours side\'s change would be discarded'],
    usedElsewhere: [{ name: 'SESSION_MINUTES', total: 3, references: [{ file: 'session.js', line: 1 }, { file: 'a.js', line: 4 }, { file: 'b.js', line: 9 }] }],
    toolCalls: [{ name: 'read_file' }, { name: 'read_file' }, { name: 'git_log' }],
  };
  const notes = reviewNotes({ proposal });
  assert.deepEqual(notes.map((n) => n.icon), ['warning', 'references', 'tools']);
  assert.match(notes[0].text, /keeps only one side/);
  assert.equal(notes[1].text, 'SESSION_MINUTES is used in 3 other places (session.js:1, a.js:4, ...)');
  assert.equal(notes[2].text, 'The model inspected the repository: read_file, git_log (3 calls)');
  assert.deepEqual(reviewNotes({ proposal: base }), []);
});

test('a run that resolved everything points at the checks and Source Control, and says nothing was staged', () => {
  const summary = summarizeRun({ files: [{ file: 'a', status: 'resolved' }, { file: 'b', status: 'resolved' }] });
  assert.equal(summary.level, 'info');
  assert.match(summary.message, /Resolved 2 files\./);
  assert.match(summary.message, /Git still lists these files as conflicts until you stage them; nothing was staged or committed for you/);
  assert.deepEqual(summary.buttons, ['Run Checks...', 'Stage Resolved Files...']);
});

test('a mixed run explains what is left and why files failed', () => {
  const summary = summarizeRun({
    files: [
      { file: 'a', status: 'resolved' },
      { file: 'b', status: 'rejected' },
      { file: 'c', status: 'failed', reason: 'model error: bad JSON' },
      { file: 'd', status: 'failed', reason: 'model error: timeout' },
      { file: 'e', status: 'failed', reason: 'third reason is left out' },
    ],
  });
  assert.equal(summary.level, 'warning');
  assert.match(summary.message, /^1 resolved, 1 skipped, 3 failed\. c: model error: bad JSON; d: model error: timeout\. /);
  assert.ok(!summary.message.includes('third reason'));
  assert.match(summary.message, /What you accepted was written; skipped or failed files are untouched\. Run Resolve again to continue with them\./);
  assert.deepEqual(summary.buttons, ['Show Log', 'Run Checks...']);
});

test('a partly resolved file says how many conflicts still have markers and that the accepted ones were kept', () => {
  const summary = summarizeRun({
    files: [
      { file: 'a', status: 'resolved' },
      { file: 'b', status: 'partial', remaining: 2 },
      { file: 'c', status: 'partial', remaining: 1, reason: 'model error: timeout' },
    ],
  });
  assert.match(summary.message, /^1 resolved, 2 partly resolved\. c: model error: timeout\. /);
  assert.match(summary.message, /What you accepted was written; 3 conflicts still have markers, and skipped or failed files are untouched\./);
  assert.equal(summary.level, 'warning', 'a model error is worth a warning');
  assert.deepEqual(summary.buttons, ['Show Log', 'Run Checks...']);

  const calm = summarizeRun({ files: [{ file: 'b', status: 'partial', remaining: 1 }] });
  assert.equal(calm.level, 'info', 'skipping a conflict yourself is not a warning');
  assert.match(calm.message, /^1 partly resolved\. What you accepted was written; 1 conflict still has markers/);
  assert.deepEqual(calm.buttons, ['Run Checks...']);

  const cancelled = summarizeRun({ files: [{ file: 'b', status: 'partial', remaining: 1 }], cancelled: true, total: 2 });
  assert.match(cancelled.message, /^Cancelled\. 0 of 2 files were resolved before you stopped; 2 are still conflicted\./);
});

test('a cancelled run reports what was finished and what was not touched', () => {
  const summary = summarizeRun({ files: [{ file: 'a', status: 'resolved' }], cancelled: true, total: 3 });
  assert.equal(summary.level, 'warning');
  assert.equal(summary.message, 'Cancelled. 1 of 3 files was resolved before you stopped; 2 are still conflicted.');
  assert.deepEqual(summary.buttons, ['Open Source Control']);
  assert.deepEqual(summarizeRun({ files: [], cancelled: true, total: 2 }).buttons, []);
  assert.match(summarizeRun({ files: [], cancelled: true, total: 1 }).message, /0 of 1 file was resolved before you stopped; 1 is still conflicted/);
});

test('an empty or all-skipped run does not claim success', () => {
  assert.match(summarizeRun({ files: [] }).message, /^Nothing was resolved\./);
  const skipped = summarizeRun({ files: [{ file: 'a', status: 'rejected' }] });
  assert.match(skipped.message, /^1 skipped\./);
  assert.deepEqual(skipped.buttons, []);
});

test('events become short log lines and progress text, and never contain code', () => {
  const hunkEvent = { file: 'auth.js', hunk, attempt: 1 };
  assert.deepEqual(describeEvent({ type: 'proposing', ...hunkEvent }), { log: 'auth.js:2 proposing (attempt 2)', progress: 'Re-analyzing auth.js:2' });
  assert.equal(describeEvent({ type: 'proposing', file: 'a.js', hunk, attempt: 0 }).progress, 'Analyzing a.js:2');

  const proposed = describeEvent({ type: 'proposed', file: 'a.js', hunk, asksUser: true, proposal: { confidence: 'low', flags: ['x'], resolution: 'SECRET CODE' } });
  assert.match(proposed.log, /confidence low, 1 flag\(s\), needs review/);
  assert.ok(!JSON.stringify(proposed).includes('SECRET CODE'));
  assert.equal(proposed.progress, 'Waiting for your review of a.js:2');
  assert.equal(describeEvent({ type: 'proposed', file: 'a.js', hunk, asksUser: false, proposal: { confidence: 'high', flags: [] } }).progress, undefined);

  assert.equal(describeEvent({ type: 'tool-call', agent: 'Conflict Agent', label: 'read_file(path="a.js")', ok: true }).log, '[Conflict Agent] tool: read_file(path="a.js")');
  assert.match(describeEvent({ type: 'tool-call', agent: 'x', label: 'y', ok: false }).log, /tool failed/);
  assert.equal(describeEvent({ type: 'resolved', file: 'a.js' }).progress, 'Resolved a.js');
  assert.equal(describeEvent({ type: 'validating', name: 'lint', command: 'npm run lint' }).progress, 'Running lint...');
  assert.deepEqual(describeEvent({ type: 'something-new' }), {});
});
