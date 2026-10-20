# Commit convention

Use Conventional Commits format:

`type(scope): short summary`

## Allowed types

- `feat` — new functionality
- `fix` — bug fix
- `refactor` — internal code change without behavior change
- `docs` — documentation only
- `test` — tests only
- `chore` — maintenance, configs, dependencies
- `build` — build system or packaging
- `ci` — CI/CD changes
- `perf` — performance improvement
- `revert` — revert previous commit

## Rules

- Write commit subject in English.
- Use imperative mood.
- No trailing period.
- Keep it short and specific.
- Scope is optional but preferred.
- One commit = one logical change.
- Do not use vague messages like:
  - `update`
  - `fix stuff`
  - `changes`
  - `misc`
  - `wip`

## Logical commit grouping

- Prefer separate commits for implementation, tests, and documentation when each commit remains coherent and reviewable on its own.
- Use `feat`, `fix`, or `refactor` for implementation commits.
- Use `test` for separate test-only commits.
- Use `docs` for separate documentation-only commits.
- Keep implementation, tests, and documentation together when separating them would make a commit incomplete, misleading, unsafe, or unable to stand on its own.
- Keep required configuration or database migrations with the implementation that depends on them.
- Do not split changes inside the same file artificially when the split cannot be performed safely.

## Good examples

- `feat(auth): add email login`
- `fix(api): handle token refresh retry`
- `refactor(cache): simplify invalidation logic`

## Bad examples

- `fixed`
- `some changes`
- `wip`
- `update project`

## Breaking changes

For breaking changes:
- use `!` after type/scope, or
- add a `BREAKING CHANGE: <description>` footer separated from the body by a blank line

Examples:
- `feat(api)!: remove legacy v1 endpoints`
- `refactor(config)!: rename env variables`

```text
refactor(config): rename environment variables

BREAKING CHANGE: DATABASE_URL replaces DB_CONNECTION_STRING
```
