// Turns the session state into plain node descriptors for the sidebar tree. No VS Code types
// here: the provider maps these to TreeItems. Ids are stable (built from paths and positions,
// never counters) so selection and expansion survive a refresh.

import { stageableFiles } from './stageModel.js';

const node = (id, label, extra = {}) => ({ id, label, collapsible: 'none', children: [], ...extra });

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const FILE_STATUS = {
  pending: { icon: 'circle-outline', text: 'not resolved yet' },
  working: { icon: 'loading~spin', text: 'working...' },
  review: { icon: 'eye', text: 'waiting for your review', color: 'charts.yellow' },
  resolved: { icon: 'check', text: 'resolved', color: 'charts.green' },
  skipped: { icon: 'circle-slash', text: 'skipped - still conflicted', color: 'charts.yellow' },
  partial: { icon: 'warning', text: 'partly resolved', color: 'charts.yellow' },
  failed: { icon: 'error', text: 'failed', color: 'charts.red' },
  manual: { icon: 'tools', text: 'no conflict markers - resolve it yourself', color: 'charts.orange' },
};

const HUNK_ICON = { pending: 'circle-outline', working: 'loading~spin', review: 'eye', done: 'check', skipped: 'circle-slash' };

const fileNode = (file) => {
  const status = FILE_STATUS[file.status] ?? FILE_STATUS.pending;
  const hunks = file.hunks.map((h, i) =>
    node(`hunk:${file.path}:${h.startLine}`, `Lines ${h.startLine}-${h.endLine}`, {
      description: h.status === 'done' ? 'resolved' : h.status === 'pending' ? undefined : h.status === 'review' ? 'review' : 'working...',
      icon: { id: HUNK_ICON[h.status] ?? 'circle-outline' },
      contextValue: 'conflictHunk',
      command: { id: 'mergeAssistant.openConflict', args: [file.path, h.startLine], title: 'Open conflict' },
      tooltip: `Conflict ${i + 1} of ${file.hunks.length}`,
    })
  );

  const detail = file.hunks.length > 0 ? `${plural(file.hunks.length, 'conflict')} - ${status.text}` : status.text;
  const reason = file.reason ? `\n${file.reason}` : '';
  return node(`file:${file.path}`, file.path, {
    file: file.path,
    description: detail,
    tooltip: `${file.path}\n${detail}${reason}`,
    icon: { id: status.icon, color: status.color },
    collapsible: hunks.length > 0 ? 'expanded' : 'none',
    contextValue: file.hunks.length > 0 && !['working', 'review'].includes(file.status) ? 'conflictFile' : 'conflictFileBusy',
    command: file.hunks.length > 0 ? undefined : { id: 'mergeAssistant.openConflict', args: [file.path, 1], title: 'Open file' },
    children: hunks,
  });
};

const reviewChildren = (state) => {
  const { current } = state.run;
  const rows = [];
  if (current) {
    const where = current.startLine ? `${current.file} lines ${current.startLine}-${current.endLine}` : current.file;
    const attempt = current.attempt > 0 ? ` (attempt ${current.attempt + 1})` : '';
    rows.push(node('review:current', current.waiting ? `Waiting for you: ${where}${attempt}` : `Proposing: ${where}${attempt}`, {
      icon: { id: current.waiting ? 'eye' : 'loading~spin', color: current.waiting ? 'charts.yellow' : undefined },
    }));
  }
  for (const file of state.files) {
    if (['failed', 'skipped', 'partial'].includes(file.status)) {
      const left = file.remaining ? `${plural(file.remaining, 'conflict')} left` : 'partly resolved';
      rows.push(node(`review:${file.path}`, file.path, {
        description: file.status === 'partial'
          ? `${left}${file.reason ? ` - ${file.reason}` : ''}`
          : file.reason ?? (file.status === 'skipped' ? 'skipped by you' : 'failed'),
        icon: { id: FILE_STATUS[file.status].icon, color: FILE_STATUS[file.status].color },
        tooltip: file.reason,
      }));
    }
  }
  state.notices.forEach((text, i) => rows.push(node(`review:notice:${i}`, text, { icon: { id: 'info' } })));
  return rows;
};

const validationChildren = (validation) =>
  (validation?.steps ?? []).map((step, i) =>
    node(`validate:${i}:${step.name}`, step.name, {
      description: step.status === 'failed' ? `failed${step.exitCode != null ? ` (exit ${step.exitCode})` : ''}${step.timedOut ? ', timed out' : ''}` : step.status,
      tooltip: step.command,
      icon: {
        id: { passed: 'check', failed: 'error', skipped: 'circle-slash', cancelled: 'circle-slash' }[step.status] ?? 'circle-outline',
        color: { passed: 'charts.green', failed: 'charts.red' }[step.status],
      },
      command: step.status === 'failed' ? { id: 'mergeAssistant.showOutput', args: [], title: 'Show log' } : undefined,
    })
  );

