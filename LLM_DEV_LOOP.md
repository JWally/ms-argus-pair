# LLM Dev Loop

Use this loop when an LLM is doing repeated cleanup or hardening work in
`ms-argus-pair`. The goal is to keep momentum without letting branches collect
unverified changes.

Individual cleanup or security passes branch from current `main`, deploy and
red-team their own work, then merge back through a pull request only when the
evidence is clean.

## Loop Contract

0. Synchronize local `main` with `origin/main`.
1. Run hygiene metrics and read the pressure points.
2. Pick one narrow target.
3. Branch from `main`.
4. Do the work with focused tests.
5. Deploy to `dev-jw` if runtime behavior can change.
6. Red-team or regression-test the changed trust boundary.
7. Merge into `main` only when checks, deploy, and attack evidence are clean.
8. Repeat from step 1.

Do not merge speculative work into `main`. A runtime branch should be deployed
to `dev-jw` and have no known regressions before its pull request is merged.

## Commands

The helper script prints or runs the common checkpoints:

```sh
npm run llm:loop -- start
npm run llm:loop -- baseline
npm run llm:loop -- branch cleanup/<short-target>
npm run llm:loop -- verify
npm run llm:loop -- deploy
npm run llm:loop -- red-team
npm run llm:loop -- merge-main
```

`baseline`, `verify`, and `deploy` run real commands. `red-team` prints the
expected attack-regression checklist because the attack bots live outside this
repo.

## Step 0: Synchronize Main

Start from current `main`:

```sh
git switch main
git pull --ff-only
```

If local `main` cannot fast-forward, stop and inspect why before continuing.

## Step 1: Baseline Hygiene

Run the metrics before choosing work:

```sh
npm run test:coverage
npm run hygiene:stats
npm run quality
```

Read the output in this order:

- Largest files and functions from `npm run hygiene:stats`.
- Duplication output from `npm run quality`.
- Lint warnings and unused disables.
- Coverage gaps that touch the target area.
- Boundary/dead-code findings.

The baseline is not just a gate. It is the work queue. Pick one target that can
make one metric or one trust-boundary test better.

## Step 2: Pick One Target

Good targets:

- Extract a chunk from `cdk/lib/pair-api.ts` into a tested module.
- Convert a red-team finding into a regression test or harness check.
- Reduce one duplicate clone without broad abstraction.
- Lower a file/function size hot spot.
- Make a trust-boundary contract easier to name and test.
- Remove stale fallback or debug behavior.

Bad targets:

- Multiple unrelated cleanups in one branch.
- Cosmetic renames across many files.
- New global constants files that hide local meaning.
- Weakening a gate to make the branch pass.
- Shipping browser-side secrecy as if it were a server trust boundary.

Write the chosen target in the branch name and final summary.

## Step 3: Branch From Main

```sh
git switch main
git pull --ff-only
git switch -c cleanup/<short-target>
```

Use prefixes that explain the work:

- `cleanup/...` for refactors and hygiene.
- `security/...` for trust-boundary behavior.
- `test/...` for coverage or harness-only work.
- `docs/...` for documentation/process changes.

## Step 4: Do The Work

For behavior or security logic, prefer a failing test first:

```text
Need: behavior X.
Unit tests: A, B, C.
Integration tests: X, Y, Z.
E2E or attack harness: live case if the change crosses browser/process/server boundaries.
```

Keep edits small:

- Preserve existing module boundaries unless the branch is explicitly moving one.
- Keep helpers named after domain behavior, not implementation tricks.
- Leave comments only where future readers need a trust-boundary cue.
- Update docs in the same branch when architecture or workflow changes.

## Step 5: Verify Locally

Minimum local gate:

```sh
npm run typecheck
npm run lint
npm test
npm run test:hygiene
PAIR_ALLOW_ORIGIN_FALLBACK=1 npm run build
```

Broad gate before pushing or merging:

```sh
npm run quality
```

Pre-commit and pre-push hooks also run checks. Treat hook failures as product
feedback, not an inconvenience to bypass.

## Step 6: Deploy

Deploy runtime-impacting changes to `dev-jw`:

```sh
npm run deploy
```

Then run the live e2e smoke:

```sh
PAIR_HOST=https://captcha-dev-jw.argus.pw npm run test:e2e
```

If deployment is skipped because the branch is docs/test-only, say that in the
final summary.

## Step 7: Red-Team

Use `ATTACK_TESTING.md` as the attack taxonomy. Pick checks that match what
changed.

Run attack/regression bots when the branch touches:

- Pair-token minting or redemption.
- QR rendering, workers, WASM, ECDH, AES, or scrambling.
- Phone proof, WebAuthn, OAuth, device trust, or attestation.
- Projection lookup, scoring, or verdict generation.
- CSP, SRI, loader, embed, or merchant verification behavior.
- SSO start, challenge, validate, or claim routes.

Classify results precisely:

- `blocked`
- `stolen_but_failed`
- `friction_loss`
- `server_gate_bypass`
- `test_stale`

Do not merge a `server_gate_bypass` until there is a failing regression test and
a fix.

## Step 8: Merge To Main

Only merge when:

- Local checks passed.
- Runtime changes are deployed and live e2e passed.
- Relevant red-team checks are clean or explicitly classified.
- The branch summary names any residual risk.

Push the feature branch, open a pull request to `main`, and merge only after the
checks and live evidence are recorded. Then synchronize the local checkout:

```sh
git switch main
git pull --ff-only
```

After merging to `main`, keep `dev-jw` aligned with it. A deployed but unmerged
experiment is acceptable briefly during investigation; it should not be the
resting state.
