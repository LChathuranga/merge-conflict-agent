import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listConflictedFiles, readWorkingFile, stageFile } from '../git/index.js';
import { parseConflictHunks } from '../conflict/parser.js';
import { applyResolutions } from '../conflict/apply.js';
import { proposeResolution } from '../agents/conflictAgent.js';
import { validateRepo } from '../agents/validationAgent.js';
import { determineIntent } from '../agents/intentAgent.js';
import { createReadOnlyTools, selectTools } from '../tools/readOnlyTools.js';
import { createAbortError, isAbort, raceAbort, rethrowIfAborted, throwIfAborted } from '../util/abort.js';
import { defaultReferenceAgent, isTestFile } from '../agents/referenceAgent.js';

// The Intent Agent only needs history and docs, not code search.
const INTENT_TOOLS = ['git_log', 'git_show', 'read_file'];

const existingFiles = async (cwd, files) => {
  const checks = await Promise.all(
    files.map((f) => access(path.join(cwd, f)).then(() => f, () => null))
  );
  return checks.filter(Boolean);
};

// Master agent: the only place that writes files or stages changes.
// UI-agnostic: user interaction goes through the `approve` callback and
// progress through `onEvent`, so the CLI and a VS Code UI can both drive it.
//
// approve({ file, hunk, proposal, attempt }) ->
//   { action: 'accept' | 'reject' | 'edit' | 'retry', resolution?, feedback? }
// 'retry' sends `feedback` back to the model for a new proposal (up to maxAttempts per hunk).
const run = async ({
  cwd,
  llm,
  approve,
  onEvent = () => {},
  reviewAll = false,
  maxAttempts = 5,
  useIntent = true,
  intentAgent = determineIntent,
  useTools = false,
  maxToolSteps = 8,
  toolFactory = createReadOnlyTools,
  useReferences = true,
  referenceAgent = defaultReferenceAgent,
  stage = false,
  validate = false,
  validator = validateRepo,
  dryRun = false,
  signal,
  onlyFiles = null,
}, results) => {
  throwIfAborted(signal);
  const wanted = onlyFiles ? new Set(onlyFiles) : null;
  const files = (await listConflictedFiles(cwd)).filter((f) => !wanted || wanted.has(f));

  // Read-only tools the model may call (opt-in). If the model or server turns out not to
  // support tool calling, the first failure switches them off for the rest of the run.
  const allTools = useTools ? toolFactory({ cwd }) : null;
  let toolsEnabled = Boolean(allTools);
  const onToolEvent = (event) => {
    if (event.type === 'tools-unavailable') toolsEnabled = false;
    onEvent(event);
  };
  const focusedTests = new Set();

  // Reference analysis is advisory: a failure costs context and warnings, never the run.
  let referencesWarned = false;
  const bestEffort = async (fn) => {
    try {
      return await fn();
    } catch (error) {
      rethrowIfAborted(error, signal);
      if (!referencesWarned) {
        referencesWarned = true;
        onEvent({ type: 'references-unavailable', reason: error.message });
      }
      return null;
    }
  };

  // Why each side made its change, from commit messages. Best effort: a failure here
  // only costs the Conflict Agent some context, so it never blocks resolving.
  let intent = null;
  if (useIntent && files.length > 0) {
    try {
      const found = await intentAgent({
        llm,
        cwd,
        files,
        tools: toolsEnabled ? selectTools(allTools, INTENT_TOOLS) : null,
        maxToolSteps,
        onToolEvent,
        signal,
      });
      if (found) {
        intent = found.text;
        onEvent({ type: 'intent', intent: found });
      } else {
        onEvent({ type: 'intent-unavailable', reason: 'no commit history found for this operation' });
      }
    } catch (error) {
      rethrowIfAborted(error, signal);
      onEvent({ type: 'intent-unavailable', reason: error.message });
    }
  }

  for (const file of files) {
    throwIfAborted(signal);
    const fileText = await readWorkingFile(cwd, file);
    const hunks = parseConflictHunks(fileText);

    if (hunks.length === 0) {
      results.push({ file, status: 'skipped', reason: 'no conflict markers (binary, delete or rename conflict?)' });
      onEvent({ type: 'skipped', file });
      continue;
    }

    const accepted = [];
    let modelError = null;

    for (const [index, hunk] of hunks.entries()) {
      throwIfAborted(signal);
      const position = { index, total: hunks.length };
      // Each round the user turns down becomes context for the next proposal.
      const feedbackRounds = [];
      let proposal;
      let decision;

      // Where the contested names are used elsewhere; looked up once, reused across retries.
      const usages = useReferences
        ? await bestEffort(() => referenceAgent.gatherUsages({ cwd, file, hunk }))
        : null;

      for (let attempt = 0; ; attempt += 1) {
        onEvent({ type: 'proposing', file, hunk, attempt, ...position });
        try {
          proposal = await proposeResolution({
            llm,
            file,
            fileText,
            hunk,
            intent,
            usages: usages?.text,
            feedbackRounds,
            tools: toolsEnabled ? allTools : null,
            maxToolSteps,
            onToolEvent,
            signal,
          });
        } catch (error) {
          rethrowIfAborted(error, signal);
          modelError = error.message;
          break;
        }

        const assessment = useReferences
          ? await bestEffort(() => referenceAgent.assessResolution({ hunk, resolution: proposal.resolution, usages }))
          : null;
        proposal = {
          ...proposal,
          references: assessment,
          usedElsewhere: usages?.symbols ?? [],
          flags: [...proposal.flags, ...(assessment?.flags ?? [])],
          needsApproval: proposal.needsApproval || (assessment?.flags.length ?? 0) > 0,
        };

        // A revised proposal always goes back to the user: they asked for the change.
        const asksUser = proposal.needsApproval || reviewAll || attempt > 0;
        onEvent({ type: 'proposed', file, hunk, proposal, asksUser, attempt, ...position });

        decision = asksUser
          ? await raceAbort(approve({ file, hunk, proposal, attempt, ...position }), signal)
          : { action: 'accept' };
        if (decision.action !== 'retry') break;

        if (attempt + 1 >= maxAttempts) {
          onEvent({ type: 'attempt-limit', file, hunk, maxAttempts });
          decision = { action: 'reject' };
          break;
        }
        feedbackRounds.push({ proposal, feedback: decision.feedback ?? '' });
      }

      // A failing model is unlikely to recover for the next conflict: stop, keep what was accepted.
      if (modelError) break;

      // Skipping one conflict leaves it (and only it) with its markers; the rest still get resolved.
      if (decision.action === 'reject') {
        onEvent({ type: 'hunk-skipped', file, hunk, ...position });
        continue;
      }
      // Text the user typed has not been assessed yet; check what it changes too.
      const assessment =
        decision.action === 'edit' && useReferences
          ? await bestEffort(() => referenceAgent.assessResolution({ hunk, resolution: decision.resolution, usages }))
          : proposal.references;
      accepted.push({
        hunk,
        resolution: decision.action === 'edit' ? decision.resolution : proposal.resolution,
        proposal,
        assessment,
      });
    }

    if (accepted.length === 0) {
      if (modelError) {
        results.push({ file, status: 'failed', reason: `model error: ${modelError}` });
        onEvent({ type: 'failed', file });
      } else {
        results.push({ file, status: 'rejected' });
        onEvent({ type: 'rejected', file });
      }
      continue;
    }

    // Whatever was accepted is written. The markers still in the file must be exactly the
    // conflicts that were not accepted (skipped, or never reached); anything else is a bug.
    const resolvedText = applyResolutions(fileText, accepted);
    const remaining = hunks.length - accepted.length;
    if (parseConflictHunks(resolvedText).length !== remaining) {
      results.push({ file, status: 'failed', reason: 'the conflict markers left in the file do not match what was accepted' });
      onEvent({ type: 'failed', file });
      continue;
    }
    const complete = remaining === 0;

    throwIfAborted(signal);
    if (!dryRun) {
      await writeFile(path.join(cwd, file), resolvedText, 'utf8');
    }

    // Impact beyond this file: who imports it, and which tests to run first.
    const importers = useReferences
      ? (await bestEffort(() => referenceAgent.findImporters({ cwd, file }))) ?? []
      : [];
    const impactedTests = new Set([
      ...importers.filter(isTestFile),
      ...accepted.flatMap((a) => a.assessment?.testFiles ?? []),
      ...(isTestFile(file) ? [file] : []),
    ]);
    impactedTests.forEach((t) => focusedTests.add(t));

    const impact = {
      importers,
      testFiles: [...impactedTests],
      changes: accepted
        .flatMap((a) => a.assessment?.changes ?? [])
        .filter((c) => c.total > 0)
        .map(({ name, kind, change, discardedFrom, total, references }) => ({ name, kind, change, discardedFrom, total, references })),
    };
    onEvent({ type: 'file-impact', file, impact });

    const status = complete
      ? (dryRun ? 'would-resolve' : 'resolved')
      : (dryRun ? 'would-partial' : 'partial');
    results.push({
      file,
      status,
      staged: false,
      impact,
      ...(complete ? {} : { remaining, ...(modelError ? { reason: `model error: ${modelError}` } : {}) }),
      hunks: accepted.map(({ proposal }) => ({
        confidence: proposal.confidence,
        explanation: proposal.explanation,
      })),
    });
    onEvent({ type: complete ? 'resolved' : 'partial', file, remaining });
  }

  const resolved = results.filter((r) => r.status === 'resolved');
  const allResolved = results.length > 0 && resolved.length === results.length;
  const wantsValidation = (validate || stage) && !dryRun;

  let validation = { ran: false, passed: false, steps: [] };
  let notValidatedReason = null;

  if (wantsValidation) {
    if (!allResolved) {
      notValidatedReason = 'some files are still unresolved, so the repository cannot be validated';
    } else {
      throwIfAborted(signal);
      validation = await validator({ cwd, onEvent, signal, focusedTests: await existingFiles(cwd, [...focusedTests]) });
      if (validation.cancelled) throw createAbortError();
      onEvent({ type: 'validated', validation });
      if (!validation.ran) notValidatedReason = 'no validation commands found';
    }
  }

  // Only the master agent stages, and only once every required check has passed.
  let stageBlockedReason = null;
  if (stage && !dryRun && resolved.length > 0) {
    if (validation.passed) {
      for (const r of resolved) {
        await stageFile(cwd, r.file);
        r.staged = true;
      }
    } else {
      stageBlockedReason = notValidatedReason ?? 'validation failed';
    }
  }

  return { files: results, validation, notValidatedReason, stageBlockedReason };
};

// Resolves the conflicted files of a repository. Cancelling through `signal` rejects with an
// AbortError whose `results` holds the files already handled (they stay written on disk).
//   onlyFiles: restrict the run to these repo-relative paths.
export const resolveConflicts = async (options) => {
  const results = [];
  try {
    return await run(options, results);
  } catch (error) {
    if (options.signal?.aborted || isAbort(error)) throw createAbortError('Cancelled', results);
    throw error;
  }
};
