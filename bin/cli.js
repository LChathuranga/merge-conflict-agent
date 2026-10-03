#!/usr/bin/env node
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { createLLMClient } from '../src/llm/index.js';
import { getRepoRoot } from '../src/git/index.js';
import { resolveConflicts } from '../src/orchestrator/index.js';
import { bold, blue, cyan, gray, green, magenta, red, yellow, confidenceColor, statusColor } from '../src/ui/colors.js';

const HELP = `Usage: resolve-conflicts [options]

  --cwd <dir>   Repository directory (default: current directory)
  --review      Ask for approval on every hunk, not just uncertain ones
  --validate    After resolving, run the repo's checks (test, typecheck, lint, build)
  --stage       git add resolved files, only if validation passes (implies --validate)
  --no-intent   Skip reading commit messages to learn why each branch changed
  --no-references  Skip finding other uses of changed names, importers and affected tests
  --tools       Let the model call read-only tools (read files, search, git history) while it works
  --dry-run     Propose resolutions but do not write any files
  -h, --help    Show this help

Provider is configured through .env (PROVIDER=openai | anthropic | ollama).
Checks come from .merge-agent.json ({"validate": ["npm test", ...]}) or from
the test/typecheck/lint/build scripts in package.json.`;

const indent = (text) => text.split('\n').map((l) => `    ${l}`).join('\n');

