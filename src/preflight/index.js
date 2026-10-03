import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeDependencies } from '../agents/dependencyAgent.js';
import { extractDeclarations, isTestFile } from '../agents/referenceAgent.js';
import { validateRepo } from '../agents/validationAgent.js';
import { getCurrentBranch, grepWord } from '../git/index.js';
import { isWorkingTreeClean, readFileAtRef, resolveCommit } from '../git/history.js';
import { cherryPick, cherryPickNoCommit, createWorktree, linkDependencies, removeWorktree } from '../git/worktree.js';
import { isCodeFile } from './diff.js';

// Master of the cherry-pick preflight: gathers evidence, tries the pick in a throwaway
// worktree, and reports one of four outcomes. It changes nothing in the user's repository;
// applying the pick is a separate call (applyCherryPick) made only after approval.
//
//   safe        nothing found (always "local analysis only" until open PRs can be checked)
//   conditional other commits must be applied first
//   risky       concurrent or unexplained changes need an owner's review
//   blocked     a required dependency is missing, the pick errors, or validation failed

export const OUTCOMES = ['safe', 'conditional', 'risky', 'blocked'];
const rank = (outcome) => OUTCOMES.indexOf(outcome);
const MAX_BROKEN_SYMBOLS = 20;

// Names a commit removed or re-signed in the simulated result that other files still use.
export const findBrokenReferences = async ({ cwd, worktree, target, files }) => {
  const before = new Map();
  const after = new Map();
  const declaredAfter = new Set();

  for (const file of files) {
    if (!isCodeFile(file.path) || file.status === 'A') continue;
    const oldPath = file.oldPath ?? file.path;
    before.set(file.path, extractDeclarations((await readFileAtRef(cwd, target, oldPath)) ?? ''));
  }
  for (const file of files) {
    if (!isCodeFile(file.path) || file.status === 'D') continue;
    const text = await readFile(path.join(worktree, file.path), 'utf8').catch(() => '');
    const declarations = extractDeclarations(text);
    after.set(file.path, declarations);
    declarations.forEach((_, name) => declaredAfter.add(name));
  }

  const changes = [];
  for (const [file, declarations] of before) {
    const now = after.get(file) ?? new Map();
    for (const [name, was] of declarations) {
      if (changes.length >= MAX_BROKEN_SYMBOLS) break;
      if (name.length < 3 || was.kind === 'property' || was.kind === 'method') continue;
      const is = now.get(name);
      if (!is && !declaredAfter.has(name)) changes.push({ name, file, change: 'removed' });
      else if (is && was.kind === 'function' && is.signature !== was.signature) changes.push({ name, file, change: 'signature changed' });
    }
  }

  const broken = [];
  for (const change of changes) {
    const { references, total } = await grepWord(worktree, change.name, { excludeFile: change.file, excludeRange: [1, Number.MAX_SAFE_INTEGER] });
    if (total > 0) broken.push({ ...change, references, total });
  }
  return broken;
};

const simulate = async ({ cwd, sha, target, validate, validator, files, onEvent }) => {
  const result = { status: 'skipped', conflicts: [], brokenReferences: [], validation: null, cleanedUp: true, dependenciesLinked: false };
  let worktree = null;
  try {
    worktree = await createWorktree(cwd, target);
    const pick = await cherryPickNoCommit(worktree, sha);
    Object.assign(result, { status: pick.status, conflicts: pick.conflicts, message: pick.message });

    if (pick.status === 'clean') {
      onEvent({ type: 'preflight-step', step: 'references' });
      result.brokenReferences = await findBrokenReferences({ cwd, worktree, target, files });
      if (validate) {
        result.dependenciesLinked = await linkDependencies(cwd, worktree);
        result.validation = await validator({
          cwd: worktree,
          onEvent,
          focusedTests: files.map((f) => f.path).filter(isTestFile),
        });
      }
    }
  } catch (error) {
    result.status = 'error';
    result.message = error.message;
  } finally {
    if (worktree) result.cleanedUp = await removeWorktree(cwd, worktree).catch(() => false);
  }
  return result;
};

const names = (items) => items.map((c) => `${c.shortSha} "${c.subject}"`).join(', ');

export const decideOutcome = ({ evidence, simulation, validate }) => {
  const findings = [];
  const add = (level, text) => findings.push({ level, text });

  if (evidence.isMerge) {
    add('blocked', 'This is a merge commit. Cherry-picking merge commits is not supported yet; pick the individual commits instead.');
  }
  if (evidence.alreadyApplied) {
    return { outcome: 'safe', findings: [{ level: 'safe', text: `Nothing to do: ${evidence.alreadyApplied.reason}.` }] };
  }

  const confirmed = evidence.prerequisites.filter((p) => p.kind === 'confirmed');
  const possible = evidence.prerequisites.filter((p) => p.kind === 'possible');

  for (const item of evidence.missing.filter((m) => m.providers.length === 0)) {
    add('blocked', `${item.usedIn} needs ${item.kind} "${item.name}", which the target lacks and no unmerged commit provides.`);
  }
  if (simulation?.status === 'error') add('blocked', `The trial cherry-pick failed: ${simulation.message || 'unknown error'}.`);
  if (simulation?.validation?.ran && !simulation.validation.passed) {
    const failed = simulation.validation.steps.find((s) => s.status === 'failed');
    add('blocked', `Validation failed on the simulated result${failed ? ` at "${failed.name}"` : ''}.`);
  }

  if (confirmed.length > 0) add('conditional', `Apply these first (oldest first): ${names(confirmed)}.`);

  if (simulation?.status === 'conflict') {
    if (confirmed.length === 0) {
      add('risky', possible.length > 0
        ? `The trial pick conflicts in ${simulation.conflicts.join(', ')}; likely caused by unmerged commits on the same files: ${names(possible)}.`
        : `The trial pick conflicts in ${simulation.conflicts.join(', ')} and no cause was found in history.`);
    }
  }
  for (const overlap of evidence.overlaps) {
    add('risky', `Branch ${overlap.branch} has ${overlap.commits.length} unmerged commit${overlap.commits.length === 1 ? '' : 's'} on the same files: ${names(overlap.commits.slice(0, 3))}${overlap.commits.length > 3 ? ', ...' : ''}.`);
  }
  for (const broken of simulation?.brokenReferences ?? []) {
    add('risky', `"${broken.name}" is ${broken.change === 'removed' ? 'removed' : 'changed'} in ${broken.file} but still used in ${broken.total} other place${broken.total === 1 ? '' : 's'} (${broken.references.slice(0, 2).map((r) => `${r.file}:${r.line}`).join(', ')}).`);
  }

  if (possible.length > 0 && simulation?.status !== 'conflict') {
    add('safe', `Unmerged commits also touch these files but nothing shows this commit needs them: ${names(possible)}.`);
  }
  if (validate && !simulation?.validation) add('safe', 'Validation was requested but did not run (the trial pick did not apply cleanly).');
  if (!validate) add('safe', 'Tests and build were not run on the simulated result (use --validate).');
  if (findings.every((f) => f.level === 'safe')) add('safe', 'No missing dependencies or conflicts were found.');

  const outcome = findings.reduce((worst, f) => (rank(f.level) > rank(worst) ? f.level : worst), 'safe');
  return { outcome, findings };
};

