# Multi-Agent Git Assistant (Merge Conflicts + Cherry-Pick Preflight)

## Context

This project builds a multi-agent Git assistant for two related workflows:

1. Resolving merge conflicts already present in a local working tree.
2. Checking whether commits are safe to cherry-pick before changing the target branch.

A clean textual merge does not guarantee working code. A resolution or cherry-pick can break imports, callers, type contracts, schemas, configuration, tests, or runtime behavior elsewhere in the repository. Therefore, validation must cover affected references and dependents, not only the changed file.

## Agent Architecture

A master agent coordinates read-only specialist agents:

- Intent Agent: Determines the purpose of each branch, commit, and related PR.
- Conflict Agent: Proposes a resolution using base, ours, and theirs.
- Dependency Agent: Finds prerequisite commits, PRs, migrations, APIs, and configuration.
- Reference Agent: Finds affected symbols, imports, exports, callers, and tests.
- Validation Agent: Runs diagnostics, tests, lint, typecheck, and build commands.

Only the master agent may edit files, resolve conflicts, cherry-pick commits, or stage changes. Specialist agents return structured evidence and recommendations.

## Required Context

The agents should receive:

- Target branch and source branch.
- Base, ours, and theirs versions from Git merge stages.
- Selected cherry-pick commit SHA or commit range.
- Conflict hunks with surrounding function or class context.
- Source and target branch diffs.
- Commit messages and changed-file lists.
- Definitions and references for changed symbols.
- Relevant tests, build configuration, and dependency manifests.
- Repository instructions and validation commands.
- Related PR metadata when remote access is available.

## Merge-Conflict Workflow

1. Detect unresolved files and conflict hunks.
2. Determine the intent of both branches.
3. Analyze affected symbols and repository-wide references.
4. Generate a proposed resolution.
5. Ask for user approval when intent is ambiguous.
6. Apply the resolution through the master agent.
7. Confirm that no conflict markers remain.
8. Run file diagnostics and repository reference checks.
9. Run focused tests followed by typecheck, lint, and build.
10. Stage files only after required validation succeeds.

## Cherry-Pick Preflight

Before cherry-picking, the agents must:

1. Inspect the selected commit and its ancestry.
2. Identify earlier commits required by its code.
3. Check whether required symbols, APIs, schemas, migrations, dependencies, or configuration exist on the target branch.
4. Inspect linked and overlapping PRs.
5. Determine whether another PR or commit must be merged first.
6. Distinguish confirmed prerequisites from possible overlaps.
7. Detect concurrent PRs modifying the same files, symbols, APIs, or data contracts.
8. Simulate the cherry-pick in a temporary branch or Git worktree.
9. Run reference analysis and validation against the simulated result.
10. Apply the real cherry-pick only after approval.

## Decision Outcomes

The master agent reports one of these outcomes:

- Safe: No missing dependencies were found.
- Conditional: Listed commits or PRs must be applied first.
- Risky: Concurrent changes require owner review.
- Blocked: Required dependencies are missing or validation failed.

Every result must include evidence, affected files, prerequisite commits or PRs, validation performed, failures, and unresolved risks.

## Remote Integration

Local Git can inspect commits, branches, ancestry, and changed files, but it cannot discover open PRs. PR-aware analysis requires optional integration with GitHub, GitLab, or Bitbucket through an API or CLI.

The assistant must not claim that a cherry-pick is safe when remote PR information is unavailable. It should clearly report that the result is based only on local repository state.
