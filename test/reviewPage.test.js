import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLines, esc, parseDecisionMessage, renderReviewHtml, renderWorkingHtml, MAX_FEEDBACK_CHARS } from '../src/ui/viewmodel/reviewPage.js';
import { describeWorking } from '../src/ui/viewmodel/runSummary.js';

const hunk = {
  startLine: 3, endLine: 11, oursLabel: 'HEAD', theirsLabel: 'feature',
  ours: '  const tax = subtotal * 0.2;\n  return subtotal + tax;',
  theirs: '  const discount = subtotal * 0.1;\n  return subtotal - discount;',
  base: '  return subtotal;',
};
const proposal = {
  resolution: 'return subtotal + tax - discount;', explanation: 'Combine both.', confidence: 'medium',
  flags: [], usedElsewhere: [], toolCalls: [],
};
const options = { nonce: 'NONCE123', cspSource: 'vscode-webview:' };
const render = (over = {}, extra = {}) => renderReviewHtml({ request: 'req-1', file: 'price.js', index: 0, total: 1, attempt: 0, hunk, proposal, ...over }, { ...options, ...extra });
const tags = (lines) => lines.map((l) => l.tag);

test('lines a side changed are marked kept or dropped, so what is missing is visible', () => {
  const c = classifyLines({ ours: hunk.ours, theirs: hunk.theirs, base: hunk.base, resolution: proposal.resolution });
  assert.deepEqual(tags(c.ours), ['dropped', 'kept'], 'the tax definition is gone; the return line is in the proposal');
  assert.deepEqual(tags(c.theirs), ['dropped', 'dropped']);
  assert.deepEqual(c.counts, { oursDropped: 1, theirsDropped: 2, newLines: 0 });
});

test('unchanged lines and blank lines are never flagged', () => {
  const c = classifyLines({ ours: 'keep\nname = 1\n\nend', theirs: 'keep\nname = 2\n\nend', base: 'keep\nname = 0\n\nend', resolution: 'keep\nname = 1\nname = 2\n\nend' });
  assert.deepEqual(tags(c.ours), ['context', 'kept', 'blank', 'context']);
  assert.deepEqual(tags(c.theirs), ['context', 'kept', 'blank', 'context']);
  assert.equal(c.counts.oursDropped + c.counts.theirsDropped, 0);
});

test('a model that squashes lines together is not accused of dropping them', () => {
  const c = classifyLines({ ours: '  timeout: 60,', theirs: '  timeout: 30,\n  retries: 3,', base: '  timeout: 30,', resolution: 'timeout: 60, retries: 3' });
  assert.deepEqual(tags(c.ours), ['kept']);
  assert.deepEqual(tags(c.theirs), ['context', 'kept']);
  assert.deepEqual(tags(c.proposed), ['taken'], 'the combined line comes from both sides');
});

test('text neither side had is marked new, and trailing semicolons and commas do not matter', () => {
  const c = classifyLines({ ours: 'const a = 1;', theirs: 'const a = 2;', base: 'const a = 0;', resolution: 'const a = 1\nconst invented = 99;' });
  assert.deepEqual(tags(c.proposed), ['taken', 'new']);
  assert.equal(c.counts.newLines, 1);
  assert.deepEqual(tags(c.ours), ['kept'], 'the missing semicolon still counts as present');
});

test('without a base, a side is compared with the other side; short structural lines are ignored', () => {
  const c = classifyLines({ ours: 'shared\nours only', theirs: 'shared\ntheirs only', base: null, resolution: 'shared\nours only\n}' });
  assert.deepEqual(tags(c.ours), ['context', 'kept']);
  assert.deepEqual(tags(c.theirs), ['context', 'dropped']);
  assert.deepEqual(tags(c.proposed), ['taken', 'taken', 'context'], 'a lone brace is structure, not invention');
});

test('a side that removed the code shows as empty, and an empty proposal says it deletes', () => {
  const html = render({ hunk: { ...hunk, theirs: '', base: hunk.ours }, proposal: { ...proposal, resolution: '' } });
  assert.match(html, /This side has nothing here: it removed the code\./);
  assert.match(html, /The proposal is empty: it would delete this code\./);
});

