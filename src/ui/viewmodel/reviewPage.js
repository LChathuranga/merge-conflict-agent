// Pure: the review page shown in the editor area while the user judges one proposed resolution.
// It turns data into an HTML string and checks the messages the page sends back; it knows
// nothing about the editor, so all of it is tested directly.
//
// Everything that comes from the repository (code, file names, the model's explanation) is
// untrusted text, so it is only ever inserted through `esc`.

import { reviewNotes } from './approvalModel.js';

export const MAX_FEEDBACK_CHARS = 2000;

export const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const normalize = (text) => String(text ?? '').replace(/\s+/g, ' ').replace(/[;,]+$/, '').trim();
const splitLines = (text) => (text ?? '').split(/\r?\n/);
const MIN_MATCH = 3;

// Tags every line so the page can show what happened to each side's work:
//   ours / theirs: 'kept' (a change this side made is in the proposal), 'dropped' (a change this
//   side made is missing from it), 'context' (unchanged), 'blank'.
//   proposed: 'taken' (comes from one of the sides), 'new' (text neither side had), 'context'.
// A line counts as present when it appears anywhere in the proposal, so a model that squashes
// several lines onto one is not accused of dropping them.
export const classifyLines = ({ ours, theirs, base, resolution }) => {
  const oursLines = splitLines(ours);
  const theirsLines = splitLines(theirs);
  const resolutionLines = splitLines(resolution);
  const oursSet = new Set(oursLines.map(normalize));
  const theirsSet = new Set(theirsLines.map(normalize));
  const baseSet = base === null || base === undefined ? null : new Set(splitLines(base).map(normalize));
  const flat = resolutionLines.map(normalize).filter(Boolean).join(' ');

  const markSide = (lines, otherSet) =>
    lines.map((text) => {
      const n = normalize(text);
      if (!n) return { text, tag: 'blank' };
      const changed = baseSet ? !baseSet.has(n) : !otherSet.has(n);
      if (!changed) return { text, tag: 'context' };
      return { text, tag: flat.includes(n) ? 'kept' : 'dropped' };
    });

  const known = [...oursSet, ...theirsSet, ...(baseSet ?? [])].filter((l) => l.length >= MIN_MATCH);
  const proposed = resolutionLines.map((text) => {
    const n = normalize(text);
    if (!n) return { text, tag: 'blank' };
    if (n.length < MIN_MATCH) return { text, tag: 'context' };
    return { text, tag: known.some((k) => n.includes(k) || k.includes(n)) ? 'taken' : 'new' };
  });

  const oursMarked = markSide(oursLines, theirsSet);
  const theirsMarked = markSide(theirsLines, oursSet);
  const count = (lines, tag) => lines.filter((l) => l.tag === tag).length;
  return {
    ours: oursMarked,
    theirs: theirsMarked,
    proposed,
    counts: {
      oursDropped: count(oursMarked, 'dropped'),
      theirsDropped: count(theirsMarked, 'dropped'),
      newLines: count(proposed, 'new'),
    },
  };
};

// What the page sends back. Anything that is not exactly this, or that refers to a review that
// is no longer on screen, is ignored.
export const parseDecisionMessage = (message, request) => {
  if (!message || typeof message !== 'object') return null;
  if (message.type !== 'decision' || typeof request !== 'string' || message.request !== request) return null;
  if (message.action === 'accept' || message.action === 'reject') return { action: message.action };
  if (message.action === 'retry') {
    const feedback = typeof message.feedback === 'string' ? message.feedback.trim().slice(0, MAX_FEEDBACK_CHARS) : '';
    return { action: 'retry', feedback };
  }
  return null;
};

const ICONS = {
  warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14H1L8 1.5Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6v3.6M8 11.6v.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  info: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7.2v4M8 4.8v.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
};
const NOTE_ICON = { warning: 'warn' };

