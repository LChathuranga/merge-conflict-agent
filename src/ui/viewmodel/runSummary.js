// Pure: the message shown when a resolve run ends, and what each orchestrator event adds to the
// log and the progress notification. Logs name files and statuses, never code.

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const REASON_LIMIT = 2;

// files: the per-file results of the run. total: how many files the run was asked to handle.
export const summarizeRun = ({ files, cancelled = false, total = files.length }) => {
  const by = (...statuses) => files.filter((f) => statuses.includes(f.status));
  const resolved = by('resolved');
  const partial = by('partial');
  const skipped = by('rejected', 'skipped');
  const failed = by('failed');
  const untouched = Math.max(0, total - files.length);

  if (cancelled) {
    const left = untouched + partial.length + skipped.length + failed.length;
    return {
      level: 'warning',
      message: `Cancelled. ${resolved.length} of ${plural(total, 'file')} ${resolved.length === 1 || total === 1 ? 'was' : 'were'} resolved before you stopped; ${left} ${left === 1 ? 'is' : 'are'} still conflicted.`,
      buttons: resolved.length > 0 ? ['Open Source Control'] : [],
    };
  }

  if (resolved.length === files.length && files.length > 0) {
    return {
      level: 'info',
      message: `Resolved ${plural(resolved.length, 'file')}. Review the changes and run the checks. Git still lists these files as conflicts until you stage them; nothing was staged or committed for you.`,
      buttons: ['Run Checks...', 'Stage Resolved Files...'],
    };
  }

  const parts = [];
  if (resolved.length) parts.push(`${resolved.length} resolved`);
  if (partial.length) parts.push(`${partial.length} partly resolved`);
  if (skipped.length) parts.push(`${skipped.length} skipped`);
  if (failed.length) parts.push(`${failed.length} failed`);
  const why = [...partial, ...failed]
    .filter((f) => f.reason)
    .slice(0, REASON_LIMIT)
    .map((f) => `${f.file}: ${f.reason}`)
    .join('; ');
  const leftConflicts = partial.reduce((sum, f) => sum + (f.remaining ?? 0), 0);

  const advice = partial.length + skipped.length + failed.length > 0
    ? ` What you accepted was written; ${leftConflicts > 0 ? `${plural(leftConflicts, 'conflict')} still ${leftConflicts === 1 ? 'has' : 'have'} markers, and ` : ''}skipped or failed files are untouched. Run Resolve again to continue with them.`
    : '';

  return {
    level: failed.length > 0 || (why && partial.length > 0) ? 'warning' : 'info',
    message: `${parts.join(', ') || 'Nothing was resolved'}.${why ? ` ${why}.` : ''}${advice}`,
    buttons: [...(why ? ['Show Log'] : []), ...(resolved.length > 0 || partial.length > 0 ? ['Run Checks...'] : [])],
  };
};

const where = (e) => `${e.file}${e.hunk?.startLine ? `:${e.hunk.startLine}` : ''}`;

// { log?, progress? } for one orchestrator / validator event.
export const describeEvent = (e) => {
  switch (e.type) {
    case 'intent':
      return { log: 'read commit history for intent', progress: 'Reading what each branch changed' };
    case 'intent-unavailable':
      return { log: `intent unavailable: ${e.reason}` };
    case 'proposing':
      return {
        log: `${where(e)} proposing (attempt ${(e.attempt ?? 0) + 1})`,
        progress: `${(e.attempt ?? 0) > 0 ? 'Re-analyzing' : 'Analyzing'} ${where(e)}`,
      };
    case 'proposed':
      return {
        log: `${where(e)} proposed: confidence ${e.proposal?.confidence}, ${e.proposal?.flags?.length ?? 0} flag(s), ${e.asksUser ? 'needs review' : 'auto-accepted'}`,
        progress: e.asksUser ? `Waiting for your review of ${where(e)}` : undefined,
      };
    case 'tool-call':
      return { log: `[${e.agent}] ${e.ok ? 'tool' : 'tool failed'}: ${e.label}`, progress: `${e.agent}: ${e.label}` };
    case 'tools-unavailable':
      return { log: `[${e.agent}] tools unavailable: ${e.reason}` };
    case 'references-unavailable':
      return { log: `reference check unavailable: ${e.reason}` };
    case 'resolved':
      return { log: `${e.file} resolved`, progress: `Resolved ${e.file}` };
    case 'rejected':
      return { log: `${e.file} skipped by the user` };
    case 'failed':
      return { log: `${e.file} failed` };
    case 'skipped':
      return { log: `${e.file} has no conflict markers` };
    case 'attempt-limit':
      return { log: `${e.file} reached the attempt limit (${e.maxAttempts})` };
    case 'validating':
      return { log: `check "${e.name}": ${e.command}`, progress: `Running ${e.name}...` };
    default:
      return {};
  }
};

// What the review page shows between two reviews, or null to leave it as it is.
export const describeWorking = (e) => {
  if (e.type !== 'proposing') return null;
  const where = e.total > 1 ? `Conflict ${e.index + 1} of ${e.total}` : 'The conflict';
  const again = (e.attempt ?? 0) > 0;
  return {
    title: `${again ? 'Thinking again about' : 'Analyzing'} ${e.file}`,
    detail: `${where} (lines ${e.hunk?.startLine}-${e.hunk?.endLine})${again ? ', using your feedback' : ''}`,
  };
};
