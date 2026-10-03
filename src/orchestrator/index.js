import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listConflictedFiles, readWorkingFile, stageFile } from '../git/index.js';
import { parseConflictHunks, hasConflictMarkers } from '../conflict/parser.js';
import { applyResolutions } from '../conflict/apply.js';
import { proposeResolution } from '../agents/conflictAgent.js';
import { validateRepo } from '../agents/validationAgent.js';
import { determineIntent } from '../agents/intentAgent.js';

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
  stage = false,
  validate = false,
  validator = validateRepo,
  dryRun = false,
}) => {
  const files = await listConflictedFiles(cwd);
  const results = [];

  // Why each side made its change, from commit messages. Best effort: a failure here
  // only costs the Conflict Agent some context, so it never blocks resolving.
  let intent = null;
  if (useIntent && files.length > 0) {
    try {
      const found = await intentAgent({ llm, cwd, files });
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

      for (let attempt = 0; ; attempt += 1) {
        onEvent({ type: 'proposing', file, hunk, attempt });
        try {
          proposal = await proposeResolution({ llm, file, fileText, hunk, intent, feedbackRounds });
        } catch (error) {
          modelError = error.message;
          break;
        }

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
      accepted.push({
        hunk,
        resolution: decision.action === 'edit' ? decision.resolution : proposal.resolution,
        proposal,
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

    results.push({
      file,
      status: dryRun ? 'would-resolve' : 'resolved',
      staged: false,
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
      validation = await validator({ cwd, onEvent });
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
