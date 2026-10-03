import {
  blameShas,
  commitsAddingFile,
  commitsChangingText,
  commitsNotOnTarget,
  fileExistsAtRef,
  getCommitDetails,
  getCommitFiles,
  getCommitPatch,
  grepAtRef,
  isAncestor,
  isPatchOnTarget,
  isShallowRepository,
  listOtherBranches,
  listUnmergedShas,
  readFileAtRef,
} from '../git/history.js';
import { getCommits } from '../git/index.js';
import { extractUsedNames, importCandidates, isCodeFile, parseUnifiedDiff } from '../preflight/diff.js';

// Read-only and deterministic: answers "what must already be on the target branch for this
// commit to work?" from git history alone. It never changes the repository.
//
// Findings are split by how sure they are:
//   confirmed - the commit edits lines, or uses names or files, that only exist in unmerged history
//   possible  - unmerged commits touch the same files, but nothing proves the commit needs them

const MAX_BLAME_LINES = 400;
const MAX_SYMBOLS = 30;
const MAX_EQUIVALENCE_CHECKS = 30;
const MAX_BRANCHES = 30;
const MAX_COMMITS_PER_BRANCH = 10;
const MAX_PROVIDERS = 3;

const REMOTE_NOT_CHECKED = {
  checked: false,
  reason: 'Open pull requests were not checked: no GitHub, GitLab or Bitbucket integration is configured, so this analysis uses the local repository only.',
};

const packagesOf = (text) => {
  if (!text) return new Set();
  try {
    const pkg = JSON.parse(text);
    return new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies }));
  } catch {
    return new Set();
  }
};

