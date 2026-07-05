# Repo notes for ms-argus-pair

Operational notes that bite when ignored. Auto-loaded into the assistant's
context every session.

## Shared engineering guide

Read `/home/justin/Dev/ARGUS_ENGINEERING_GUIDE.md` before making code changes.
Repo-local notes in this file are more specific and win on conflicts, but the
shared guide is the default standard for structure, naming, tests, docs, and
LLM-generated code hygiene.

In particular: prefer TDD for logic/security changes, keep new code small and
domain-grouped, update docs before finishing, and use the repo's automated
quality gates as ratchets rather than bypassing them.

## Testing model: unit, integration, e2e

Use three test layers in this repo:

- **Unit tests** live in `tests/**/*.test.ts` and run with `npm test`. Use them
  for pure logic: verdict scoring, token mint/redeem, WebAuthn assurance,
  crypto wrappers, parsing, and small helpers.
- **Integration tests** should live in `tests/integration/**/*.integration.ts`
  once added. Use them to put Pair into a named state and call API/module
  boundaries with fake stores, fake clocks, fake projections, fake secrets, and
  fake WS publishers. These should cover positive and negative state-machine
  cases without live AWS.
- **E2E tests** live in `tests/e2e/**/*.e2e.ts` and run with
  `npm run test:e2e`. They drive the deployed stack/browser and are for live
  wiring, not branch coverage.

For new Pair behavior, write or update the test plan before implementation when
practical:

```text
Need: behavior X.
Unit tests: A, B, C should fail first.
Integration tests: X, Y, Z should fail first.
E2E or attack harness: live case if the risk crosses browser/process boundaries.
```

Good Pair integration-test targets:

- `/api/session/start -> desktop-attest -> phone-attest` happy path with clean
  fake projections.
- Missing or mismatched `desktopEnvelope` fails closed.
- Replayed desktop or phone Argus session IDs fail.
- Forged weak WebAuthn plus missing/dirty projections fails.
- Weak WebAuthn does not mint durable device trust unless the assurance policy
  explicitly allows it.
- Known virtual authenticator AAGUID fails outside explicit dev/test mode.

The desired shape is an injectable Pair API core, for example
`createPairApi({ sessionStore, projectionStore, passkeyStore, tokenStore, clock,
secrets, wsPublisher })`, so integration tests do not need live AWS to prove the
state machine.

## Deploys: every new context flag has to be plumbed in **two** places

CDK context (`-c key=value`) is only read by `cdk/bin/app.ts` if that file
explicitly calls `app.node.tryGetContext('key')` AND passes the result through
to the stack constructor. Adding a context flag to `pair-stack.ts`'s props
type is **not** enough — the bin script also has to read it.

When you add a new context flag to `PairStack`:

1. Add the prop to `PairStackProps` in `cdk/lib/pair-stack.ts`.
2. Destructure it from `props` and wire it into env / construct config.
3. **Read it in `cdk/bin/app.ts`** via `app.node.tryGetContext('...')` and pass
   it into `new PairStack({ ..., yourFlag })`.
4. **Add it to `npm run deploy`** in `package.json` so future deploys carry it
   automatically. Don't rely on humans remembering `-c yourFlag=...` every
   time.
5. **Add the underlying value to `.env`** (the deploy script sources it). All
   env vars used by the deploy script live in `.env` — gitignored, so they
   never leak.

Skipping step 3 is the single most common failure: the stack code reads
`props.yourFlag` and gets `undefined`, the Lambda's env block omits the
relevant entry, and the runtime fails with a vague "not configured" error
that has nothing to do with the actual broken plumbing.

Recorded after we shipped the Google OAuth path and the Lambda came up
without `OAUTH_GOOGLE_CLIENT_ID` because `bin/app.ts` wasn't reading the
context flag we'd passed.

## Deploys: the QR url-base MUST be baked at build time — verify it landed

The QR code URL the desktop hands to the phone is built from
`import.meta.env.VITE_PAIR_URL_BASE`, baked at **build time** by Vite.
If that env var isn't present when `vite build` runs, the runtime falls
back to `window.location.origin`, and the desktop ends up handing out
QRs pointing at whichever **alias domain** it was loaded from
(`qr.arcades.click`, `cool-stuff.io`, etc.) instead of the canonical
`captcha-dev-jw.argus.pw`. Phone arrives at the wrong origin →
WebAuthn rpId mismatch, WS handshake against the wrong API, the works.

