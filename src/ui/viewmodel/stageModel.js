// Pure: which files are ready to be marked resolved, and what the user must be told first.

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Only files this extension resolved, and that have no conflict markers left. A file that
// merely has no markers (a delete or rename conflict, say) needs a human decision, not a click.
export const stageableFiles = (state) =>
  state.files.filter((f) => f.status === 'resolved' && f.hunks.length === 0).map((f) => f.path);

// lines: the text of the confirmation. severity 'danger' when the checks failed on this code.
export const stageNotes = (state, ready) => {
  const lines = ready.map((f) => `  ${f}`);
  lines.unshift(`These ${plural(ready.length, 'file')} will be marked resolved in Git (git add):`);

  const validation = state.validation;
  let severity = 'normal';
  lines.push('');
  if (validation?.passed) {
    lines.push('The checks passed on this code.');
  } else if (validation && validation.ran && !validation.cancelled) {
    severity = 'danger';
    lines.push('WARNING: the checks FAILED on this code. Staging does not fix that; it only marks the files resolved.');
  } else {
    lines.push('The checks have not been run on this code.');
  }

  const left = state.files.filter((f) => !ready.includes(f.path));
  if (left.length > 0) {
    const names = left.slice(0, 4).map((f) => f.path).join(', ');
    lines.push(`${plural(left.length, 'other file')} stay conflicted: ${names}${left.length > 4 ? ', ...' : ''}.`);
  }
  lines.push('', 'This does not commit. You review and commit in Source Control.');
  return { lines, severity };
};
