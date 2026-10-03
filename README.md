# merge-conflict-agent

A multi-agent Git assistant that resolves merge conflicts with an LLM, keeps you in control of every uncertain decision, and refuses to stage anything until your repo's own checks pass.

> **Status: learning project, CLI first.** The long-term goal is a VS Code extension. The core is deliberately UI-agnostic so the extension can reuse it. See [PLAN.md](PLAN.md) for the full design.

## Why

A clean textual merge does not guarantee working code, and an LLM that "merges" a conflict can quietly revert one side's change or delete a declaration while sounding confident. This tool treats the model as an advisor:

- It proposes a resolution for each conflict hunk.
- Code-side safeguards flag proposals that look wrong, whatever the model claims.
- You approve, give feedback, edit, or skip.
- Nothing is staged until the repo's tests, lint, typecheck and build pass.

## Requirements

- Node.js 20 or newer (developed and tested on 22)
- Git on your `PATH`
- One LLM provider: OpenAI, Anthropic, or a local [Ollama](https://ollama.com) server

## Setup

```bash
npm install
cp .env.example .env     # then edit .env
npm link                 # optional: installs the `resolve-conflicts` command globally
```

### Choosing a model

Everything is configured in `.env`; no code changes are needed to switch providers.

| Provider | `.env` |
|---|---|
| OpenAI | `PROVIDER=openai`, `LLM_MODEL=gpt-4o-mini`, `API_KEY=sk-...` |
| Anthropic | `PROVIDER=anthropic`, `LLM_MODEL=<claude model>`, `API_KEY=sk-ant-...` |
| Ollama (local, free) | `PROVIDER=ollama`, `LLM_MODEL=llama3.1` (no key; run `ollama pull llama3.1` first) |
| Other OpenAI-compatible (Groq, ...) | `PROVIDER=openai`, `BASE_URL=<endpoint>`, `API_KEY=...` |

Optional: `JSON_MODE=false` if an OpenAI-compatible server rejects `response_format`.

Small local models are fine for trying the tool but make more mistakes. The safeguards below catch many of them, but expect more approval prompts than with a larger model.

## Usage

Run it inside a repository that is in the middle of a merge, cherry-pick or rebase with conflicts:

```bash
resolve-conflicts --dry-run     # propose fixes, write nothing
resolve-conflicts               # apply fixes, asking you when unsure
resolve-conflicts --validate    # also run the repo's checks afterwards
resolve-conflicts --stage       # git add resolved files, only if checks pass
```

Without `npm link`, use `node /path/to/merge-conflict-agent/bin/cli.js ...` from inside the target repo.

| Flag | Meaning |
|---|---|
| `--cwd <dir>` | Repository directory (default: current directory) |
| `--review` | Ask for approval on every hunk, not just uncertain ones |
| `--validate` | After resolving, run the repo's checks (test, typecheck, lint, build) |
| `--stage` | `git add` resolved files, only if validation passes (implies `--validate`) |
| `--no-intent` | Skip reading commit messages to learn why each branch changed |
| `--dry-run` | Propose resolutions but do not write any files |

Colors are used on terminals; set `NO_COLOR=1` to turn them off.

### When it asks you

```
[a]ccept / [f]eedback (propose again) / [e]dit (type it yourself) / [s]kip file >
```

- **accept**: use the proposal.
- **feedback**: tell the model what to change ("keep both, timeout stays 60"). It sees its rejected attempt plus your comment and proposes again. A revised proposal always comes back to you. Up to 5 attempts per hunk.
- **edit**: type the replacement yourself; finish with a line containing only `.`.
- **skip**: leave the file conflicted for you to resolve by hand.

## How it works

A master orchestrator coordinates read-only specialist agents. Only the orchestrator writes files or stages changes.

1. **Detect** conflicted files and parse conflict hunks (plain and diff3 markers).
2. **Intent Agent** reads the commit messages on both sides (for a merge, cherry-pick or rebase) and summarizes what each side was trying to achieve. The summary is passed to the next step. Commit messages are the only source for now; see [Intent sources](#intent-sources).
3. **Conflict Agent** proposes a resolution for each hunk using the base, ours and theirs versions plus surrounding code.
4. **Safeguards** (in code, independent of the model) require your approval when a resolution keeps only one side verbatim, or is missing lines that a side added or changed. These show up as `Flagged:` lines.
5. **You decide**: accept, give feedback, edit, or skip.
6. **Apply** the resolution, confirm no conflict markers remain, and write the file.
7. **Validation Agent** (with `--validate` / `--stage`) runs the repo's checks in order and stops at the first failure.
8. **Stage** resolved files only if every check passed. If no checks are found, or any file is unresolved, nothing is staged.

A failure in one hunk or one model reply never crashes the run: bad JSON is retried once, and a file that still fails is reported and left untouched.

### Intent sources

The Intent Agent answers "why did each side change this?" so the Conflict Agent can resolve a contradiction by purpose, not just by text. It combines whatever evidence is available.

**Used today**

- Commit messages (subject and body, up to 20 commits per side, preferring commits that touch the conflicted files). For a cherry-pick or rebase, "theirs" is exactly the one commit being replayed.

**Planned** (ideas, not built yet; roughly in order of expected value)

- **Pull request title, description and linked issues**, via the GitHub / GitLab / Bitbucket API or CLI. This is usually the best statement of intent and is also what the cherry-pick preflight needs.
- **Issue tracker tickets** referenced in commit messages or branch names (for example `PROJ-123`), including the ticket's description and acceptance criteria.
- **Branch names** such as `hotfix/session-timeout`, as a cheap hint.
- **What the commits actually changed**: the diff itself, and any tests added or modified alongside it. A test that asserts `SESSION_MINUTES === 15` says more than the commit message does.
- **Review comments** on the pull requests, where reviewers often explain why a value was chosen.
- **Repository docs**: `CHANGELOG`, architecture decision records, `CONTRIBUTING`, and code comments near the conflict.
- **Ownership**: `CODEOWNERS` and blame, so an ambiguous conflict can say who to ask instead of guessing.

Every source is treated as untrusted data, never as instructions to the model. The agent should also say when the evidence is thin ("unclear") instead of inventing a purpose, and results should state which sources were actually used. When remote PR information is unavailable, the tool will say that its answer is based only on local repository state.

### Validation checks

The Validation Agent uses, in priority order:

1. `.merge-agent.json` in the repo root:
   ```json
   { "validate": ["npm test", { "name": "lint", "command": "npm run lint" }] }
   ```
2. Otherwise the `test`, `typecheck` (or `type-check` / `tsc`), `lint` and `build` scripts in `package.json`, using npm, yarn or pnpm depending on the lock file.

Each command has a 10 minute timeout, and a timeout kills the whole process tree. These commands run on your machine, so only use `--validate` in repositories you trust.

## Try it on a demo conflict

```bash
npm run demo
```

This builds a throwaway repo, mid-merge, with three conflicts of rising difficulty (an easy one, a medium one and a deliberately ambiguous one) and prints the command to run against it.

## Project layout

```
bin/cli.js                  CLI entry point (the `resolve-conflicts` command)
src/orchestrator/           master agent: the only code that writes files or stages
src/agents/
  conflictAgent.js          proposes resolutions, flags suspicious ones
  intentAgent.js            explains each side's purpose from commit messages
  validationAgent.js        runs the repo's own checks
src/conflict/               conflict-marker parser and resolution applier
src/git/                    thin wrappers around the git CLI
src/llm/                    provider-agnostic client + OpenAI / Anthropic adapters
src/config/                 .env loading and validation
src/ui/                     terminal colors (the only place VS Code code may live later)
scripts/                    architecture check, demo repo generator
test/                       node:test suite (uses real temporary git repos)
```

`npm test` runs an architecture check first: no file outside `src/ui/` may import `vscode`, which keeps the core reusable for the extension.

## Testing

```bash
npm test
```

Tests use fake models, so they need no API key and no network. Integration tests create real temporary git repositories with genuine conflicts.

## Roadmap

- [x] LLM adapters (OpenAI, Anthropic, Ollama)
- [x] Conflict detection, parsing and application
- [x] Conflict Agent with safeguards, feedback and edit loop
- [x] Validation Agent gating staging
- [x] Intent Agent (commit messages)
- [ ] More intent sources: PR descriptions and linked issues, ticket text, diffs and tests, review comments, repo docs (see [Intent sources](#intent-sources))
- [ ] Reference Agent: callers, imports and tests affected by a resolution
- [ ] Dependency Agent and cherry-pick preflight (prerequisite commits, simulate in a temporary worktree)
- [ ] Remote PR awareness (GitHub / GitLab / Bitbucket)
- [ ] VS Code extension

## Known limitations

- Only tested against a local Ollama model so far; the OpenAI and Anthropic adapters are covered by unit tests but not yet by live calls.
- The "missing lines" safeguard is a text comparison, so it can flag a good merge that rewrites lines. It errs on the side of asking you.
- Intent summaries are only as good as the commit messages, the only source used so far (more are planned, see [Intent sources](#intent-sources)).
- Binary, delete and rename conflicts are reported and skipped.
- Without remote PR access, results are based only on local repository state.
