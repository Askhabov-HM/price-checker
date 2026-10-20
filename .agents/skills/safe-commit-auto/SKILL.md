---
name: safe-commit-auto
description: "Automatically review, stage, commit, and push local Git changes according to the repository AGENTS.md and codex-guidance. Use only when the user explicitly invokes $safe-commit-auto or explicitly asks to commit and push without a preview or approval. Do not use for generic commit requests, read-only reviews, releases, pull requests, or history rewriting."
---

# Safe Commit Auto

Create one or more correct local commits and push the current branch without presenting a plan for approval first.

## Workflow

1. Resolve the Git repository root.
2. Read the root `AGENTS.md` and follow all applicable instructions.
3. Read `codex-guidance/commit-convention.md` and `codex-guidance/security-secrets.md` from the repository root. If the repository does not contain `codex-guidance`, read the same files from the global Codex guidance directory at `$CODEX_HOME/codex-guidance` (or `~/.codex/codex-guidance` when `$CODEX_HOME` is unset). Read `codex-guidance/versioning.md` only when version or release files are included.
4. Stop if any required guidance file is missing or conflicts with another applicable instruction.
5. Inspect the current branch, remotes, upstream, staged changes, unstaged changes, and untracked files. Require branch `develop` with upstream `origin/develop`; stop on any other branch or upstream.
6. Stop when Git is in a merge, rebase, cherry-pick, revert, conflict, or detached-HEAD state.
7. Review all candidate diffs and filenames for secrets. Redact suspected values in all output. Treat any suspected secret as a hard blocker.
8. Exclude unrelated, temporary, generated, or user-owned changes that do not belong to the requested work.
9. Divide the selected changes into logical commits. Stop instead of guessing when intent is unclear or a mixed file cannot be split safely.
10. Generate English Conventional Commit messages that follow the project guidance. Keep one logical change per commit.
11. Stage only explicit paths or hunks for the current commit. Never stage the entire working tree broadly.
12. Review the staged diff and repeat the secret check immediately before every commit.
13. Create each commit normally and allow configured Git hooks to run.
14. Push only `develop` to its configured upstream `origin/develop`. Never push `main`, another branch, or another remote. Stop if the required upstream is missing.
15. Report the created commit SHAs and messages, push destination, remaining changes, and any warnings.

Do not run project tests, linters, formatters, builds, or type checks as part of this skill. Git hooks may still run them during `git commit`; never bypass those hooks.

## Stop Conditions

Stop without committing or pushing when:

- a suspected secret or forbidden file is found;
- there are no eligible changes;
- the intended commit scope is ambiguous;
- required guidance is missing or contradictory;
- the branch or repository state is unsafe;
- the remote or push destination is ambiguous;
- a Git hook rejects a commit;
- push authentication fails or the push is rejected;
- pushing would require merge, rebase, history rewriting, or force.

Do not automatically recover from a rejected push. Report the exact non-sensitive reason and leave the repository state intact.

## Prohibited Actions

- Do not use `git add .`, broad `git add -A`, or equivalent whole-tree staging.
- Do not use `git commit --amend`, `git commit --no-verify`, or empty commits unless explicitly requested by a separate instruction.
- Do not use force push, reset, clean, rebase, automatic merge, automatic conflict resolution, or history rewriting.
- Do not create tags, releases, or pull requests.
- Do not reveal secret values in output.
