# Repo notes for ms-argus-pair

Operational notes that bite when ignored. Auto-loaded into the assistant's
context every session.

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
