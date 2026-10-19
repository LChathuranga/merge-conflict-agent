# Changelog

## 0.1.0

First version.

- Guided sidebar: start a merge, see conflicts, resolve with AI, run checks.
- Diff-based review with accept, feedback (re-proposal), compare with theirs, and skip.
- Safeguards that require review when a proposal drops a side's change or a name still in use.
- Cancellable runs; files already resolved are kept.
- Check Cherry-pick: a read-only report on prerequisites and a trial pick in a temporary worktree.
- Providers: Ollama (default, local), OpenAI, Anthropic, and OpenAI-compatible servers. Keys in secret storage.
- Stage Resolved Files: marks the files it resolved as resolved in Git (`git add`) only when you click it and confirm, after telling you what the checks said. Never commits.
- Apply Cherry-pick: after a check that is not blocked, a confirmed button runs the real cherry-pick (clean tree required; a typed `apply` for risky or conditional results). A clean pick is committed by Git; conflicts continue into the usual review, partial-resolve and Stage steps, and Abort works for cherry-picks too.
- The review recommends giving feedback, and words Accept as "Accept anyway", when the safeguards raised warnings.
- Clicking the Review, Validate and Stage rows runs that step.
- The review is a page in the editor area instead of a pop-up: ours, theirs and the proposal side by side, with each side's changes marked as in the proposal or missing from it, the warnings, "Conflict 2 of 3", and a feedback box in the page.
- Set Up AI Model: a guided wizard for Ollama, OpenAI, Claude and other OpenAI-compatible servers. It lists the installed or available models, keeps each API key against its own server, tests with one real request, and saves only when that works. The sidebar shows the model in use, and a run with Ollama first checks that it is running and has the model.
- Several conflicts in one file: what you accept is kept when you skip another. The file shows as partly resolved and can be continued later.
