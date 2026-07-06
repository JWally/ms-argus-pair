# Cleanup Direction

This repository is being cleaned up in small, reviewable passes. The immediate goal is not to rewrite the product. The goal is to make the codebase easier to reason about, harder to accidentally regress, and more suitable for repeated LLM-assisted development without accumulating patchy, hidden complexity.

## End Goal

The target state is a professional, boring codebase:

- Code is grouped by responsibility, with clear module boundaries.
- Files stay small enough to review without scrolling through unrelated concerns.
- Functions do one thing, have obvious names, and are covered by focused tests.
- Security-sensitive flows are represented by explicit server-side contracts and regression tests.
- Build, hygiene, and deployment checks fail early when quality drifts.
- Documentation explains the intended behavior and trust boundaries well enough that future changes do not depend on remembering prior conversations.

The code should feel like a team-owned system, not a pile of successful experiments.

## Current Cleanup Pattern

We are walking the codebase forward one branch at a time:

1. Pick one area with obvious pressure, usually a large route file, duplicated helper logic, unclear naming, or missing tests.
2. Extract narrowly scoped helpers without changing behavior.
3. Add unit tests around the extracted logic before leaning on it.
4. Run local gates and fix only the issues in scope.
5. Deploy to `dev-jw` when the change affects runtime behavior.
6. Red-team or smoke-test the specific behavior that could have regressed.
7. Commit, push, and merge before starting the next cleanup branch.

This keeps cleanup incremental. Each pass should leave the repo slightly easier to work in than it was before.

## Quality Ratchet

The repo already has several checks wired in:

- `npm run lint` for TypeScript/React/security-style warnings.
- `npm run typecheck` for compile-time contracts.
- `npm run spell` for naming and documentation hygiene.
- `npm run boundaries` for dependency direction.
- `npm run dead-code` for unused exports and stale files.
- `npm run duplication` for copy/paste pressure.
- `npm run test` and `npm run test:coverage` for unit coverage.
- `npm run test:hygiene` for build-time app-specific contracts.
- `npm run quality` as the broad local quality gate.
- `lefthook` pre-commit and pre-push gates to prevent bypassing checks accidentally.

The ratchet principle: do not make these numbers worse. When a cleanup pass naturally improves a metric, tighten the threshold or add a focused assertion so the improvement sticks.

Good ratchets include:

- Lowering maximum allowed file length after extracting a large file.
- Lowering maximum allowed duplicated lines after removing a clone.
- Turning a repeated source check into a real unit test.
- Adding regression tests for red-team findings.
- Moving magic strings and security reasons into named constants only when it clarifies ownership.
- Making pre-push run the same checks humans expect reviewers to ask about.

Bad ratchets include:

- Adding broad rules that create noisy false positives.
- Centralizing every string or number into a constants file when locality would be clearer.
- Creating abstractions before the duplication has a stable shape.
- Blocking deploys on a metric that the team has not made realistic yet.

## Cleanup Priorities

The highest-value cleanup continues to be in these areas:

- API route decomposition: keep shrinking `cdk/lib/pair-api.ts` into tested modules with narrow contracts.
- Trust boundary clarity: keep server-side decisions explicit and tested, especially pair-token, proof-of-life, projection lookup, and verdict generation.
- Red-team regressions: every bypass or near-bypass should become either a test, a harness check, or a documented non-goal.
- Hygiene scripts: prefer stable, cheap checks that run locally and in hooks.
- Documentation: update docs when the architecture or security model changes, not after the context is forgotten.

## Working Rules

- Keep branches short-lived.
- Prefer tests before refactors when behavior is subtle.
- Do not mix unrelated cleanup with security behavior changes unless they are tightly connected.
- Do not weaken gates to get a change through; fix the cause or explicitly document the temporary exception.
- Keep deployed `dev-jw` behavior aligned with merged `main` as much as possible.
- Treat generated WASM/package artifacts as part of the change when the Rust source changes.
- Preserve red-team evidence, but do not confuse obfuscation with a trust boundary.

## Definition of Done

A cleanup pass is done when:

- The intended code is committed on its cleanup branch.
- Local gates pass.
- Runtime-impacting changes are deployed and smoke-tested on `dev-jw`.
- Relevant red-team or regression harnesses have been run.
- The branch is pushed and merged to `main`.
- `main` is clean and matches `origin/main`.

This file is temporary working guidance. Delete it once the cleanup process is captured in durable project docs and enforced by the repo's normal checks.