// `busy` is true while a run is in progress (resolve or validate).
export const buildTree = (state, { busy = false } = {}) => {
  if (!state.repo || state.operation !== 'merge') return [];

  const summary = {
    total: state.files.length,
    withMarkers: state.files.filter((f) => f.hunks.length > 0).length,
    resolved: state.files.filter((f) => f.status === 'resolved').length,
    skipped: state.files.filter((f) => f.status === 'skipped').length,
    failed: state.files.filter((f) => f.status === 'failed').length,
    partial: state.files.filter((f) => f.status === 'partial').length,
  };
  const noConflicts = summary.total === 0;
  const allDone = !noConflicts && state.files.every((f) => f.status === 'resolved');
  const pendingWork = state.files.some((f) => f.hunks.length > 0 && ['pending', 'skipped', 'failed', 'partial'].includes(f.status));

  const target = state.theirs?.label ?? 'another branch';
  const mergeStep = node('step:merge', '1. Merge', {
    description: `${target} into ${state.branch ?? 'HEAD'}`,
    icon: { id: 'git-merge' },
    collapsible: 'expanded',
    contextValue: 'mergeStep',
    tooltip: 'Abort merge discards the merge and every resolution made since it started.',
    children: [
      node('merge:info', noConflicts ? (state.hadConflicts ? 'All conflicts are handled' : 'Merged without conflicts') : `${plural(summary.total, 'file')} with conflicts`, {
        icon: { id: noConflicts ? 'check' : 'warning', color: noConflicts ? 'charts.green' : 'charts.yellow' },
      }),
      ...(state.intent
        ? [node('merge:intent', 'Why each side changed', {
            description: state.intent.relationship,
            tooltip: state.intent.text,
            icon: { id: 'lightbulb' },
          })]
        : []),
    ],
  });

  const conflictsStep = node('step:conflicts', '2. Conflicts', {
    description: noConflicts ? (state.hadConflicts ? 'all handled' : 'none') : `${summary.resolved} of ${summary.total} resolved`,
    icon: { id: noConflicts || allDone ? 'check' : 'warning', color: noConflicts || allDone ? 'charts.green' : 'charts.yellow' },
    collapsible: noConflicts ? 'none' : 'expanded',
    contextValue: 'conflictsStep',
    children: state.files.map(fileNode),
  });

  const reviewRows = reviewChildren(state);
  const canResolve = pendingWork && !busy;
  const hasMarkersLeft = state.files.some((f) => f.hunks.length > 0);
  const canCheck = !busy && !hasMarkersLeft;
  const reviewStep = node('step:review', '3. Review', {
    description: state.run.kind === 'resolve'
      ? 'AI is working'
      : summary.failed + summary.skipped + summary.partial > 0
        ? [summary.partial && `${summary.partial} partly resolved`, summary.skipped && `${summary.skipped} skipped`, summary.failed && `${summary.failed} failed`].filter(Boolean).join(', ')
        : pendingWork ? 'click to resolve with AI' : noConflicts ? 'nothing to review' : 'done',
    icon: { id: state.run.kind === 'resolve' ? 'loading~spin' : 'eye' },
    collapsible: reviewRows.length > 0 ? 'expanded' : 'none',
    contextValue: 'reviewStep',
    tooltip: canResolve ? 'Click to resolve the conflicts with AI. You review anything doubtful.' : undefined,
    command: canResolve ? { id: 'mergeAssistant.resolveAll', args: [], title: 'Resolve Conflicts with AI' } : undefined,
    children: reviewRows,
  });

  const validation = state.validation;
  const validateText = !validation
    ? 'not run'
    : state.run.kind === 'validate'
      ? `running ${validation.running ?? ''}`.trim()
      : validation.cancelled ? 'cancelled' : !validation.ran ? 'no checks found' : validation.passed ? 'passed' : 'failed';
  const validateStep = node('step:validate', '4. Validate', {
    description: canCheck && !validation ? 'click to run checks' : validateText,
    icon: {
      id: state.run.kind === 'validate' ? 'loading~spin' : validation?.passed ? 'check' : validation && validation.ran && !validation.cancelled ? 'error' : 'beaker',
      color: validation?.passed ? 'charts.green' : validation && validation.ran && !validation.cancelled ? 'charts.red' : undefined,
    },
    collapsible: validation?.steps?.length ? 'expanded' : 'none',
    contextValue: 'validateStep',
    tooltip: canCheck ? 'Click to run the checks. You see the exact commands first.' : hasMarkersLeft ? 'Resolve the conflicts first.' : undefined,
    command: canCheck && state.run.kind !== 'validate' ? { id: 'mergeAssistant.runChecks', args: [], title: 'Run Checks' } : undefined,
    children: validationChildren(validation),
  });

  const steps = [mergeStep, conflictsStep, reviewStep, validateStep];
  const ready = stageableFiles(state);
  if (ready.length > 0 && !busy) {
    steps.push(node('step:stage', '5. Stage', {
      description: `${plural(ready.length, 'file')} resolved - click to stage`,
      icon: { id: 'check-all' },
      contextValue: 'stageStep',
      command: { id: 'mergeAssistant.stageResolved', args: [], title: 'Stage Resolved Files' },
      tooltip: 'Tells Git these files are resolved (git add). Git lists them as conflicts until you do. It does not commit.',
    }));
  }
  if ((noConflicts || allDone) && !busy) {
    steps.push(node('step:next', 'Next: review the changes and commit', {
      description: 'in Source Control',
      icon: { id: 'source-control' },
      command: { id: 'workbench.view.scm', args: [], title: 'Open Source Control' },
      tooltip: 'Merge Assistant never stages or commits. Review the diff, stage the files and commit when you are happy.',
    }));
  }
  return steps;
};

export const flatten = (nodes) => nodes.flatMap((n) => [n, ...flatten(n.children)]);