export const runPreflight = async ({ cwd, commit, target = 'HEAD', validate = false, validator = validateRepo, onEvent = () => {} }) => {
  const sha = await resolveCommit(cwd, commit);
  await resolveCommit(cwd, target);

  const evidence = await analyzeDependencies({ cwd, sha, target, onEvent });
  let simulation = null;
  if (!evidence.isMerge && !evidence.alreadyApplied) {
    onEvent({ type: 'preflight-step', step: 'simulate' });
    simulation = await simulate({ cwd, sha, target, validate, validator, files: evidence.files, onEvent });
  }

  const { outcome, findings } = decideOutcome({ evidence, simulation, validate });
  const report = { outcome, localOnly: true, findings, evidence, simulation, validation: simulation?.validation ?? null };
  return { ...report, lines: formatReport(report) };
};

// Report as styled lines so any UI (terminal now, VS Code later) can render it its own way.
export const formatReport = ({ outcome, localOnly, findings, evidence, simulation }) => {
  const lines = [];
  const add = (tone, text) => lines.push({ tone, text });
  const label = { safe: 'SAFE', conditional: 'CONDITIONAL', risky: 'RISKY', blocked: 'BLOCKED' }[outcome];
  const tone = { safe: 'good', conditional: 'warn', risky: 'warn', blocked: 'bad' }[outcome];

  add('heading', `Cherry-pick ${evidence.commit.shortSha} "${evidence.commit.subject}" onto ${evidence.target}`);
  add(tone, `Outcome: ${label}${localOnly ? ' (local analysis only)' : ''}`);
  if (localOnly) add('dim', evidence.remote.reason);

  for (const f of findings) add(f.level === 'safe' ? 'plain' : f.level === 'blocked' ? 'bad' : 'warn', `- ${f.text}`);

  if (evidence.files.length > 0) add('dim', `Files changed: ${evidence.files.map((f) => f.path).join(', ')}`);
  if (evidence.prerequisites.length > 0) {
    add('heading', 'Prerequisites');
    for (const p of evidence.prerequisites) {
      add(p.kind === 'confirmed' ? 'warn' : 'dim', `  ${p.kind === 'confirmed' ? 'confirmed' : 'possible '} ${p.shortSha} ${p.subject}`);
      p.reasons.slice(0, 2).forEach((r) => add('dim', `      ${r}`));
    }
  }
  if (evidence.missing.length > 0) {
    add('heading', 'Missing on the target');
    for (const m of evidence.missing) add('warn', `  ${m.kind} "${m.name}" (used in ${m.usedIn})${m.providers.length ? `, provided by ${m.providers.map((p) => p.shortSha).join(', ')}` : ', provider not found'}`);
  }
  if (simulation) {
    const text = { clean: 'applied cleanly', empty: 'produced no changes', conflict: `conflicts in ${simulation.conflicts.join(', ')}`, error: 'failed' }[simulation.status] ?? simulation.status;
    add('heading', `Trial cherry-pick: ${text}`);
    if (simulation.validation) {
      for (const s of simulation.validation.steps) add(s.status === 'passed' ? 'good' : s.status === 'failed' ? 'bad' : 'dim', `  ${s.name}: ${s.status}`);
    }
    if (!simulation.cleanedUp) add('warn', 'The temporary worktree could not be fully removed; run `git worktree prune`.');
  }
  evidence.notes.forEach((n) => add('dim', `Note: ${n}`));
  return lines;
};

// The real cherry-pick. Callers must have shown the report and obtained approval first.
export const applyCherryPick = async ({ cwd, commit, target = 'HEAD' }) => {
  const branch = await getCurrentBranch(cwd);
  const targetSha = await resolveCommit(cwd, target);
  const headSha = await resolveCommit(cwd, 'HEAD');
  if (target !== 'HEAD' && target !== branch && targetSha !== headSha) {
    throw new Error(`The target is ${target} but ${branch} is checked out. Check out ${target} first, then apply.`);
  }
  if (!(await isWorkingTreeClean(cwd))) {
    throw new Error('The working tree has uncommitted changes. Commit or stash them before cherry-picking.');
  }
  return cherryPick(cwd, await resolveCommit(cwd, commit));
};