const main = async () => {
  const { values } = parseArgs({
    options: {
      cwd: { type: 'string' },
      review: { type: 'boolean', default: false },
      stage: { type: 'boolean', default: false },
      validate: { type: 'boolean', default: false },
      'no-intent': { type: 'boolean', default: false },
      'no-references': { type: 'boolean', default: false },
      tools: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const cwd = await getRepoRoot(values.cwd ?? process.cwd());
  const llm = createLLMClient();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const confidence = (level) => confidenceColor(level)(level);

  // Multi-line input ending at a lone "." (or end of input). Null when nothing was typed.
  const readReplacement = async () => {
    console.log(gray('  Type the replacement code; finish with a line containing only "." (typing "." first cancels).'));
    const lines = [];
    try {
      for (;;) {
        const line = await rl.question('  | ');
        if (line === '.') break;
        lines.push(line);
      }
    } catch {
      // input closed: keep whatever was typed so far
    }
    return lines.length > 0 ? lines.join('\n') : null;
  };

  const approve = async ({ file, hunk, proposal, attempt }) => {
    const title = attempt > 0 ? `Revised proposal (attempt ${attempt + 1}):` : 'Needs your approval:';
    console.log(`\n${bold(yellow(title))} ${bold(`${file}:${hunk.startLine}-${hunk.endLine}`)}  (confidence: ${confidence(proposal.confidence)})`);
    console.log(`  ${bold(blue('OURS'))}${hunk.oursLabel ? gray(` (${hunk.oursLabel})`) : ''}:\n` + blue(indent(hunk.ours)));
    console.log(`  ${bold(magenta('THEIRS'))}${hunk.theirsLabel ? gray(` (${hunk.theirsLabel})`) : ''}:\n` + magenta(indent(hunk.theirs)));
    console.log(`  ${bold(green('PROPOSED'))}:\n` + green(indent(proposal.resolution)));
    console.log(`  ${bold('Why')}: ${proposal.explanation}`);
    if (proposal.toolCalls?.length) {
      console.log(gray(`  Model inspected: ${[...new Set(proposal.toolCalls.map((c) => c.name))].join(', ')} (${proposal.toolCalls.length} call${proposal.toolCalls.length === 1 ? '' : 's'})`));
    }
    (proposal.usedElsewhere ?? []).forEach(({ name, total, references }) => {
      const where = references.slice(0, 3).map((r) => `${r.file}:${r.line}`).join(', ');
      console.log(gray(`  Used elsewhere: ${name} (${total}) ${where}${total > 3 ? ', ...' : ''}`));
    });
    proposal.flags.forEach((flag) => console.log(yellow(`  Flagged: ${flag}`)));
    for (;;) {
      let answer;
      try {
        answer = (await rl.question(`  ${green('[a]ccept')} / ${yellow('[f]eedback')} (propose again) / ${cyan('[e]dit')} (type it yourself) / ${red('[s]kip')} file > `)).trim().toLowerCase();
      } catch {
        console.log(gray('\n  input closed, treating as skip'));
        return { action: 'reject' };
      }

      if (answer.startsWith('a')) return { action: 'accept' };

      if (answer.startsWith('f')) {
        try {
          const feedback = (await rl.question(`  ${bold('What should change?')} (e.g. "keep both, timeout should stay 60") > `)).trim();
          return { action: 'retry', feedback };
        } catch {
          console.log(gray('\n  input closed, treating as skip'));
          return { action: 'reject' };
        }
      }

      if (answer.startsWith('e')) {
        const resolution = await readReplacement();
        if (resolution !== null) return { action: 'edit', resolution };
        console.log(gray('  nothing entered, edit cancelled'));
        continue;
      }

      return { action: 'reject' };
    }
  };

  try {
    const { files, validation, notValidatedReason, stageBlockedReason } = await resolveConflicts({
      cwd,
      llm,
      approve,
      reviewAll: values.review,
      stage: values.stage,
      validate: values.validate,
      useIntent: !values['no-intent'],
      useReferences: !values['no-references'],
      useTools: values.tools,
      dryRun: values['dry-run'],
      onEvent: (e) => {
        if (e.type === 'intent') {
          const { operation, ours, theirs, relationship } = e.intent;
          console.log(`${bold(`Branch intent (${operation}):`)}`);
          console.log(`  ${bold(blue('OURS'))} ${gray(`(${ours.label})`)}: ${ours.summary}`);
          console.log(`  ${bold(magenta('THEIRS'))} ${gray(`(${theirs.label})`)}: ${theirs.summary}`);
          console.log(`  ${bold('Relationship')}: ${relationship}\n`);
        }
        if (e.type === 'tool-call') console.log(gray(`  [${e.agent}] ${e.ok ? '' : 'failed: '}${e.label}`));
        if (e.type === 'tools-unavailable') {
          console.log(yellow(`  ${e.agent}: this model or server could not use tools (${e.reason}); continuing without them.`));
        }
        if (e.type === 'references-unavailable') console.log(gray(`Reference check unavailable: ${e.reason}`));
        if (e.type === 'file-impact') {
          const { importers, testFiles } = e.impact;
          const parts = [];
          if (importers.length > 0) parts.push(`imported by ${importers.length} file${importers.length === 1 ? '' : 's'}`);
          if (testFiles.length > 0) parts.push(`${testFiles.length} related test file${testFiles.length === 1 ? '' : 's'}`);
          if (parts.length > 0) console.log(gray(`  Impact on ${e.file}: ${parts.join(', ')}`));
        }
        if (e.type === 'intent-unavailable') console.log(gray(`Branch intent unavailable: ${e.reason}\n`));
        if (e.type === 'proposing') {
          console.log(cyan(e.attempt > 0
            ? `Re-analyzing ${e.file}:${e.hunk.startLine} with your feedback...`
            : `Analyzing ${e.file}:${e.hunk.startLine}...`));
        }
        if (e.type === 'attempt-limit') {
          console.log(yellow(`  Reached ${e.maxAttempts} attempts for this hunk, skipping the file. Resolve it manually.`));
        }
        if (e.type === 'proposed' && !e.asksUser) {
          console.log(`  ${green('auto-accepted')} (confidence: ${confidence(e.proposal.confidence)})`);
          console.log(`  ${bold(green('PROPOSED'))}:\n` + green(indent(e.proposal.resolution)));
          console.log(`  ${bold('Why')}: ${e.proposal.explanation}`);
        }
        if (e.type === 'validating') console.log(cyan(`\nValidating: ${e.name} (${e.command})...`));
      },
    });

    console.log(`\n${bold('Summary:')}`);
    if (files.length === 0) console.log(gray('  No conflicted files found.'));
    for (const f of files) {
      const status = statusColor(f.status)(f.status.padEnd(13));
      console.log(`  ${status} ${f.file}${f.reason ? gray(`  (${f.reason})`) : ''}`);
    }

    if (validation.steps.length > 0) {
      console.log(`\n${bold('Validation:')}`);
      for (const s of validation.steps) {
        const seconds = s.durationMs === undefined ? '' : gray(` ${(s.durationMs / 1000).toFixed(1)}s`);
        console.log(`  ${statusColor(s.status)(s.status.padEnd(13))} ${s.name}${seconds}`);
        if (s.status === 'failed') {
          if (s.timedOut) console.log(red('    timed out'));
          console.log(gray(indent(s.output.trim())));
        }
      }
    }
    if (notValidatedReason) console.log(yellow(`\nNot validated: ${notValidatedReason}.`));
    if (stageBlockedReason) console.log(red(`Nothing was staged: ${stageBlockedReason}.`));

    if (validation.passed && files.some((f) => f.staged)) {
      console.log(green('\nValidation passed and resolved files were staged.'));
    } else if (files.some((f) => f.status === 'resolved' && !f.staged)) {
      console.log(yellow('\nReview the changes, run your tests, then `git add` the files.'));
    }
  } finally {
    rl.close();
  }
};

main().catch((err) => {
  console.error(`${bold(red('Error:'))} ${err.message}`);
  process.exit(1);
});
