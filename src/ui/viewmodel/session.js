import { EventEmitter } from 'node:events';
import { isResolvable } from '../../git/merge.js';

// The state behind the sidebar: what merge is in progress, which files conflict, what the AI
// run is doing right now and how it ended. Pure and UI-free; the tree is built from it.
// It is fed by two sources: git (what is true on disk, via syncGit) and the orchestrator's
// events (what the current run is doing, via handleEvent). After a window reload only git is
// available, so everything shown must be derivable from git plus the results of the last run.

const emptyRun = () => ({ kind: null, current: null });

const initialState = () => ({
  repo: null,
  branch: null,
  detached: false,
  operation: null,
  theirs: null,
  hadConflicts: false,
  files: [],
  run: emptyRun(),
  intent: null,
  validation: null,
  notices: [],
});

const sameHunk = (hunk, event) => hunk.startLine === event.hunk?.startLine;

export const createSession = () => {
  const emitter = new EventEmitter();
  let state = initialState();
  const changed = () => emitter.emit('change', state);
  const findFile = (path) => state.files.find((f) => f.path === path);

  const setHunks = (file, status) => file.hunks.forEach((h) => { if (h.status !== 'done') h.status = status; });

  return {
    get state() { return state; },
    onDidChange(listener) {
      emitter.on('change', listener);
      return () => emitter.off('change', listener);
    },

    setRepo(repo) {
      if (state.repo?.root === repo?.root) return;
      state = { ...initialState(), repo };
      changed();
    },

    // What git says right now. `files` are the conflicted paths with their parsed hunks.
    syncGit({ branch, detached, operation, theirs, files }) {
      // A merge or a cherry-pick: both stop with conflicts to resolve.
      const merging = isResolvable(operation);
      const previous = new Map(state.files.map((f) => [f.path, f]));

      state = {
        ...state,
        branch,
        detached,
        operation,
        theirs: merging ? theirs : null,
        // Once a merge has had conflicts, an empty list means "all handled", not "never had any".
        hadConflicts: merging ? state.hadConflicts || files.length > 0 : false,
        files: merging
          ? files.map(({ path, hunks }) => {
              const before = previous.get(path);
              const live = before && ['working', 'review'].includes(before.status);
              // What a run decided about a file still holds while the file still has conflicts:
              // a refresh must not turn "skipped" or "failed" back into "not resolved yet".
              const decided = before && ['skipped', 'failed', 'partial'].includes(before.status);
              const resolvedByRun = before?.status === 'resolved';
              return {
                path,
                // While a run is working on a file, keep what each conflict is doing.
                hunks: hunks.map(({ startLine, endLine }) => ({
                  startLine,
                  endLine,
                  status: live ? before.hunks.find((h) => h.startLine === startLine)?.status ?? 'pending' : 'pending',
                })),
                status: live || (decided && hunks.length > 0)
                  ? before.status
                  : hunks.length > 0 ? 'pending' : resolvedByRun ? 'resolved' : 'manual',
                reason: hunks.length > 0 && !decided ? undefined : before?.reason,
                impact: before?.impact,
              };
            })
          : [],
        // A finished, committed or aborted merge leaves nothing worth showing.
        validation: merging ? state.validation : null,
        intent: merging ? state.intent : null,
        run: merging ? state.run : emptyRun(),
      };
      changed();
    },

    beginRun(kind) {
      state = { ...state, run: { kind, current: null }, notices: [] };
      if (kind === 'validate') state.validation = { ran: false, passed: false, cancelled: false, steps: [] };
      changed();
    },

    endRun() {
      state.files.forEach((f) => {
        if (['working', 'review'].includes(f.status)) f.status = 'pending';
        setHunks(f, 'pending');
      });
      state = { ...state, run: emptyRun() };
      changed();
    },

    // One event from resolveConflicts / validateRepo.
    handleEvent(event) {
      const file = event.file ? findFile(event.file) : null;
      switch (event.type) {
        case 'intent':
          state.intent = event.intent;
          break;
        case 'proposing': {
          if (!file) break;
          file.status = 'working';
          const hunk = file.hunks.find((h) => sameHunk(h, event));
          if (hunk) hunk.status = 'working';
          state.run.current = { file: file.path, startLine: event.hunk?.startLine, endLine: event.hunk?.endLine, attempt: event.attempt ?? 0, waiting: false };
          break;
        }
        case 'proposed': {
          if (!file) break;
          const hunk = file.hunks.find((h) => sameHunk(h, event));
          if (event.asksUser) {
            file.status = 'review';
            if (hunk) hunk.status = 'review';
          } else if (hunk) {
            hunk.status = 'done';
          }
          if (state.run.current) state.run.current = { ...state.run.current, waiting: Boolean(event.asksUser), confidence: event.proposal?.confidence };
          break;
        }
        case 'resolved':
          if (file) { file.status = 'resolved'; setHunks(file, 'done'); }
          break;
        case 'hunk-skipped': {
          // One conflict was skipped; the file's other conflicts carry on.
          const skipped = file?.hunks.find((h) => sameHunk(h, event));
          if (skipped) skipped.status = 'skipped';
          break;
        }
        case 'partial':
          if (file) {
            file.status = 'partial';
            file.remaining = event.remaining;
            file.hunks.forEach((h) => { if (h.status !== 'skipped') h.status = 'done'; });
          }
          break;
        case 'rejected':
          if (file) { file.status = 'skipped'; setHunks(file, 'pending'); }
          break;
        case 'failed':
          if (file) { file.status = 'failed'; setHunks(file, 'pending'); }
          break;
        case 'skipped':
          if (file) file.status = 'manual';
          break;
        case 'file-impact':
          if (file) file.impact = event.impact;
          break;
        case 'tools-unavailable':
          state.notices = [...state.notices, `${event.agent}: this model could not use tools`];
          break;
        case 'references-unavailable':
          state.notices = [...state.notices, 'Reference check unavailable'];
          break;
        case 'validating':
          if (state.validation) state.validation = { ...state.validation, running: event.name };
          break;
        default:
          return;
      }
      changed();
    },

    // The final per-file results of a run (reasons for failed / skipped files).
    recordResults(results) {
      for (const result of results) {
        const file = findFile(result.file);
        if (!file) continue;
        file.status = { 'would-resolve': 'resolved', 'would-partial': 'partial', rejected: 'skipped' }[result.status] ?? result.status;
        if (result.remaining !== undefined) file.remaining = result.remaining;
        file.reason = result.reason;
        if (result.impact) file.impact = result.impact;
      }
      changed();
    },

    setValidation(validation) {
      state = { ...state, validation };
      changed();
    },

    // Counts used for the step summaries.
    summary() {
      const count = (status) => state.files.filter((f) => f.status === status).length;
      return {
        total: state.files.length,
        withMarkers: state.files.filter((f) => f.hunks.length > 0).length,
        resolved: count('resolved'),
        skipped: count('skipped'),
        failed: count('failed'),
        manual: count('manual'),
        pending: count('pending'),
      };
    },
  };
};
