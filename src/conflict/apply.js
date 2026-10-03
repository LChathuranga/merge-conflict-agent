// Replaces each hunk's marker block with its resolution text.
// items: [{ hunk, resolution }] where hunk comes from parseConflictHunks(text).
export const applyResolutions = (text, items) => {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);

  [...items]
    .sort((a, b) => b.hunk.startLine - a.hunk.startLine)
    .forEach(({ hunk, resolution }) => {
      const replacement = resolution === '' ? [] : resolution.split(/\r?\n/);
      lines.splice(hunk.startLine - 1, hunk.endLine - hunk.startLine + 1, ...replacement);
    });

  return lines.join(eol);
};
