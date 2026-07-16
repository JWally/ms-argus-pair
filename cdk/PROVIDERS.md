# Google OAuth registration (pair)

The pair backend supports Google OAuth proof-of-life in addition to the existing
WebAuthn ceremony. The Google client ID must be configured before its button
shows up on the phone UI.

Google is optional. When absent, the verifier returns `google_not_configured`,
`PROVIDERS_CONFIGURED.google` is false, and the UI hides the button.

## Common setup

| Variable / context key        | Where it ends up                     |
| ----------------------------- | ------------------------------------ |
| `oauthGoogleClientId`         | Lambda env `OAUTH_GOOGLE_CLIENT_ID`  |
| `VITE_OAUTH_GOOGLE_CLIENT_ID` | Build-time, baked into client bundle |

## Google

1. [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials → Create OAuth 2.0 Client ID.
2. Application type: **Web application**.
3. Authorized JavaScript origins: `https://captcha-dev-jw.argus.pw` (and prod equivalent when ready).
4. Authorized redirect URIs: leave empty — we use the GIS ID-token-only flow, no redirect.
5. Copy the **Client ID** (the public `.apps.googleusercontent.com` string).
6. Pass to CDK: `-c oauthGoogleClientId=...apps.googleusercontent.com` and `VITE_OAUTH_GOOGLE_CLIENT_ID=...apps.googleusercontent.com` in the build env.

OAuth consent screen verification is **not required** for OIDC ID-token-only
flows requesting just `openid email profile`. Anything broader (Gmail / Drive /
Calendar scopes) requires the slow verification process — pair doesn't.

`real_user_status` is **not exposed** by Google. Only Apple has that field.
(We skip Apple OAuth in pair because Apple → PAT golden ticket already
handles the iOS path silently.)

## Per-environment apps

Register a **separate app per stage** (dev-jw, prod) so a dev mistake can't
poison prod's app status with Google.

## Audit notes

- Google receives analytics about every login. If pair becomes user-facing at
  scale, the privacy story is "Google sees
  the user authenticated at captcha-dev-jw.argus.pw; they do NOT see the
  downstream merchant the user is actually trying to reach." Argus is the
  privacy buffer between provider and merchant.
- Google will rate-limit abuse. Do not ship a tight retry loop; fall back to
  the bio CAPTCHA when the provider is unavailable.