const TAG_LABEL = { kept: 'in the proposal', dropped: 'missing from the proposal', new: 'new: neither side had it' };
const CONFIDENCE_LABEL = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background);
  font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.5;
}
.page { max-width: 1500px; margin: 0 auto; padding: 22px 28px 0; }
header { margin-bottom: 18px; }
.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
.file { font-size: 1.45em; font-weight: 600; letter-spacing: -0.01em; }
.pill {
  display: inline-flex; align-items: center; padding: 1px 10px; border-radius: 999px; font-size: 0.85em;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
}
.pill.confidence { background: transparent; border: 1px solid currentColor; font-weight: 600; }
.pill.high { color: var(--vscode-testing-iconPassed, #3fb950); }
.pill.medium { color: var(--vscode-editorWarning-foreground, #d29922); }
.pill.low { color: var(--vscode-editorError-foreground, #f85149); }
.headline { margin: 10px 0 2px; font-size: 1.05em; color: var(--vscode-foreground); }
.sub { margin: 0; color: var(--vscode-descriptionForeground); }

.alerts { display: grid; gap: 8px; margin: 0 0 18px; }
.alert {
  display: flex; gap: 10px; align-items: flex-start; padding: 9px 12px; border-radius: 6px;
  border-left: 3px solid var(--tone); background: color-mix(in srgb, var(--tone) 11%, transparent);
}
.alert svg { width: 16px; height: 16px; flex: none; margin-top: 3px; color: var(--tone); }
.alert.warn { --tone: var(--vscode-editorWarning-foreground, #d29922); }
.alert.info { --tone: var(--vscode-editorInfo-foreground, #3794ff); }

.grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); align-items: start; }
.card {
  --accent: var(--vscode-charts-blue, #3794ff);
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); border-top: 3px solid var(--accent);
  border-radius: 8px; background: var(--vscode-editor-background); overflow: hidden; min-width: 0;
}
.card.theirs { --accent: var(--vscode-charts-purple, #b180d7); }
.card.proposed { --accent: var(--vscode-charts-green, #3fb950); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent); }
.card h2 {
  margin: 0; padding: 9px 14px; font-size: 0.95em; font-weight: 600; display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline;
  background: color-mix(in srgb, var(--accent) 9%, transparent); border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
}
.card h2 small { font-weight: 400; color: var(--vscode-descriptionForeground); }
.card h2 .flag { margin-left: auto; font-size: 0.8em; font-weight: 600; color: var(--vscode-editorError-foreground, #f85149); }
.card h2 .flag.note { color: var(--vscode-editorWarning-foreground, #d29922); }
.code { padding: 8px 0; font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); }
.ln { display: grid; grid-template-columns: 3.4ch minmax(0, 1fr); gap: 0 12px; padding: 0 14px; }
.ln .body { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 0 12px; min-width: 0; }
.ln .no { text-align: right; color: var(--vscode-editorLineNumber-foreground, #858585); user-select: none; }
.ln .tx { white-space: pre-wrap; overflow-wrap: anywhere; flex: 1 1 12em; min-width: 0; }
.ln .tag { font-family: var(--vscode-font-family); font-size: 0.78em; margin-left: auto; white-space: nowrap; }
.ln.kept { background: var(--vscode-diffEditor-insertedLineBackground, rgba(63,185,80,.14)); }
.ln.kept .tag { color: var(--vscode-testing-iconPassed, #3fb950); }
.ln.dropped { background: var(--vscode-diffEditor-removedLineBackground, rgba(248,81,73,.16)); }
.ln.dropped .tag { color: var(--vscode-editorError-foreground, #f85149); font-weight: 600; }
.ln.new { background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #d29922) 16%, transparent); }
.ln.new .tag { color: var(--vscode-editorWarning-foreground, #d29922); font-weight: 600; }
.empty { padding: 10px 14px; color: var(--vscode-descriptionForeground); font-style: italic; }
.legend { margin: 10px 2px 0; color: var(--vscode-descriptionForeground); font-size: 0.88em; display: flex; flex-wrap: wrap; gap: 4px 18px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: baseline; }
.legend .k { background: var(--vscode-testing-iconPassed, #3fb950); }
.legend .d { background: var(--vscode-editorError-foreground, #f85149); }
.legend .n { background: var(--vscode-editorWarning-foreground, #d29922); }

.why { margin: 20px 0 0; padding: 14px 16px; border-radius: 8px; background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.1)); border-left: 3px solid var(--vscode-textBlockQuote-border, rgba(128,128,128,.5)); }
.why h3 { margin: 0 0 4px; font-size: 0.9em; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); }
.why p { margin: 0; white-space: pre-wrap; }

.actions {
  position: sticky; bottom: 0; margin-top: 28px; padding: 12px 28px 14px; z-index: 5;
  background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
  box-shadow: 0 -8px 18px rgba(0,0,0,.18);
}
.actions .inner { max-width: 1500px; margin: 0 auto; }
.row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
button {
  font: inherit; cursor: pointer; padding: 6px 16px; border-radius: 4px; border: 1px solid transparent;
  color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.25));
}
button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.35)); }
button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); font-weight: 600; }
button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
button.risky { background: transparent; border-color: var(--vscode-editorWarning-foreground, #d29922); color: var(--vscode-editorWarning-foreground, #d29922); }
button.quiet { background: transparent; color: var(--vscode-textLink-foreground); }
button:focus-visible, textarea:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
button:disabled { opacity: .55; cursor: default; }
.spacer { flex: 1; }
.hint { margin: 8px 0 0; color: var(--vscode-descriptionForeground); font-size: 0.88em; }
#feedback { margin-top: 12px; }
#feedback[hidden] { display: none; }
#feedback label { display: block; font-weight: 600; margin-bottom: 4px; }
textarea {
  width: 100%; min-height: 74px; resize: vertical; padding: 8px 10px; font: inherit; border-radius: 4px;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, rgba(128,128,128,.4));
}
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.sent .actions { opacity: .6; pointer-events: none; }

.working { min-height: 70vh; display: grid; place-content: center; text-align: center; gap: 10px; padding: 24px; }
.spinner { width: 34px; height: 34px; margin: 0 auto 6px; border-radius: 50%; border: 3px solid var(--vscode-panel-border, rgba(128,128,128,.35)); border-top-color: var(--vscode-progressBar-background, #0e70c0); animation: spin 0.9s linear infinite; }
.working h1 { margin: 0; font-size: 1.2em; font-weight: 600; }
.working p { margin: 0; color: var(--vscode-descriptionForeground); }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
`;

const CLIENT_SCRIPT = `
const vscode = acquireVsCodeApi();
const request = document.body.dataset.request;
const form = document.getElementById('feedback');
const note = document.getElementById('feedback-text');
const send = (action, feedback) => {
  document.body.classList.add('sent');
  document.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  vscode.postMessage({ type: 'decision', request, action, feedback });
};
document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => {
    const action = button.dataset.action;
    if (action === 'feedback') { form.hidden = false; note.focus(); return; }
    send(action);
  });
});
document.getElementById('send-feedback').addEventListener('click', () => send('retry', note.value));
document.getElementById('cancel-feedback').addEventListener('click', () => { form.hidden = true; });
note.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send('retry', note.value); }
  if (event.key === 'Escape') { form.hidden = true; }
});
const first = document.querySelector('button.primary');
if (first) first.focus();
`;

const cspFor = (nonce, cspSource) =>
  `default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;

const shell = ({ nonce, cspSource, body, bodyAttrs = '', script = '' }) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${cspFor(nonce, cspSource)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Merge Assistant</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body${bodyAttrs}>
${body}
${script ? `<script nonce="${nonce}">${script}</script>` : ''}
</body>
</html>`;

const codeBlock = (lines, { empty }) => {
  const hasText = lines.some((l) => l.text.trim() !== '');
  if (!hasText) return `<div class="empty">${esc(empty)}</div>`;
  const rows = lines.map(({ text, tag }, i) => {
    const label = TAG_LABEL[tag];
    return `<div class="ln ${tag}"><span class="no">${i + 1}</span><span class="body"><span class="tx">${esc(text) || ' '}</span>${label ? `<span class="tag">${esc(label)}</span>` : ''}</span></div>`;
  });
  return `<div class="code">${rows.join('')}</div>`;
};

const flagFor = (count, text, noteClass = '') =>
  count > 0 ? `<span class="flag ${noteClass}">${count} ${esc(text)}</span>` : '';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// model: { request, file, index, total, attempt, hunk, proposal }
export const renderReviewHtml = (model, { nonce, cspSource }) => {
  const { request, file, index = 0, total = 1, attempt = 0, hunk, proposal } = model;
  const classes = classifyLines({ ours: hunk.ours, theirs: hunk.theirs, base: hunk.base, resolution: proposal.resolution });
  const flags = proposal.flags ?? [];
  const warned = flags.length > 0;
  const lowConfidence = proposal.confidence === 'low';

  const headline = warned
    ? 'Review needed: the safeguards found problems with this proposal.'
    : lowConfidence
      ? 'The model is unsure about this conflict.'
      : 'Check the proposal before it is written.';

  const notes = reviewNotes({ proposal }).filter((n) => n.icon !== 'warning');
  const alerts = [
    ...flags.map((text) => ({ kind: 'warn', text })),
    ...notes.map((n) => ({ kind: n.icon === 'tools' ? 'info' : 'info', text: n.text })),
  ];
  const alertHtml = alerts.length > 0
    ? `<section class="alerts" aria-label="Warnings and notes">${alerts
        .map(({ kind, text }) => `<div class="alert ${kind}" role="${kind === 'warn' ? 'alert' : 'note'}">${ICONS[NOTE_ICON[kind] ?? kind] ?? ICONS.info}<span>${esc(text)}</span></div>`)
        .join('')}</section>`
    : '';

  const confidence = ['high', 'medium', 'low'].includes(proposal.confidence) ? proposal.confidence : 'low';
  const oursLabel = hunk.oursLabel ? `<small>(${esc(hunk.oursLabel)})</small>` : '';
  const theirsLabel = hunk.theirsLabel ? `<small>(${esc(hunk.theirsLabel)})</small>` : '';
  const hasLegend = classes.counts.oursDropped + classes.counts.theirsDropped + classes.counts.newLines > 0
    || [...classes.ours, ...classes.theirs].some((l) => l.tag === 'kept');

  const primaryFirst = warned
    ? `<button class="primary" data-action="feedback">Give feedback</button>
       <button class="risky" data-action="accept" title="The warnings above are real risks">Accept anyway</button>`
    : `<button class="primary" data-action="accept">Accept</button>
       <button data-action="feedback">Give feedback</button>`;

  const body = `<div class="page">
<header>
  <div class="crumbs">
    <span class="file">${esc(file)}</span>
    <span class="pill">Conflict ${index + 1} of ${total}</span>
    ${attempt > 0 ? `<span class="pill">Attempt ${attempt + 1}</span>` : ''}
    <span class="pill confidence ${confidence}">${esc(CONFIDENCE_LABEL[confidence])}</span>
  </div>
  <p class="headline">${esc(headline)}</p>
  <p class="sub">Lines ${hunk.startLine}-${hunk.endLine}. Nothing is written until you accept.</p>
</header>
${alertHtml}
<section class="grid" aria-label="The two sides and the proposal">
  <article class="card ours">
    <h2>Ours ${oursLabel}${flagFor(classes.counts.oursDropped, `${classes.counts.oursDropped === 1 ? 'change' : 'changes'} missing`)}</h2>
    ${codeBlock(classes.ours, { empty: 'This side has nothing here: it removed the code.' })}
  </article>
  <article class="card theirs">
    <h2>Theirs ${theirsLabel}${flagFor(classes.counts.theirsDropped, `${classes.counts.theirsDropped === 1 ? 'change' : 'changes'} missing`)}</h2>
    ${codeBlock(classes.theirs, { empty: 'This side has nothing here: it removed the code.' })}
  </article>
  <article class="card proposed">
    <h2>Proposed <small>what would be written</small>${flagFor(classes.counts.newLines, `new ${plural(classes.counts.newLines, 'line').split(' ')[1]}`, 'note')}</h2>
    ${codeBlock(classes.proposed, { empty: 'The proposal is empty: it would delete this code.' })}
  </article>
</section>
${hasLegend ? `<p class="legend"><span><i class="k"></i>a change this side made is in the proposal</span><span><i class="d"></i>a change this side made is missing from it</span><span><i class="n"></i>text neither side had</span></p>` : ''}
${proposal.explanation ? `<section class="why"><h3>Why the model chose this</h3><p>${esc(proposal.explanation)}</p></section>` : ''}
</div>
<div class="actions"><div class="inner">
  <div class="row">
    ${primaryFirst}
    <span class="spacer"></span>
    <button class="quiet" data-action="reject">Skip this conflict</button>
  </div>
  <form id="feedback" hidden onsubmit="return false">
    <label for="feedback-text">What should change?</label>
    <textarea id="feedback-text" maxlength="${MAX_FEEDBACK_CHARS}" placeholder="For example: keep both values, timeout should stay 60"></textarea>
    <div class="row" style="margin-top:8px">
      <button type="button" class="primary" id="send-feedback">Send feedback</button>
      <button type="button" class="quiet" id="cancel-feedback">Cancel</button>
      <span class="hint">The model sees its rejected answer and your note, then proposes again. Ctrl+Enter sends.</span>
    </div>
  </form>
  <p class="hint">Skipping leaves this conflict's markers in the file. Conflicts you accept are still written.</p>
</div></div>`;

  return shell({ nonce, cspSource, body, bodyAttrs: ` data-request="${esc(request)}"`, script: CLIENT_SCRIPT });
};

// Shown between reviews, and while the model works.
export const renderWorkingHtml = ({ title, detail }, { nonce, cspSource }) =>
  shell({
    nonce,
    cspSource,
    body: `<div class="working" role="status"><div class="spinner" aria-hidden="true"></div><h1>${esc(title)}</h1>${detail ? `<p>${esc(detail)}</p>` : ''}</div>`,
  });