This has bitten us **twice** under the same root cause:
`VITE_PAIR_URL_BASE` didn't make it through the deploy chain (likely a
shell-quoting or `source .env` quirk on a fresh shell). Three defenses
are in place — keep all three.

1. **Runtime guard in `src/lib/pair.ts`.** In production builds, if
   `VITE_PAIR_URL_BASE` is unset we **throw** before rendering the QR.
   The desktop demo crashes loudly instead of producing scannable-but-
   wrong QRs. Dev (vite dev) keeps the fallback so localhost still
   works.
2. **Build-time guard in `vite.config.ts`.** Vite refuses to build
   without `VITE_PAIR_URL_BASE` unless `PAIR_ALLOW_ORIGIN_FALLBACK=1`
   is set (pre-push lint builds use that escape hatch).
3. **Post-build assertion in `cdk/bin/assert-baked-host.mjs`.** The
   `deploy` script greps `dist/assets/*.js` for the expected host
   string after `vite build` and **before** `cdk deploy`. If the
   string isn't there, the deploy aborts. Catches the case where the
   env var didn't propagate to Vite even though it looked set.

If you ever see the QR pointing at the wrong host:

- Confirm `npm run deploy` (not a manual `vite build` + `cdk deploy`).
- Check `.env` is readable and `source .env` runs in your shell.
- Check `npm config get script-shell` returns `/bin/bash` (POSIX `sh`
  has no `source` builtin → `source .env` silently no-ops).
- Run `node cdk/bin/print-pair-host.mjs` directly; it should print
  `captcha-dev-jw.argus.pw` (or your stack's canonical host).
- Run `node cdk/bin/assert-baked-host.mjs captcha-dev-jw.argus.pw`
  against the local `dist/` to confirm what was just built.

Last incident: 2026-06-02. Both fix branches kept the file at
`src/lib/pair.ts` around the `pairOrigin` build — that's the choke
point where the bug surfaces.

## Deploys: the deploy script sources `.env` and uses `--all`

`npm run deploy` runs:

```sh
source .env 2>/dev/null
PAIR_HOST=$(node cdk/bin/print-pair-host.mjs)
VITE_PAIR_URL_BASE="https://${PAIR_HOST}" npm run build
npx cdk deploy --all \
  -c merchantApiUrl="$MERCHANT_API_URL" \
  -c merchantApiCredential="$MERCHANT_API_CREDENTIAL" \
  -c merchantCpi="$MERCHANT_CPI" \
  -c oauthGoogleClientId="$OAUTH_GOOGLE_CLIENT_ID" \
  --require-approval never
```

If a new context flag is added, add it to this command, not just to a one-off
invocation. Then update the env var list in this file.

## OAuth providers

See `cdk/PROVIDERS.md` for the per-provider registration walkthrough. Brief
mapping `.env` → CDK context for each:

| `.env` var                       | CDK context flag             |
| -------------------------------- | ---------------------------- |
| `OAUTH_GOOGLE_CLIENT_ID`         | `oauthGoogleClientId`        |
| `OAUTH_GITHUB_CLIENT_ID`         | `oauthGithubClientId`        |
| `OAUTH_GITHUB_CLIENT_SECRET_ARN` | `oauthGithubClientSecretArn` |
| `OAUTH_FACEBOOK_APP_ID`          | `oauthFacebookAppId`         |
| `OAUTH_FACEBOOK_APP_SECRET_ARN`  | `oauthFacebookAppSecretArn`  |

Build-time `VITE_*` mirrors live in the same `.env` for the client bundle.

## OAuth: localhost testing rig

`scripts/test-oauth/` proves the OAuth circuit (Google for now) without
touching pair. Useful when iterating on the verifier logic itself or when
debugging an `aud` / `nonce` / JWKS issue against a real Google-signed
token.

Walkthrough lives in `scripts/test-oauth/README.md`. The only gotcha is that
each origin you serve from has to be on the OAuth client's Authorized
JavaScript Origins list — `http://localhost:5173` is the documented one.
