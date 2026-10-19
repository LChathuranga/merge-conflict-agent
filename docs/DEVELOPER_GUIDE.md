# Developer guide

Everything you need to understand, run, change and debug this project. The [README](../README.md) is for users; this is for the person maintaining the code. The README also has Mermaid diagrams of the main flows (section "Technical flow"); this guide points to them instead of repeating them.

Contents

1. [What the project is](#1-what-the-project-is)
2. [The one idea that explains the design](#2-the-one-idea-that-explains-the-design)
3. [Commands you will run](#3-commands-you-will-run)
4. [Configuration](#4-configuration)
5. [Repository map](#5-repository-map)
6. [Data shapes you will see everywhere](#6-data-shapes-you-will-see-everywhere)
7. [Flow A: the CLI, from keystroke to written file](#7-flow-a-the-cli-from-keystroke-to-written-file)
8. [Flow B: the extension, from click to sidebar](#8-flow-b-the-extension-from-click-to-sidebar)
9. [The core in detail](#9-the-core-in-detail)
10. [The extension in detail](#10-the-extension-in-detail)
11. [Cherry-pick preflight and apply](#11-cherry-pick-preflight-and-apply)
12. [Safety rules (do not break these)](#12-safety-rules-do-not-break-these)
13. [Cancellation](#13-cancellation)
14. [Tests](#14-tests)
15. [Building and packaging the extension](#15-building-and-packaging-the-extension)
16. [Recipes: how to change things](#16-recipes-how-to-change-things)
17. [Debugging](#17-debugging)
18. [Windows and environment gotchas](#18-windows-and-environment-gotchas)
19. [JavaScript patterns used here](#19-javascript-patterns-used-here)
20. [Glossary](#20-glossary)

---

## 1. What the project is

A multi-agent Git assistant with two jobs:

1. **Resolve merge conflicts with an LLM.** A person approves doubtful answers, safeguards written in plain code catch bad answers whatever the model claims, and nothing is staged until checks pass (CLI) or the person clicks Stage (extension).
2. **Check a cherry-pick before doing it** (prerequisite commits, missing names and files, other branches touching the same files, a trial pick in a temporary worktree), and optionally apply it.

It ships in two forms that share one core:

| Form | Entry | For |
|---|---|---|
| CLI | `bin/cli.js` (`resolve-conflicts`), `bin/preflight.js` (`cherry-pick-check`) | terminal use, scripts, learning the core |
| VS Code extension "Merge Assistant" | `src/ui/vscode/extension.js`, bundled to `extension/dist/extension.js` | the main product |

Models: Ollama (local), OpenAI, Anthropic, and any OpenAI-compatible server.

Technology: plain Node.js ES modules (no TypeScript, no framework). Runtime dependencies: `openai`, `@anthropic-ai/sdk`, `jsonrepair`, `dotenv`. Tests use Node's built-in `node:test`. The extension is bundled with `esbuild` and packaged with `vsce`.

## 2. The one idea that explains the design

**The core does not know which interface it is serving.** `resolveConflicts` takes two callbacks:

- `approve(request) -> Promise<decision>`: "a person must decide this".
- `onEvent(event)`: "something happened" (progress).

The CLI passes functions that print and read from the terminal. The extension passes functions that open a web page and update a sidebar. Same core, two faces. That is what "UI-agnostic" means.

Rules that keep it true (checked by `scripts/checkArchitecture.js`, which runs before every `npm test`):

- Only `src/ui/vscode/extension.js` may `import 'vscode'`. Every other file receives the editor object as a parameter (`activateWith(vscode, context)`), so tests pass a fake.
- `import.meta` and `dotenv` appear only in `src/config/loadEnv.js` (they break when bundled to CommonJS, and the extension must never read a `.env`).
- `src/ui/viewmodel/` holds plain functions with no editor dependency: state, tree, review HTML, settings.

A second idea: **only the orchestrator writes files.** Agents are read-only advisers that return data. If a file changed on disk, the cause is `orchestrator/index.js` (resolution), `orchestrator/stage.js` (git add), or an explicit git command a person confirmed (merge, cherry-pick, abort).

## 3. Commands you will run

### Setup

```bash
npm install                  # core dependencies
cp .env.example .env         # CLI only; then edit PROVIDER / LLM_MODEL / API_KEY
npm link                     # optional: puts `resolve-conflicts` and `cherry-pick-check` on your PATH
npm run ext:install          # once: the extension's build tools (esbuild, vsce)
```

Without `npm link`, run `node <project>/bin/cli.js ...` from inside the repository you want to fix.

### The CLI: `resolve-conflicts`

Run it inside a repository that is mid-merge, mid-cherry-pick or mid-rebase with conflicts.

```bash
resolve-conflicts --dry-run     # propose, write nothing (statuses: would-resolve / would-partial)
resolve-conflicts               # apply, asking you when unsure
resolve-conflicts --review      # ask about every conflict, not only doubtful ones
resolve-conflicts --validate    # afterwards run the repo's checks
resolve-conflicts --stage       # git add resolved files, only if checks pass (implies --validate)
resolve-conflicts --tools       # let the model call read-only tools
resolve-conflicts --cwd <dir>   # work on another repository
```

| Flag | Effect |
|---|---|
| `--cwd <dir>` | repository directory (default: current) |
| `--review` | `reviewAll`: ask about every conflict |
| `--validate` | run checks after resolving |
| `--stage` | stage resolved files only if validation passed |
| `--no-intent` | skip the Intent Agent |
| `--no-references` | skip the Reference Agent |
| `--tools` | `useTools`: model may call read-only tools |
| `--dry-run` | never write |
| `-h`, `--help` | help |

At each question: `[a]ccept / [f]eedback (propose again) / [e]dit (type it yourself) / [s]kip this conflict`. Set `NO_COLOR=1` to disable colours.

### The CLI: `cherry-pick-check`

```bash
cherry-pick-check <commit>                 # report only; nothing in your repo changes
cherry-pick-check <commit> --onto <ref>    # check against another branch or commit
cherry-pick-check <commit> --validate      # also run tests/lint/build on the simulated result
cherry-pick-check <commit> --apply         # after the report, offer to run the real cherry-pick
cherry-pick-check <commit> --json          # machine-readable report, no prompts
```

### Demo repositories

```bash
npm run demo                               # temp repo, mid-merge, 3 conflicts of rising difficulty
node scripts/makeDemoRepo.js <dir> --no-merge       # main + feature ready; merge from the UI
node scripts/makeFiveConflicts.js <dir> --no-merge  # ONE file with FIVE conflicts (partial-resolve testing)
npm run demo:pick                          # repo for cherry-pick checks (3 scenarios)
```

`<dir>` must not exist or be empty.

### Tests and architecture check

```bash
npm test                          # architecture check, then every test file (~4-7 minutes on a slow machine)
node --test test/merge.test.js    # one file
node scripts/checkArchitecture.js # only the import rules
```

### The extension

```bash
npm run ext:build      # bundle core + glue to extension/dist/extension.js
npm run ext:package    # build and produce extension/merge-assistant-0.1.0.vsix
```

Try without installing: open this project in VS Code and press **F5** (launch config "Run Merge Assistant" builds first, then opens an Extension Development Host). Open a demo repository in that new window.

Install the package for everyday use: Extensions view, `...` menu, "Install from VSIX...", or `code --install-extension extension\merge-assistant-0.1.0.vsix` (add `--force` to overwrite).

## 4. Configuration

### CLI: `.env` (next to the tool, not in the target repository)

`src/config/loadEnv.js` loads the `.env` that lives beside the tool, so the commands work from any repo. Real environment variables win over the file.

| Variable | Meaning |
|---|---|
| `PROVIDER` | `openai`, `anthropic` or `ollama` (required) |
| `LLM_MODEL` | model name (required) |
| `API_KEY` | required except for `ollama` |
| `BASE_URL` | point the OpenAI adapter at any compatible server (Groq, ...); Ollama defaults to `http://localhost:11434/v1` |
| `JSON_MODE=false` | for servers that reject `response_format` |

`src/config/index.js` (`loadConfig`) validates an env-like object. It never reads `process.env` on its own unless called without arguments, so the extension passes its own values.

### Extension: settings and secrets

Settings (`mergeAssistant.*`, declared in `extension/package.json`, read by `src/ui/viewmodel/settings.js`): `provider`, `model`, `baseUrl`, `jsonMode`, `useIntent`, `useReferences`, `useTools` (default off), `maxAttempts`. API keys are never in settings: they live in VS Code SecretStorage (`src/ui/vscode/secrets.js`), one slot per server (`openai`, `anthropic`, `openai@host`), so a key is only ever sent to the server it was entered for. The extension never reads a `.env` file.

### Per-repository validation checks

The Validation Agent runs, in order, what it finds: `.merge-agent.json` (`{"validate": ["npm test", {"name": "lint", "command": "..."}]}`) wins; otherwise the `test`, `typecheck`/`type-check`/`tsc`, `lint`, `build` scripts in `package.json`, with the package manager chosen from the lock file (pnpm, yarn, npm). The placeholder `npm init` test script is ignored. When impacted test files are known, a focused test command runs first (node --test, Jest, Vitest, Mocha).

## 5. Repository map

```
bin/
  cli.js                     CLI for resolving (terminal approve/onEvent)
  preflight.js               CLI for cherry-pick-check
src/
  conflict/
    parser.js                parseConflictHunks: text with markers -> hunks (plain + diff3)
    apply.js                 applyResolutions: replace marker blocks with resolution text
  git/
    exec.js                  runGit: the ONE place git is spawned (execFile, no shell)
    index.js                 conflicted files, read/stage file, operation in progress, describeCommit, getCommits, grep
    history.js               ref validation (requireRef), commit details, branches, ancestry, clean-tree check
    merge.js                 pendingOperation, getMergeState, startMerge, abortMerge/abortOperation, listMergeCandidates
    worktree.js              temporary worktree for trial picks; cherryPick / cherryPickNoCommit
    sensitive.js             paths never exposed to a model (.env, keys, .git)
  llm/
    index.js                 createLLMClient(env): picks the adapter
    adapters/openai.js       OpenAI + any compatible server (also Ollama)
    adapters/anthropic.js    Anthropic
    toolLoop.js              runToolLoop / askWithOptionalTools: the "model asks, we run" cycle
    models.js                list models per provider (Ollama /api/tags, OpenAI/Anthropic /v1/models)
    testConnection.js        one real request to prove a setup works
  agents/                    all READ-ONLY; they return data, never write
    conflictAgent.js         proposeResolution + safeguards (findDiscardedSide, findDroppedLines)
    intentAgent.js           why each side changed, from commit messages
    referenceAgent.js        where changed names are used; importers; impacted tests
    validationAgent.js       detect and run the repo's checks (cancellable, kills process trees)
    dependencyAgent.js       cherry-pick: prerequisites, missing names/files
    json.js                  parseJsonObject (tolerant JSON extraction)
  tools/readOnlyTools.js     the 7 tools a model may request (read_file, find_references, ...)
  orchestrator/
    index.js                 resolveConflicts: THE core loop; the only writer
    stage.js                 stageResolvedFiles: git add with re-checks
  preflight/
    index.js                 runPreflight, formatReport, applyCherryPick
    diff.js                  patch analysis helpers
  config/                    loadConfig (pure) and loadEnv (CLI only)
  util/abort.js              AbortError helpers shared by everything
  ui/
    colors.js                terminal colours (CLI)
    viewmodel/               PURE: no editor imports
      session.js             sidebar state + EventEmitter
      treeModel.js           state -> tree node descriptors
      reviewPage.js          proposal -> HTML (with escaping, CSP) + message validation
      approvalModel.js       notes shown with a proposal
      runSummary.js          event/run -> log and toast text
      settings.js            settings + secret -> env object; validation; key slots
      modelSetup.js          wizard logic (explain errors, Ollama helpers)
      stageModel.js          which files are stageable
      redact.js              mask API keys in text
    vscode/                  the ONLY code that talks to VS Code (everything gets `vscode` injected)
      extension.js           activate/deactivate (the only `import 'vscode'`)
      activate.js            activateWith: build + wire everything, register commands
      gitState.js            reads git into the session; watches for changes; context keys
      tasks.js               one-task-at-a-time runner with cancellable progress
      treeProvider.js        TreeDataProvider over treeModel
      mergeCommands.js       Merge a Branch, Abort, Refresh, Open Conflict
      resolveCommands.js     Resolve with AI (all / one file)
      reviewPanel.js         the review web page (createReviewer: approve/working/dispose)
      validateCommands.js    Run Checks (shows exact commands first)
      stageCommands.js       Stage Resolved Files
      cherryPickCommands.js  Check or Apply Cherry-pick
      modelSetup.js          Set Up AI Model wizard + Test connection
      secrets.js             SecretStorage with key slots; Set/Clear API Key
      consent.js             "send code to <provider>?" prompt
      dirtyGuard.js          refuse to run while edited files are unsaved
      repo.js                find/choose the repository
      output.js              log channel with key redaction
extension/
  package.json               the manifest: commands, menus, views, settings, welcome text
  esbuild.mjs                bundle src/ui/vscode/extension.js -> dist/extension.js (CJS, node20, external vscode)
  README.md, CHANGELOG.md, media/ (icon), .vscodeignore
scripts/                     demo repos + checkArchitecture.js
test/                        one *.test.js per area (see section 14)
test-support/                shared helpers: temp git repos, fake VS Code, fake network
.vscode/launch.json, tasks.json   F5 configuration
```

## 6. Data shapes you will see everywhere

**Hunk** (`parseConflictHunks`): one conflict block.
```js
{ startLine, endLine,            // 1-based, include the marker lines
  oursLabel, theirsLabel,        // text after <<<<<<< and >>>>>>>
  ours, base, theirs }           // strings; base is null when the file has no diff3 base
```

**Proposal** (from `proposeResolution`):
```js
{ resolution, explanation, confidence: 'high'|'medium'|'low',
  needsApproval,                  // model said ambiguous, or low confidence, or a safeguard flagged it
  flags: [string],                // safeguard messages ("keeps only one side...", "missing ours changes...")
  toolCalls: [{ name, args, ok }],
  references, usedElsewhere }     // added by the orchestrator from the Reference Agent
```

**approve request** (orchestrator to front end):
```js
{ file, fileText, hunk, proposal, attempt, index, total }
```

**decision** (front end back to orchestrator):
```js
{ action: 'accept' }
{ action: 'reject' }                          // skip this conflict
{ action: 'edit',  resolution }               // person typed the text
{ action: 'retry', feedback }                 // ask the model again, with this note
```

**Events** passed to `onEvent` (all have `type`): `intent`, `intent-unavailable`, `proposing`, `proposed` (with `asksUser`), `hunk-skipped`, `partial`, `resolved`, `rejected`, `failed`, `skipped`, `file-impact`, `tool-call`, `tools-unavailable`, `references-unavailable`, `attempt-limit`, `validating`, `validated`. The cherry-pick preflight adds `preflight-step`.

**Per-file result** (`resolveConflicts` returns `{ files, validation, notValidatedReason, stageBlockedReason }`):

| `status` | Meaning |
|---|---|
| `resolved` | every conflict accepted, file written |
| `partial` | some accepted and written; skipped ones keep their markers (`remaining` says how many) |
| `rejected` | nothing accepted (all skipped) |
| `failed` | model error, or the markers left did not match what was accepted (nothing written) |
| `skipped` | no markers (binary, delete or rename conflict): resolve by hand |
| `would-resolve`, `would-partial` | dry-run versions |

**Session state** (`session.js`): `repo, branch, detached, operation, theirs, hadConflicts, files[], run, intent, validation, notices`. Each file: `{ path, hunks[{startLine,endLine,status}], status, reason, impact, remaining }` with file statuses `pending, working, review, resolved, skipped, partial, failed, manual`.

## 7. Flow A: the CLI, from keystroke to written file

You run `resolve-conflicts --review` inside a repository that is mid-merge.

1. **`bin/cli.js` starts** (`main()`): `parseArgs` turns flags into `values`; `--help` prints and exits.
2. `getRepoRoot(values.cwd ?? process.cwd())` finds the repository; `createLLMClient()` reads `.env` (loaded by `loadEnv.js`) and builds an adapter; a `readline` interface is opened.
3. It defines `approve` (prints Ours/Theirs/Proposed, asks `a/f/e/s`, returns a decision object) and an `onEvent` that prints progress.
4. It calls `resolveConflicts({ cwd, llm, approve, onEvent, reviewAll, stage, validate, useIntent, useReferences, useTools, dryRun })`.
5. **Inside the core** (details in section 9): list conflicted files, Intent Agent, then per file, per conflict: Reference Agent, Conflict Agent proposal, safeguards, `approve` if needed, retries, then write the accepted conflicts.
6. If `--validate`/`--stage`: the Validation Agent runs the repo's checks; with `--stage`, files are staged only if everything passed.
7. `cli.js` prints a coloured summary per file, then validation results and a hint (staged, or "review, test, then `git add`").
8. `finally { rl.close() }`; any thrown error prints in red and exits with code 1.

## 8. Flow B: the extension, from click to sidebar

### 8a. Startup

1. VS Code loads the extension because the manifest says `activationEvents: ["workspaceContains:.git"]`, and runs `activate(context)` in `extension.js`, which calls `activateWith(vscode, context)`.
2. `activateWith` (in `activate.js`) builds, in order: secret store (and a list of known keys for log redaction), logger, settings reader, the `register` helper (wraps every command so a failure shows an error and a "Show Log" button), `session`, task `runner`, `gitState`, tree provider and tree view, command groups, then registers every command id from the manifest.
3. It then shows the model status next to the view title, finds the repository (`pickRepo`; asks once if several are open), starts watching git, and does a first `gitState.refresh()`.
4. `gitState.load()` calls `getMergeState` (which looks for `MERGE_HEAD` / `CHERRY_PICK_HEAD` in `.git`), parses each conflicted file with `parseConflictHunks`, and calls `session.syncGit(...)`. It also sets context keys (`mergeAssistant.mergeInProgress`, `hasConflicts`, `busy`, ...) that the manifest's menus and welcome text depend on.
5. `session` emits `change`; `treeProvider` asks `treeModel` for nodes and VS Code redraws the sidebar.

State always comes from two sources: **git on disk** (so a window reload loses nothing) and **run events** (what the AI is doing now). Git changes made elsewhere (terminal, commit, abort) are noticed through the built-in Git extension's change events and window focus, debounced, and refreshed.

### 8b. Click "Resolve Conflicts with AI"

`resolveAll` -> `run(null)` in `resolveCommands.js`:

1. Checks: a repository is open; the operation is a merge or cherry-pick; some file still has markers; settings are valid and a key exists (else offer Set Up AI Model / Open Settings); Ollama is reachable and has the model; the user consented to sending code to a cloud provider; edited files are saved.
2. `createClient(buildEnv(settings, apiKey))` builds the model client.
3. `runner.run('resolve', task)`: marks the session busy, shows a cancellable progress notification, and creates an `AbortController`.
4. The task creates a **reviewer** (`createReviewer`) and calls `resolveConflicts({ ..., approve: reviewer.approve, signal, onlyFiles, stage: false, validate: false, onEvent })`. The extension never stages or validates inside this run; those are separate buttons.
5. `onEvent` does three things per event: `session.handleEvent(event)` (sidebar), the logger, and the reviewer's "working" screen.
6. When a proposal needs a decision, `reviewer.approve` opens (or reuses) one web page, renders the three boxes, the surrounding file and the safeguards, and waits for a button. Close the page = skip that conflict.
7. The run ends (or is cancelled; finished files are kept). `session.recordResults(...)`, `gitState.refresh()`, then a summary toast with buttons (Run Checks, Stage Resolved Files, Open Source Control).

### 8c. The other buttons

| Button (command id) | What it does |
|---|---|
| Merge a Branch (`mergeBranch`) | refuses if an operation is in progress; lists branches with commits to merge; modal confirmation; unsaved-files guard; `git merge --no-ff --no-commit` |
| Abort Merge (`abortMerge`) | modal; `git merge --abort` or `git cherry-pick --abort` (`abortOperation`); other operations are left alone |
| Run Checks (`runChecks`) | shows the exact commands (a merge brings in code that may have changed them), runs only after confirmation, focused tests first, cancellable |
| Stage Resolved Files (`stageResolved`) | shows the list and what the checks said; `stageResolvedFiles` re-checks each file (still unmerged, readable, no markers) then `git add` |
| Check or Apply Cherry-pick (`checkCherryPick`) | pick branch and commit; preflight report; optional Apply (section 11) |
| Set Up AI Model (`setUpModel`) | wizard: choose provider, list real models (also proves the key), test one request BEFORE saving |
| Set/Clear API Key, Show Log, Refresh, Cancel, Choose Repository, Open Conflict | utilities |

## 9. The core in detail

### 9.1 `resolveConflicts` (`src/orchestrator/index.js`)

A thin wrapper around `run`. The wrapper creates `results = []` and passes it in; if a cancel throws, it re-throws an `AbortError` carrying `results`, so finished files are still reported (arrays are passed by reference, so what `run` pushed survives the throw).

`run`, in order:

1. `listConflictedFiles`, optionally filtered by `onlyFiles`.
2. Build tools if `useTools` (`toolsEnabled` is a switch that turns off for the run if a model cannot call tools).
3. **Intent Agent** (best effort; failure only costs context).
4. For each file: read it, parse hunks. No hunks -> status `skipped`.
5. For each hunk:
   - **Reference Agent** `gatherUsages` (once per hunk, reused across retries).
   - **Attempt loop**: emit `proposing`; `proposeResolution` (model call + safeguards); Reference Agent `assessResolution` adds flags; decide whether to ask (`needsApproval || reviewAll || attempt > 0`); `approve(...)` or auto-accept.
   - `retry` pushes `{ proposal, feedback }` into `feedbackRounds` so the next prompt includes the rejected answer and the note; at `maxAttempts` the conflict is skipped.
   - `reject` emits `hunk-skipped` and moves on; `edit` is assessed too (typed text has not been checked yet); `accept` stores `{ hunk, resolution, proposal, assessment }`.
   - A model error stops the file (a failing model will not recover), keeping what was accepted.
6. After the hunks: nothing accepted -> `rejected` or `failed`. Otherwise `applyResolutions`, then a **consistency check**: the number of markers left must equal skipped + unreached conflicts, else `failed` and nothing is written.
7. Write the file (unless `dryRun`), compute impact (importers, impacted tests), emit `file-impact`, push the result (`resolved`/`partial`).
8. If `validate`/`stage` and everything resolved: run the Validation Agent (focused tests first). Stage only if `stage` and validation passed.

### 9.2 Conflict Agent and the safeguards (`conflictAgent.js`)

- `buildPrompt`: file name, branch labels, known intent, usages elsewhere, 15 lines before and after, then OURS, BASE, THEIRS fenced.
- The system prompt tells the model to return only JSON `{resolution, explanation, confidence, ambiguous}` and treats code, comments and commit messages as data, never instructions (prompt-injection defence).
- `parseResolution` is tolerant; a broken reply gets one corrective retry.
- **Safeguards run in code, independent of the model's confidence:**
  - `findDiscardedSide`: the resolution equals one side verbatim although the other side changed it.
  - `findDroppedLines`: lines a side added or changed (relative to the base) that are missing from the resolution.
  - Reference checks: a name that is dropped or reverted while still used elsewhere.
  - Any flag forces `needsApproval`.

### 9.3 Other agents

- **Intent Agent**: `gatherIntentEvidence` finds the operation (`getOperationInProgress`) and the commits of each side (`collectSide`: commits touching the conflicted files, else recent commits; single-commit operations use `noWalk`); `summarizeIntent` asks the model for `{ours, theirs, relationship}`.
- **Reference Agent**: no model. Extracts declarations from the three versions, keeps the ones that differ, `git grep` for other uses (skipping `node_modules`, lock files, build output), resolves importers, finds tests. Text matching, not a compiler: false positives and misses are possible.
- **Validation Agent**: `detectValidationCommands`, `planValidation`, `runValidation` (spawns, timeout, kills the process tree on abort, abandons unkillable processes after a grace period).
- **Dependency Agent**: used by preflight (section 11).

### 9.4 LLM layer

- `createLLMClient(env)` -> `loadConfig` -> adapter. Adapters expose `complete({system, messages, json, signal})` and `chat({system, messages, tools, signal})`.
- OpenAI adapter handles OpenAI, Ollama and compatible servers; it repairs broken tool-argument JSON (`jsonrepair`) but rejects non-object arguments. Anthropic adapter translates the neutral message format.
- Neutral message shapes: `{role:'user'|'assistant', content}`, assistant with `toolCalls`, and `{role:'tool', toolCallId, name, content}`.
- **Tool loop** (`toolLoop.js`): the model only *requests* calls; our code finds the tool by name and runs it (max 4 per turn, identical repeats reuse the earlier result, results cut at 6000 characters, errors go back to the model as text, a step budget forces a final answer). `askWithOptionalTools` falls back to a plain request if the provider rejects tools, but never on a cancel.
- Tools (`readOnlyTools.js`): `read_file`, `find_references`, `list_importers`, `get_conflict_stages`, `git_log`, `git_show`, `git_blame`. All read-only; paths are resolved inside the repo and checked with `isSensitivePath`.

### 9.5 Git layer

All git goes through `runGit(cwd, args, {allowFailure})` using `execFile` (no shell, so branch or file names can never be read as commands; 64 MB output buffer). `allowFailure: true` returns `{ok:false,...}` instead of throwing, for questions where "no" is a normal answer. Refs and shas that come from users or models are validated (`requireRef`) so none can be read as an option.

Detecting an operation exists twice on purpose: `getOperationInProgress` (git/index.js, asks git via `rev-parse --verify`) is used by agents; `pendingOperation` (git/merge.js) checks marker files inside `.git` directly because it runs on every UI refresh. `isResolvable(op)` is true for `merge` and `cherry-pick`; a revert or rebase is shown as "another operation" and left alone.

## 10. The extension in detail

- **Manifest** (`extension/package.json`): `main: ./dist/extension.js`, `engines.vscode ^1.90`, activity-bar container `mergeAssistant`, view `mergeAssistant.steps`, 17 commands, `view/title` and `view/item/context` menus gated by context keys, `viewsWelcome` blocks (no repository open, another operation such as a rebase or revert in progress, and "no merge in progress" with the Merge, Check or Apply Cherry-pick and Set Up AI Model links), the settings, and `capabilities.untrustedWorkspaces.supported: false` (validation runs repository scripts, so Workspace Trust is required). A test (`extensionBundle.test.js`) checks that every contributed command is registered and nothing undeclared is.
- **Context keys** are how the manifest hides and shows buttons: `mergeAssistant.hasRepo`, `mergeInProgress` (true for merge or cherry-pick), `otherOperation`, `hasConflicts`, `busy`, `modelReady`.
- **Session and tree**: `session.js` is a closure returning an object (`state` getter, `onDidChange`, `setRepo`, `syncGit`, `beginRun`, `endRun`, `handleEvent`, `recordResults`, `setValidation`). It holds state in a variable replaced on each update (that is why `state` is a getter) and announces with an `EventEmitter`. `syncGit` keeps what a run decided (`skipped`, `failed`, `partial`) while a file still has conflicts. `treeModel.buildTree` produces steps 1 Merge/Cherry-pick, 2 Conflicts, 3 Review, 4 Validate, 5 Stage, with stable ids so selection survives refreshes.
- **Review page**: `reviewPage.js` builds the HTML (ours/theirs/proposed with per-line tags, safeguard alerts, surrounding file with other conflicts labelled, "Why the model chose this", Accept / Give feedback / Skip). It escapes everything, uses a nonce CSP and validates incoming messages strictly (`parseDecisionMessage`, feedback capped at 2000 characters, a request id so a stale page cannot answer a newer question). `reviewPanel.js` owns the single panel for the whole run.
- **Task runner** (`tasks.js`): one task at a time; the others get "already running". Wraps `withProgress` with cancellation and sets the `busy` context.
- **Security in the glue**: keys only in SecretStorage with per-server slots; logger redaction (`redact.js`) of known keys plus key-shaped patterns; consent before cloud use; the unsaved-files guard; validation commands shown before running.

## 11. Cherry-pick preflight and apply

`runPreflight({cwd, commit, target, validate, signal, onEvent})` (`src/preflight/index.js`) never touches your files:

1. Block merge commits and invalid refs.
2. Dependency Agent: prerequisite commits (earlier commits on the source branch that this commit builds on), names and files the commit uses that the target lacks, other branches working on the same files.
3. A **trial pick in a temporary git worktree** (`worktree.js`), optionally running the repo's checks there; the worktree is removed afterwards.
4. Result `outcome`: `safe`, `conditional`, `risky` or `blocked`, with `findings` and report `lines` (`formatReport`). The wording always says "local analysis only": open pull requests are not checked.

Applying (extension, `cherryPickCommands.js`; CLI `--apply`): only offered when the outcome is not `blocked`. Refused if another operation is in progress or tracked files have uncommitted changes. A modal confirmation says Git creates a commit right away if it applies cleanly; non-safe outcomes also require typing `apply`. `applyCherryPick` re-checks the branch and clean tree, then runs plain `git cherry-pick <sha>`. A clean pick is committed by Git; conflicts stop with markers and `CHERRY_PICK_HEAD`, and the sidebar continues exactly as for a merge (step 1 reads "Cherry-pick"), with Abort running `git cherry-pick --abort`.

## 12. Safety rules (do not break these)

1. **Only the orchestrator writes resolved text; agents never write.**
2. **Safeguards never depend on model confidence.**
3. **No shell strings.** Use `runGit` / `execFile` with argument arrays. Validate refs and shas that come from outside (`requireRef`, `isCommitSha`).
4. **Secrets never reach a model or a log.** `isSensitivePath` blocks `.env`, keys and `.git` in tools, grep and prompts; `redact` masks keys in logs and error messages.
5. **A key is only sent to its own server** (key slots).
6. **The extension stages only through the confirmed Stage button**, re-checking each file at that moment. A merge never commits; an applied cherry-pick that is clean is committed by Git itself, after a confirmation that says so.
7. **Cancel is not an error.** Never turn an abort into a model error, a fallback or "tools unsupported". Use `rethrowIfAborted` in any `catch` that swallows failures.
8. **Model output and file contents are data, never instructions** (prompt-injection). Prompts say so, and tool results are labelled untrusted.
9. **Validation commands are shown and confirmed** in the extension before they run.
10. **No telemetry.**

## 13. Cancellation

`src/util/abort.js`: `createAbortError(message, results)`, `isAbort`, `throwIfAborted(signal)`, `rethrowIfAborted(error, signal)`, `raceAbort(promise, signal)` (rejects as soon as the signal aborts; used so a waiting review ends when you cancel).

The signal is threaded through: orchestrator checks between files, hunks and attempts; adapters pass it to the SDK request; the tool loop checks every step; the validation runner kills the process tree; `approve` is raced against it. The Reference Agent's local searches do not take the signal (they are quick; the next check stops the run). The extension's `AbortController` is created in `tasks.js` and fired by the progress notification's Cancel button or the Cancel command. On cancel, `error.results` holds the files already handled; they stay written on disk.

## 14. Tests

`npm test` = `node scripts/checkArchitecture.js` then `node --test --test-concurrency=4 --test-timeout=600000`. No network, no real model: tests use stub `llm` objects, real temporary git repositories, and a fake VS Code.

| Area | Files |
|---|---|
| Core | `conflictAgent`, `intentAgent`, `referenceAgent`, `validationAgent`, `orchestrator`, `orchestratorTools`, `partial`, `abort`, `toolLoop`, `tools`, `git`, `merge`, `preflight`, `preflightAbort` |
| Extension logic | `sessionTree`, `reviewPage`, `reviewModel`, `modelSetup` |
| Extension glue (fake editor) | `extensionBasics`, `mergeUi`, `resolveUi`, `validateUi`, `stageUi`, `cherryPickUi`, `modelSetupUi` |
| Packaging | `extensionBundle` (manifest promises, every command registered, welcome discoverability) |

Helpers in `test-support/`:

- `gitRepo.js`: `git()`, `cleanup()` (retries on Windows), `repoFromTemplate` (builds a history once, copies it per test: git is slow on this machine), `makeMergeRepo`, `makeMultiConflictRepo`, `makePickRepo`.
- `fakeVscode.js`: a fake `vscode` whose prompts are answered from queues in `fake.script` (`quickPick`, `inputBox`, `information`, `warning`, `error`, `review`), recording every call (`callsOf`, `messages`). Add the answer to the queue **before** triggering the command.
- `network.js`: canned HTTP replies for model listing and Ollama.

Conventions: every test builds its own temporary repo and removes it in `finally`; extension tests dispose `gitState` and wait for `settled()` before deleting a repo (a refresh still running would hold files open on Windows).

## 15. Building and packaging the extension

`extension/esbuild.mjs` bundles `src/ui/vscode/extension.js` and everything it imports (including the core and the model SDKs) into one CommonJS file `extension/dist/extension.js`, target Node 20 (the Node inside VS Code 1.90), `vscode` left external. `--production` minifies; `--watch` rebuilds on change. This is why `import.meta` and `dotenv` are banned in `src/`. `vsce package --no-dependencies` makes the `.vsix` from `dist/extension.js`, `media/`, the manifest and READMEs (`.vscodeignore` excludes the rest). Build output and `*.vsix` are git-ignored.

To publish to the Marketplace you would need a publisher account and a token (`vsce publish`); not done yet.

## 16. Recipes: how to change things

**Add a command (button)**
1. Declare it in `extension/package.json` (`commands`, plus `menus` / `viewsWelcome` if it needs a button).
2. Implement it in a `src/ui/vscode/*Commands.js` factory that takes `{ vscode, getRepo, runner, logger, ... }`.
3. Register it in `activate.js` with `register('mergeAssistant.name', fn)`.
4. Add a test with the fake editor. `extensionBundle.test.js` fails if the manifest and registration disagree.

**Add a model provider**: write an adapter in `src/llm/adapters/` exposing `complete` (and `chat` for tools), register it in `ADAPTERS` in `src/llm/index.js`, accept the name in `loadConfig`, and add it to the extension's settings enum, `settings.js` and the wizard (`modelSetup.js`, `models.js`).

**Add a safeguard**: add the check in `conflictAgent.js` (or the Reference Agent), append a message to `flags`; any flag forces approval automatically. Test it with a stub model that returns the bad answer.

**Add a read-only tool**: add an object `{name, description, parameters, run}` to `createReadOnlyTools`; use `resolveInsideRepo` and `isSensitivePath` for any path; return text, cut by the loop.

**Add an agent**: a read-only module returning data; call it from the orchestrator inside `bestEffort` (so its failure never blocks resolving) and pass `signal`.

**Add an event**: emit it from the orchestrator via `onEvent`; handle it in `session.handleEvent` (state), `runSummary.describeEvent` (log/progress) and, for the CLI, in `onEvent` in `bin/cli.js`.

**Change what the review page shows**: edit `renderReviewHtml` / `STYLE` in `reviewPage.js`; `reviewPage.test.js` covers escaping and structure. To eyeball it, render the HTML to a file and open it in a browser (the CSS uses VS Code theme variables with fallbacks).

## 17. Debugging

- **Extension**: press F5; in the Extension Development Host open **View > Output > "Merge Assistant"** (the redacted log; the command "Show Log"). Breakpoints in `src/ui/vscode/*.js` work through the source map. Developer: Reload Window after rebuilding.
- **Good breakpoints for the main flow**: `resolveCommands.js` where `resolve({...})` is called; `orchestrator/index.js` at the `proposeResolution` call and the `approve` call; `conflictAgent.js` at the model `ask`.
- **Dry runs**: `resolve-conflicts --dry-run` shows what would happen without writing.
- **Nothing happens when clicking**: check the context keys (a button hidden by `when`), the `busy` flag (a task already running), and the log.
- **Sidebar is stale**: `Merge Assistant: Refresh`; `gitState` debounces 300 ms and coalesces bursts.
- **A key leaked into text**: the logger masks known keys and common key shapes; if a new key format appears, add a pattern to `redact.js` (and a test).

## 18. Windows and environment gotchas

- The project sits in OneDrive with a large `node_modules`; sync and security scanners make git and process spawning slow. Tests are built for this: `repoFromTemplate`, generous timeouts, `--test-concurrency=4`. Do not raise concurrency without measuring.
- Deleting temporary repos can fail with `EBUSY` while a process still holds them: stop watchers (`gitState.dispose()` + `settled()`), kill spawned processes, and use the retrying `cleanup`.
- Line endings: git warns "LF will be replaced by CRLF"; harmless. `applyResolutions` preserves the file's own line ending.
- Shell quirks when scripting edits: Node one-liners in a heredoc lose backslashes; use the editor tools or file-based scripts.
- `.env` lives next to the tool and is git-ignored (`.env.example` is tracked).

## 19. JavaScript patterns used here

- **Dependency injection**: functions take what they need as parameters (`vscode`, `llm`, `approve`, `fetchImpl`, `preflight`, `createClient`) so tests pass fakes. Default parameters supply the real thing (`resolve = resolveConflicts`).
- **Callbacks as the interface** between layers (`approve`, `onEvent`, `getSettings`'s `(key, fallback) => ...`).
- **Closures instead of classes**: `createSession`, `createGitState`, `createTaskRunner`, `createReviewer` return objects whose methods share private variables.
- **Getters** (`get state()`) so a value that is replaced is always read fresh.
- **Pass-by-reference for accumulators** (`results` in `resolveConflicts`).
- **`EventEmitter`** for "state changed" notifications.
- **`allowFailure`** returns instead of throws when "no" is a normal answer.
- **`Boolean(x)` / `.filter(Boolean)`** to coerce or drop empty values.
- **`for (;;)`** for "repeat until something inside returns".
- **Destructuring loops** such as `for (const [operation, ref, single] of candidates)` for table-driven code.
- **`Map` / `Set`** for lookups and uniqueness.
- **Best-effort wrappers** (`bestEffort`) around advisory features so their failure never blocks the main job.

## 20. Glossary

- **Hunk / conflict**: one `<<<<<<<` ... `>>>>>>>` block.
- **Ours / theirs / base**: the branch you are on / the incoming change / the common ancestor.
- **diff3**: marker style that also shows the base (`|||||||`); plain style does not.
- **Operation**: merge, cherry-pick, rebase or revert in progress (marker files `MERGE_HEAD`, `CHERRY_PICK_HEAD`, ...).
- **Resolvable operation**: merge or cherry-pick (the ones this tool walks through).
- **Partial resolution**: accepted conflicts written, skipped ones keep their markers.
- **Safeguard / flag**: a code-level check that forces human approval.
- **Orchestrator**: `resolveConflicts`, the coordinator and the only writer.
- **Agent**: a read-only specialist that returns data.
- **Preflight**: the pre-cherry-pick check.
- **Worktree**: a second checkout of the repository in a temporary folder, used for trial picks.
- **Session**: the extension's state object behind the sidebar.
- **Context key**: a flag set with `setContext` that menus and welcome text can test in `when` clauses.
- **Webview**: an HTML page inside VS Code (the review page).
- **SecretStorage**: VS Code's encrypted store for API keys.
- **VSIX**: the installable extension package.
- **UI-agnostic**: the core works with any interface because it only talks through `approve` and `onEvent`.