test('everything from the repository is escaped, including a script-closing tag in code or the explanation', () => {
  const evil = '</script><img src=x onerror=alert(1)>"\'&';
  const html = render({
    file: `a${evil}.js`,
    hunk: { ...hunk, ours: evil, theirs: evil, oursLabel: evil, theirsLabel: evil, base: null },
    proposal: { ...proposal, resolution: evil, explanation: evil, flags: [evil], usedElsewhere: [{ name: evil, total: 1, references: [{ file: evil, line: 1 }] }] },
  });
  assert.ok(!html.includes('<img src=x'), 'no injected tag survives');
  assert.ok(!html.includes('onerror=alert(1)>'), 'no injected attribute survives');
  assert.equal((html.match(/<script/g) ?? []).length, 1, 'only the page\'s own script exists');
  assert.equal((html.match(/<\/script>/g) ?? []).length, 1);
  assert.match(html, /&lt;\/script&gt;&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/);
  assert.equal(esc(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(esc(undefined), '');
});

test('the content security policy allows only this page\'s own nonce-tagged script and style', () => {
  const html = render();
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-NONCE123'/);
  assert.match(csp, /style-src vscode-webview: 'nonce-NONCE123'/);
  assert.ok(!/unsafe-inline|unsafe-eval|https?:|\*/.test(csp), 'nothing is loaded from anywhere');
  assert.match(html, /<style nonce="NONCE123">/);
  assert.match(html, /<script nonce="NONCE123">/);
  assert.ok(!/<link|<img|<iframe|src="http|href="http/.test(html));
  assert.match(html, /<body data-request="req-1">/);
});

test('with no warnings the first button is Accept; with warnings it is Give feedback and Accept says "anyway"', () => {
  const plain = render();
  assert.match(plain, /<button class="primary" data-action="accept">Accept<\/button>/);
  assert.doesNotMatch(plain, /Accept anyway/);
  assert.match(plain, /Check the proposal before it is written\./);

  const warned = render({ proposal: { ...proposal, confidence: 'high', flags: ['"tax" is removed but is still used in 2 other places (a.js:1, b.js:2)'] } });
  assert.match(warned, /<button class="primary" data-action="feedback">Give feedback<\/button>\s*<button class="risky" data-action="accept"[^>]*>Accept anyway<\/button>/);
  assert.match(warned, /Review needed: the safeguards found problems with this proposal\./);
  assert.match(warned, /<div class="alert warn" role="alert">[\s\S]*&quot;tax&quot; is removed but is still used in 2 other places/);
  assert.match(warned, /data-action="reject">Skip this conflict<\/button>/);
});

test('the page says which conflict of how many, which attempt, and how sure the model is', () => {
  const html = render({ index: 1, total: 3, attempt: 2, proposal: { ...proposal, confidence: 'low' } });
  assert.match(html, /Conflict 2 of 3/);
  assert.match(html, /Attempt 3/);
  assert.match(html, /pill confidence low">Low confidence/);
  assert.match(html, /The model is unsure about this conflict\./);
  assert.match(html, /Lines 3-11\. Nothing is written until you accept\./);
  assert.doesNotMatch(render(), /Attempt \d/);
  assert.match(render(), /Conflict 1 of 1/);
});

test('missing changes and new lines are called out in the card headers and the lines themselves', () => {
  const html = render();
  assert.match(html, /<h2>Ours <small>\(HEAD\)<\/small><span class="flag ">1 change missing<\/span><\/h2>/);
  assert.match(html, /<h2>Theirs <small>\(feature\)<\/small><span class="flag ">2 changes missing<\/span><\/h2>/);
  assert.match(html, /<div class="ln dropped"><span class="no">1<\/span><span class="body"><span class="tx">  const tax = subtotal \* 0\.2;<\/span><span class="tag">missing from the proposal<\/span>/);
  assert.match(html, /<div class="ln kept">[\s\S]*in the proposal/);
  assert.match(html, /class="legend"/);

  const invented = render({ proposal: { ...proposal, resolution: 'return 42;' } });
  assert.match(invented, /<span class="flag note">1 new line<\/span>/);
  assert.match(invented, /<div class="ln new">[\s\S]*new: neither side had it/);
});

test('the three cards, the explanation, the notes and the feedback form are all present', () => {
  const html = render({ proposal: { ...proposal, usedElsewhere: [{ name: 'SESSION_MINUTES', total: 3, references: [{ file: 'session.js', line: 1 }] }], toolCalls: [{ name: 'read_file' }] } });
  for (const card of ['card ours', 'card theirs', 'card proposed']) assert.match(html, new RegExp(card));
  assert.match(html, /Why the model chose this[\s\S]*Combine both\./);
  assert.match(html, /SESSION_MINUTES is used in 3 other places \(session\.js:1/);
  assert.match(html, /The model inspected the repository: read_file/);
  assert.match(html, /<form id="feedback" hidden/);
  assert.match(html, /maxlength="2000"/);
  assert.match(html, /Skipping leaves this conflict's markers in the file\. Conflicts you accept are still written\./);
  assert.match(html, /aria-label="The two sides and the proposal"/);
});

test('the progress screen escapes its text and carries no review request', () => {
  const html = renderWorkingHtml({ title: 'Analyzing <b>x</b>', detail: 'Conflict 1 of 2' }, options);
  assert.match(html, /Analyzing &lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /data-request/);
  assert.doesNotMatch(html, /<script/);
});

test('only an exact decision for the review on screen is accepted', () => {
  assert.deepEqual(parseDecisionMessage({ type: 'decision', request: 'r', action: 'accept' }, 'r'), { action: 'accept' });
  assert.deepEqual(parseDecisionMessage({ type: 'decision', request: 'r', action: 'reject' }, 'r'), { action: 'reject' });
  assert.deepEqual(parseDecisionMessage({ type: 'decision', request: 'r', action: 'retry', feedback: '  keep both  ' }, 'r'), { action: 'retry', feedback: 'keep both' });
  assert.deepEqual(parseDecisionMessage({ type: 'decision', request: 'r', action: 'retry' }, 'r'), { action: 'retry', feedback: '' });
  assert.equal(parseDecisionMessage({ type: 'decision', request: 'r', action: 'retry', feedback: 'x'.repeat(MAX_FEEDBACK_CHARS + 500) }, 'r').feedback.length, MAX_FEEDBACK_CHARS);
  assert.equal(parseDecisionMessage({ type: 'decision', request: 'r', action: 'retry', feedback: 42 }, 'r').feedback, '');

  for (const bad of [null, undefined, 'accept', 42, [], {}, { type: 'decision' },
    { type: 'decision', request: 'old', action: 'accept' },
    { type: 'other', request: 'r', action: 'accept' },
    { type: 'decision', request: 'r', action: 'edit', resolution: 'x' },
    { type: 'decision', request: 'r', action: 'delete-everything' },
    { type: 'decision', request: 'r', action: ['accept'] }]) {
    assert.equal(parseDecisionMessage(bad, 'r'), null, JSON.stringify(bad));
  }
  assert.equal(parseDecisionMessage({ type: 'decision', request: undefined, action: 'accept' }, undefined), null, 'no request id means nothing is on screen');
});

test('the in-between progress text names the file, which conflict, and feedback rounds', () => {
  assert.deepEqual(describeWorking({ type: 'proposing', file: 'a.js', hunk: { startLine: 3, endLine: 9 }, index: 1, total: 3, attempt: 0 }),
    { title: 'Analyzing a.js', detail: 'Conflict 2 of 3 (lines 3-9)' });
  assert.deepEqual(describeWorking({ type: 'proposing', file: 'a.js', hunk: { startLine: 3, endLine: 9 }, index: 0, total: 1, attempt: 1 }),
    { title: 'Thinking again about a.js', detail: 'The conflict (lines 3-9), using your feedback' });
  assert.equal(describeWorking({ type: 'resolved', file: 'a.js' }), null);
});

test('the page shows the code around the conflict, escaped, with other conflicts marked', () => {
  const lines = ['// top <b>', 'before', '<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> feature', 'between', '<<<<<<< HEAD', 'c', '=======', 'd', '>>>>>>> feature', 'end'];
  const first = { ...hunk, startLine: 3, endLine: 7 };
  const html = render({ hunk: first, fileText: lines.join('\n') });
  assert.match(html, /Around this conflict in the file/);
  assert.match(html, /\/\/ top &lt;b&gt;/, 'file text is escaped');
  assert.match(html, /<span class="tx">between<\/span>/);
  assert.match(html, /Conflict lines 3-7 \(shown in the three boxes above\)/);
  assert.equal((html.match(/another conflict/g) ?? []).length, 6, 'its three marker lines are labelled in both the short and the whole-file view');
  assert.match(html, /Show the whole file \(14 lines\)/);
  assert.doesNotMatch(render({ hunk: first }), /Around this conflict/, 'no file text, no section');
});
