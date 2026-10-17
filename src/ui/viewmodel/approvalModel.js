// Pure: what the reviewer sees for one proposed resolution. The VS Code layer renders these
// descriptors in a quick pick; nothing here knows about the editor.

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Why the reviewer is being asked at all: safeguards first (the ones the model cannot talk its
// way past), then what the proposal touches elsewhere, then what the model looked at.
export const reviewNotes = ({ proposal }) => {
  const notes = [];
  for (const flag of proposal.flags ?? []) notes.push({ icon: 'warning', text: flag });

  for (const { name, total, references } of proposal.usedElsewhere ?? []) {
    const where = references.slice(0, 2).map((r) => `${r.file}:${r.line}`).join(', ');
    notes.push({ icon: 'references', text: `${name} is used in ${plural(total, 'other place')} (${where}${total > 2 ? ', ...' : ''})` });
  }

  if (proposal.toolCalls?.length) {
    const names = [...new Set(proposal.toolCalls.map((c) => c.name))].join(', ');
    notes.push({ icon: 'tools', text: `The model inspected the repository: ${names} (${plural(proposal.toolCalls.length, 'call')})` });
  }
  return notes;
};