export const analyzeDependencies = async ({ cwd, sha: given, target = 'HEAD', onEvent = () => {} }) => {
  const step = (name) => onEvent({ type: 'preflight-step', step: name });
  const commit = await getCommitDetails(cwd, given);
  const sha = commit.sha;
  const evidence = {
    commit,
    target,
    files: [],
    isMerge: commit.parents.length > 1,
    alreadyApplied: null,
    prerequisites: [],
    missing: [],
    overlaps: [],
    notes: [],
    remote: REMOTE_NOT_CHECKED,
  };
  if (evidence.isMerge) return evidence;

  step('history');
  if (await isAncestor(cwd, sha, target)) {
    evidence.alreadyApplied = { reason: `${commit.shortSha} is already part of ${target}'s history` };
    return evidence;
  }
  if (await isPatchOnTarget(cwd, target, sha)) {
    evidence.alreadyApplied = { reason: `${target} already contains an equivalent change (probably cherry-picked before)` };
    return evidence;
  }

  evidence.files = await getCommitFiles(cwd, sha);
  const paths = [...new Set(evidence.files.flatMap((f) => [f.path, f.oldPath].filter(Boolean)))];
  const parent = commit.parents[0] ? `${sha}^` : null;
  const range = parent ? `${target}..${sha}^` : null;
  const parsed = parseUnifiedDiff(await getCommitPatch(cwd, sha));

  if (await isShallowRepository(cwd)) {
    evidence.notes.push('This is a shallow clone, so history checks may be incomplete. Run `git fetch --unshallow` for a reliable answer.');
  }

  const found = new Map(); // sha -> { sha, shortSha, subject, kind, reasons }
  const addPrerequisite = (c, kind, reason) => {
    const known = found.get(c.sha) ?? { sha: c.sha, shortSha: c.shortSha ?? c.sha.slice(0, 7), subject: c.subject ?? '', kind: 'possible', reasons: [] };
    if (kind === 'confirmed') known.kind = 'confirmed';
    if (!known.reasons.includes(reason)) known.reasons.push(reason);
    if (!known.subject && c.subject) known.subject = c.subject;
    found.set(c.sha, known);
  };

  const onTarget = new Map();
  const isOnTarget = async (commitSha) => {
    if (!onTarget.has(commitSha)) {
      onTarget.set(commitSha, (await isAncestor(cwd, commitSha, target)) || (await isPatchOnTarget(cwd, target, commitSha)));
    }
    return onTarget.get(commitSha);
  };

  if (parent) {
    // 1. Lines this commit edits or removes: who wrote them, and is that commit on the target?
    step('blame');
    let budget = MAX_BLAME_LINES;
    for (const file of parsed) {
      if (!file.oldPath || budget <= 0) continue;
      for (const hunk of file.hunks) {
        if (hunk.oldCount === 0 || budget <= 0) continue;
        const count = Math.min(hunk.oldCount, budget);
        budget -= count;
        const writers = await blameShas(cwd, parent, file.oldPath, hunk.oldStart, hunk.oldStart + count - 1);
        for (const [writer, lines] of writers) {
          if (await isOnTarget(writer)) continue;
          const detail = await getCommitDetails(cwd, writer);
          addPrerequisite(detail, 'confirmed', `${file.oldPath}: line${lines.length === 1 ? '' : 's'} ${lines.join(', ')} that this commit changes were written by ${detail.shortSha}, which is not on ${target}`);
        }
      }
    }

    // 2. Names, files and packages the new code relies on that the target does not have.
    step('symbols');
    const targetPackages = packagesOf(await readFileAtRef(cwd, target, 'package.json'));
    const parentPackages = packagesOf(await readFileAtRef(cwd, parent, 'package.json'));
    const commitPackages = packagesOf(await readFileAtRef(cwd, sha, 'package.json'));
    const checkedSymbols = new Set();
    const checkedFiles = new Set();

    for (const file of parsed) {
      const path = file.newPath;
      if (!path || !isCodeFile(path)) continue;
      const addedCode = file.hunks.flatMap((h) => h.added.map((a) => a.text)).join('\n');
      const used = extractUsedNames(addedCode);

      for (const specifier of used.relativeImports) {
        const candidates = importCandidates(path, specifier);
        const key = candidates[0];
        if (checkedFiles.has(key)) continue;
        checkedFiles.add(key);

        let existsOnTarget = false;
        for (const candidate of candidates) {
          if (await fileExistsAtRef(cwd, target, candidate)) { existsOnTarget = true; break; }
        }
        if (existsOnTarget) continue;

        let before = null;
        for (const candidate of candidates) {
          if (await fileExistsAtRef(cwd, parent, candidate)) { before = candidate; break; }
        }
        if (!before) continue; // added by this commit itself, or not a plain file path

        const providers = await commitsAddingFile(cwd, range, before);
        evidence.missing.push({ kind: 'file', name: before, usedIn: path, providers: providers.slice(0, MAX_PROVIDERS) });
        for (const provider of providers.slice(0, MAX_PROVIDERS)) addPrerequisite(provider, 'confirmed', `adds ${before}, which ${path} imports but ${target} does not have`);
      }

      for (const name of used.packages) {
        if (targetPackages.has(name)) continue;
        if (commitPackages.has(name) && !parentPackages.has(name)) {
          const note = `This commit adds the dependency "${name}"; install dependencies on ${target} after applying it.`;
          if (!evidence.notes.includes(note)) evidence.notes.push(note);
        } else if (parentPackages.has(name)) {
          const providers = await commitsChangingText(cwd, `"${name}"`, { range, paths: ['package.json'] });
          evidence.missing.push({ kind: 'package', name, usedIn: path, providers: providers.slice(0, MAX_PROVIDERS) });
          for (const provider of providers.slice(0, MAX_PROVIDERS)) addPrerequisite(provider, 'confirmed', `adds the dependency "${name}", which ${path} imports but ${target} does not list`);
        }
      }

      for (const name of used.symbols) {
        if (checkedSymbols.size >= MAX_SYMBOLS || checkedSymbols.has(name)) continue;
        checkedSymbols.add(name);
        if (await grepAtRef(cwd, target, name)) continue;
        if (!(await grepAtRef(cwd, parent, name))) continue; // new in this commit, or a global

        const providers = await commitsChangingText(cwd, name, { range });
        evidence.missing.push({ kind: 'symbol', name, usedIn: path, providers: providers.slice(0, MAX_PROVIDERS) });
        for (const provider of providers.slice(0, MAX_PROVIDERS)) addPrerequisite(provider, 'confirmed', `introduces "${name}", which ${path} uses but ${target} does not have`);
      }
    }

    // 3. Everything else unmerged that touches the same files: only a possible dependency.
    step('ancestry');
    const sameFiles = await commitsNotOnTarget(cwd, target, parent, { paths, maxCount: MAX_EQUIVALENCE_CHECKS });
    for (const c of sameFiles) {
      if (found.has(c.sha) || (await isPatchOnTarget(cwd, target, c.sha))) continue;
      addPrerequisite(c, 'possible', 'changed the same files and is not on the target branch');
    }
  }

  // Oldest first is the order they would have to be applied in.
  const order = parent ? await listUnmergedShas(cwd, target, parent) : [];
  const position = (commitSha) => (order.includes(commitSha) ? order.indexOf(commitSha) : order.length);
  evidence.prerequisites = [...found.values()].sort((a, b) => position(a.sha) - position(b.sha));

  // 4. Other branches with their own unmerged work on the same files (concurrent changes).
  step('overlaps');
  const branches = (await listOtherBranches(cwd, [target])).slice(0, MAX_BRANCHES);
  for (const branch of branches) {
    const commits = await getCommits(cwd, { revs: [`${target}..${branch}`, `^${sha}`], paths, maxCount: MAX_COMMITS_PER_BRANCH });
    const concurrent = [];
    for (const c of commits) {
      if (found.has(c.sha)) continue;
      if (await isAncestor(cwd, sha, c.sha)) continue; // a follow-up to this commit, not a rival
      concurrent.push({ sha: c.sha, shortSha: c.shortSha, subject: c.subject, author: c.author, date: c.date });
    }
    if (concurrent.length > 0) evidence.overlaps.push({ branch, commits: concurrent });
  }

  return evidence;
};
