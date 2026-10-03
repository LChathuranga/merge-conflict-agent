#!/usr/bin/env node
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { getRepoRoot } from '../src/git/index.js';
import { applyCherryPick, runPreflight } from '../src/preflight/index.js';
import { bold, cyan, gray, green, red, yellow } from '../src/ui/colors.js';

const HELP = `Usage: cherry-pick-check <commit> [options]

Checks whether a commit is safe to cherry-pick before changing anything: prerequisite
commits, names and files it needs that the target lacks, other branches working on the
same files, and a trial pick in a temporary worktree. Your branch and files are not touched.

  <commit>        Commit sha (or any ref) to cherry-pick
  --onto <ref>    Branch or commit to receive it (default: HEAD, the current branch)
  --validate      Also run the repo's tests/lint/build on the simulated result
  --apply         After the report, offer to run the real cherry-pick
  --cwd <dir>     Repository directory (default: current directory)
  --json          Print the report as JSON and exit (no prompts)
  -h, --help      Show this help

Only the local repository is inspected: open pull requests are not checked yet, so a
SAFE result always means "safe as far as local history shows".`;

const TONES = { heading: (t) => bold(t), good: green, warn: yellow, bad: red, dim: gray, plain: (t) => t };

const main = async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      onto: { type: 'string' },
      validate: { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      cwd: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    if (!values.help) process.exitCode = 1;
    return;
  }
  if (positionals.length > 1) throw new Error('Pass exactly one commit. Ranges are not supported yet; check commits one at a time.');

  const cwd = await getRepoRoot(values.cwd ?? process.cwd());
  const result = await runPreflight({
    cwd,
    commit: positionals[0],
    target: values.onto ?? 'HEAD',
    validate: values.validate,
    onEvent: (e) => {
      if (values.json) return;
      if (e.type === 'preflight-step') console.log(gray(`Checking ${e.step}...`));
      if (e.type === 'validating') console.log(cyan(`Validating: ${e.name} (${e.command})...`));
    },
  });

  if (values.json) {
    const { lines, ...report } = result;
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('');
  for (const { tone, text } of result.lines) console.log((TONES[tone] ?? TONES.plain)(text));

  if (!values.apply) {
    if (result.outcome !== 'blocked') console.log(gray('\nRun again with --apply to cherry-pick after reviewing this.'));
    return;
  }
  if (result.outcome === 'blocked') {
    console.log(red('\nNot applying: the outcome is BLOCKED.'));
    process.exitCode = 1;
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const risky = result.outcome !== 'safe';
    const question = risky
      ? `\nOutcome is ${result.outcome.toUpperCase()}. Type "yes" to cherry-pick anyway > `
      : '\nApply the cherry-pick now? Type "yes" to confirm > ';
    const answer = (await rl.question(question).catch(() => '')).trim().toLowerCase();
    if (answer !== 'yes') {
      console.log(gray('Cancelled. Nothing was changed.'));
      return;
    }
  } finally {
    rl.close();
  }

  const applied = await applyCherryPick({ cwd, commit: positionals[0], target: values.onto ?? 'HEAD' });
  if (applied.status === 'applied') console.log(green('Cherry-picked.'));
  else if (applied.status === 'conflict') {
    console.log(yellow(`The cherry-pick stopped with conflicts in: ${applied.conflicts.join(', ')}`));
    console.log('Resolve them with `resolve-conflicts`, then `git cherry-pick --continue` (or `git cherry-pick --abort` to cancel).');
    process.exitCode = 1;
  } else {
    console.log(red(`Cherry-pick failed: ${applied.message}`));
    process.exitCode = 1;
  }
};

main().catch((err) => {
  console.error(`${bold(red('Error:'))} ${err.message}`);
  process.exit(1);
});
