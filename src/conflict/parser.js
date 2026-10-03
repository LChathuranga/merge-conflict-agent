const START = /^<{7}(?: (.*))?$/;
const BASE = /^\|{7}(?: (.*))?$/;
const SEP = /^={7}$/;
const END = /^>{7}(?: (.*))?$/;

// Parses conflict markers (plain and diff3 style) from file text.
// Line numbers are 1-indexed and inclusive of the marker lines.
export const parseConflictHunks = (text) => {
  const lines = text.split(/\r?\n/);
  const hunks = [];
  let current = null;
  let section = null;

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    let m;

    if (!current) {
      if ((m = line.match(START))) {
        current = { startLine: lineNo, endLine: null, oursLabel: m[1] ?? '', theirsLabel: '', ours: [], base: null, theirs: [] };
        section = 'ours';
      }
      return;
    }

    if (section === 'ours' && (m = line.match(BASE))) {
      current.base = [];
      section = 'base';
    } else if ((section === 'ours' || section === 'base') && SEP.test(line)) {
      section = 'theirs';
    } else if (section === 'theirs' && (m = line.match(END))) {
      current.endLine = lineNo;
      current.theirsLabel = m[1] ?? '';
      hunks.push({
        ...current,
        ours: current.ours.join('\n'),
        base: current.base ? current.base.join('\n') : null,
        theirs: current.theirs.join('\n'),
      });
      current = null;
      section = null;
    } else {
      current[section].push(line);
    }
  });

  return hunks;
};

export const hasConflictMarkers = (text) => parseConflictHunks(text).length > 0;
