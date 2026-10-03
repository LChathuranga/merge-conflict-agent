import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listConflictedFiles, readWorkingFile, stageFile } from '../git/index.js';
import { parseConflictHunks, hasConflictMarkers } from '../conflict/parser.js';
import { applyResolutions } from '../conflict/apply.js';
import { proposeResolution } from '../agents/conflictAgent.js';
import { validateRepo } from '../agents/validationAgent.js';
import { determineIntent } from '../agents/intentAgent.js';
import { createReadOnlyTools, selectTools } from '../tools/readOnlyTools.js';
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
export const resolveConflicts = async ({
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
}) => {
  const files = await listConflictedFiles(cwd);
  const results = [];

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
      });
      if (found) {
        intent = found.text;
        onEvent({ type: 'intent', intent: found });
      } else {
        onEvent({ type: 'intent-unavailable', reason: 'no commit history found for this operation' });
      }
    } catch (error) {
      onEvent({ type: 'intent-unavailable', reason: error.message });
    }
  }

  for (const file of files) {
    const fileText = await readWorkingFile(cwd, file);
    const hunks = parseConflictHunks(fileText);

    if (hunks.length === 0) {
      results.push({ file, status: 'skipped', reason: 'no conflict markers (binary, delete or rename conflict?)' });
      onEvent({ type: 'skipped', file });
      continue;
    }

    const accepted = [];
    let rejected = false;
    let modelError = null;

    for (const hunk of hunks) {
      // Each round the user turns down becomes context for the next proposal.
      const feedbackRounds = [];
      let proposal;
      let decision;

      // Where the contested names are used elsewhere; looked up once, reused across retries.
      const usages = useReferences
        ? await bestEffort(() => referenceAgent.gatherUsages({ cwd, file, hunk }))
        : null;

      for (let attempt = 0; ; attempt += 1) {
        onEvent({ type: 'proposing', file, hunk, attempt });
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
          });
        } catch (error) {
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
        onEvent({ type: 'proposed', file, hunk, proposal, asksUser, attempt });

        decision = asksUser ? await approve({ file, hunk, proposal, attempt }) : { action: 'accept' };
        if (decision.action !== 'retry') break;

        if (attempt + 1 >= maxAttempts) {
          onEvent({ type: 'attempt-limit', file, hunk, maxAttempts });
          decision = { action: 'reject' };
          break;
        }
        feedbackRounds.push({ proposal, feedback: decision.feedback ?? '' });
      }

      if (modelError) break;

      if (decision.action === 'reject') {
        rejected = true;
        break;
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

    if (modelError) {
      results.push({ file, status: 'failed', reason: `model error: ${modelError}` });
      onEvent({ type: 'failed', file });
      continue;
    }

    if (rejected) {
      results.push({ file, status: 'rejected' });
      onEvent({ type: 'rejected', file });
      continue;
    }

    const resolvedText = applyResolutions(fileText, accepted);
    if (hasConflictMarkers(resolvedText)) {
      results.push({ file, status: 'failed', reason: 'conflict markers remain after applying resolutions' });
      onEvent({ type: 'failed', file });
      continue;
    }

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

    results.push({
      file,
      status: dryRun ? 'would-resolve' : 'resolved',
      staged: false,
      impact,
      hunks: accepted.map(({ proposal }) => ({
        confidence: proposal.confidence,
        explanation: proposal.explanation,
      })),
    });
    onEvent({ type: 'resolved', file });
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
      validation = await validator({ cwd, onEvent, focusedTests: await existingFiles(cwd, [...focusedTests]) });
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
