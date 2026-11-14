# Upstream development practice: getpaseo/paseo

Read at: v0.15.4 (1c00b365c, 2026-11-10). Re-read from upstream main before landing.

## Code style

TypeScript, oxlint + prettier (`npm run lint`, `npm run format:check`);
docs/coding-standards.md.

## Commit messages

Conventional commits, `type(scope): summary`, body says why.

## Tests

vitest per workspace (`npm run test --workspace=@getpaseo/<pkg>`); docs/testing.md
prefers real dependencies over mocks.

## Gate

`.fork/gate`: typecheck plus the vitest files next to what the queue touches.

## Where the fork deviates and why

Nothing yet.
