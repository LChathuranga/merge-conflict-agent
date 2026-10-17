# Merge Assistant

Start a merge from VS Code, see which files conflict, and resolve them with an AI model you control. Every doubtful change is shown as a diff for your approval. Nothing is staged unless you click Stage, and nothing is ever committed for you.

## How it works

Open the **Merge Assistant** icon in the activity bar. The view walks you through four steps.

1. **Merge.** Choose a branch to merge into the current one. This runs `git merge --no-ff --no-commit`, so no commit is created, and you can abort at any time.
2. **Conflicts.** Every conflicted file and each conflict inside it is listed. Click one to open it at that line.
3. **Review.** Choose **Resolve Conflicts with AI** (or the button on one file). For each conflict the model proposes a resolution. Confident, clean answers are applied. Anything doubtful opens a review page in the editor area, so nothing covers your code:
   - **Ours, Theirs and Proposed** are shown side by side, with line numbers. Lines that a side changed are marked green when they are in the proposal and **red when they are missing from it**, and text that neither side had is marked amber. So a proposal that quietly drops half of a merge is visible at a glance.
   - Above them are the safeguard warnings, where else the changed names are used, and the model's own explanation. The page says which conflict this is ("Conflict 2 of 3") and which attempt.
   - **Accept** applies the proposal (it reads **Accept anyway**, and **Give feedback** is the highlighted choice, when the safeguards raised warnings).
   - **Give feedback** opens a text box in the page; your note and the rejected answer go back to the model for a new proposal.
   - **Skip this conflict** leaves that one conflict as it was.
   
   A file can have several conflicts. Each is reviewed in turn, and **what you accept is written even if you skip another conflict in the same file**. The skipped one keeps its markers, and the file shows as "partly resolved" until you finish it. Closing the review page counts as skipping the conflict you were looking at.
4. **Validate.** **Run Checks** shows the exact commands (your `test`, `typecheck`, `lint` and `build` scripts, tests affected by the merge first) and only runs them after you confirm.

5. **Stage.** Resolving a file writes it to disk, but Git keeps listing it as a conflict (the `!` in Source Control) until the file is staged. **Stage Resolved Files** does that for the files the extension resolved, after showing you the list and what the checks said. Or stage them yourself with the `+` in Source Control.

Then review the changes and commit them in Source Control yourself.

## What it will not do

- It never creates a commit.
- It stages nothing on its own. **Stage Resolved Files** runs `git add` only on files that have no conflict markers left, only when you click it, and only after you confirm the list. If the checks failed the confirmation is a warning saying so.
- It never applies a cherry-pick. **Check Cherry-pick** only reports, and can copy the `git cherry-pick` command for you to run.
- It does not run any command from your repository without showing you the list first.

## Safeguards against a wrong answer

A model can sound confident and still be wrong. Besides the model's own confidence, plain code checks require your review when a proposal keeps only one side of a conflict, is missing lines a side added or changed, or drops or changes a name that is still used elsewhere in the repository. Those reasons appear in the review as warnings. A revised proposal always comes back to you.

## Choosing a model

Run **Merge Assistant: Set Up AI Model** (the gear in the sidebar toolbar, or the `...` menu; it also appears as a button on any "model not ready" message). It walks you through three steps and only saves once a real test request has worked:

1. **Where the AI runs**: Ollama on your computer, OpenAI (GPT), Anthropic (Claude), or another OpenAI-compatible server (LM Studio, Groq, a company gateway).
2. **Its details**:
   - *Ollama*: it checks that Ollama is running and lists the models you have downloaded, so you pick one instead of typing it. If Ollama is not running, or has no models, it says how to fix that (for example `ollama pull llama3.1`, with a button to copy the command).
   - *OpenAI or Claude*: paste your API key (masked as you type). The key is checked by asking the provider which models your account can use, and you pick from that list. If the list cannot be fetched you can still type a model name.
   - *Another server*: its address, an optional key, then the model.
3. **Test**: one tiny request through the same path a real run uses. If it fails you are told why in plain words (key rejected, model not found, server unreachable, rate limit...) and can try again, change the settings, or save anyway. Nothing is saved before this step, except when you choose "Save Anyway".

**Test AI Model Connection** repeats the test on what is saved now. The sidebar shows the model in use next to its title, and says what is missing if something is.

| Provider | Needs | Where your code goes |
|---|---|---|
| Ollama (default) | [Ollama](https://ollama.com) running, and a downloaded model | stays on your machine |
| OpenAI | an API key | OpenAI |
| Anthropic (Claude) | an API key | Anthropic |
| Other server | its address (and key if it needs one) | that server (nowhere outside this machine if it is on `localhost`) |

**Your keys.** API keys are kept in VS Code's secret storage, never in settings or files, and are masked in the log. Each key is saved against the server it belongs to, and is only ever sent there: the real OpenAI key is never sent to another address, even if a project's settings point the extension at one. Before code is first sent to a cloud service you are asked to allow it.

Before every run with Ollama, the extension checks that it is running and has the model, so a stopped server shows up as one clear message and not as an error on every file.

The settings (`mergeAssistant.provider`, `model`, `baseUrl`) can still be edited by hand, but the wizard is easier and checks the result.

Small local models make more mistakes; expect more review prompts than with a larger model. The safeguards above are there for that reason.

## Optional extras (settings)

- `mergeAssistant.useIntent` reads the commit messages of both branches to explain why each side changed.
- `mergeAssistant.useReferences` finds other uses of the names a conflict changes, so dropped or changed names are flagged.
- `mergeAssistant.useTools` (off by default) lets the model call read-only tools to read other files and search the history. **What it reads is sent to the model provider.** Files that commonly hold secrets (`.env`, keys, `.git`) are never read. Many small local models cannot use tools; the extension then carries on without them.

## Good to know

- It needs a **trusted workspace** because the checks run your repository's scripts, and a local Git repository. It is switched off in untrusted and virtual workspaces.
- In a remote window (WSL, SSH, dev container) the extension runs on the remote side, so `localhost` for Ollama means the remote machine.
- Unsaved edits to files that would be rewritten are saved first, after you confirm.
- Cancelling (the button in the progress notification) stops the model call or running check. Files already resolved stay resolved.
- Conflict analysis understands JavaScript and TypeScript names. Other languages still get the AI proposal and the safeguards that compare text.
- Binary, delete, rename and submodule conflicts have no markers; they are listed so you can resolve them yourself.
- The cherry-pick check looks at the local repository only (it does not see open pull requests), so its best result is "safe as far as local history shows".

## Install from a `.vsix`

`Extensions` view, then `...`, then **Install from VSIX...**.

## Build it yourself

```bash
cd extension
npm install
npm run build        # development bundle
npm run package      # production bundle and a .vsix
```

To try it without installing, open the `extension` folder in VS Code and press F5. To get a repository with conflicts to play with, run `node scripts/makeDemoRepo.js <folder> --no-merge` from the project root and open that folder in the new window.
