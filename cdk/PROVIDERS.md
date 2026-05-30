# OAuth provider registration (pair)

The pair backend supports OAuth proof-of-life via Google, GitHub, and Facebook
in addition to the existing WebAuthn ceremony. Each provider needs its own app
registration before the corresponding button shows up on the phone UI.

All three are optional. Absent → the verifier returns
`{provider}_not_configured`, the client `PROVIDERS_CONFIGURED.{provider}` flag
is false, and the UI hides the button.

## Common setup

| Variable / context key        | Where it ends up                            | Required by  |
| ----------------------------- | ------------------------------------------- | ------------ |
| `oauthGoogleClientId`         | Lambda env `OAUTH_GOOGLE_CLIENT_ID`         | Google       |
| `oauthGithubClientId`         | Lambda env `OAUTH_GITHUB_CLIENT_ID`         | GitHub       |
| `oauthGithubClientSecretArn`  | Lambda env `OAUTH_GITHUB_CLIENT_SECRET_ARN` | GitHub (opt) |
| `oauthFacebookAppId`          | Lambda env `OAUTH_FACEBOOK_APP_ID`          | Facebook     |
| `oauthFacebookAppSecretArn`   | Lambda env `OAUTH_FACEBOOK_APP_SECRET_ARN`  | Facebook     |
| `VITE_OAUTH_GOOGLE_CLIENT_ID` | Build-time, baked into client bundle        | Google       |
| `VITE_OAUTH_GITHUB_CLIENT_ID` | Build-time, baked into client bundle        | GitHub       |
| `VITE_OAUTH_FACEBOOK_APP_ID`  | Build-time, baked into client bundle        | Facebook     |

Secrets (Facebook app secret, optional GitHub client secret) live in Secrets
Manager. Create them once via the AWS console or CLI, then pass the ARN as
CDK context. Don't paste secret values into commits or `cdk.json`.

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

## GitHub

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
2. Application name: **Argus Pair (dev-jw)** (or whatever — user-visible on consent).
3. Homepage URL: `https://captcha-dev-jw.argus.pw`.
4. Authorization callback URL: `https://captcha-dev-jw.argus.pw/oauth/github/callback`.
5. **Enable Device Flow**: no.
6. Save → copy the **Client ID** (public).
7. (Optional) Generate a **client secret** if you want server-side code exchange instead of PKCE. PKCE is preferred — keep this off unless you need it.
8. Pass to CDK: `-c oauthGithubClientId=<id>` and `VITE_OAUTH_GITHUB_CLIENT_ID=<id>`.

Client-side PKCE flow (default): no client secret needed. Code verifier is
generated per-attempt and the access token is short-lived (1 hour).

## Facebook

1. [Meta for Developers](https://developers.facebook.com) → My Apps → Create App → **Consumer** type → name "Argus Pair (dev-jw)".
2. Add product **Facebook Login** → Settings:
   - Valid OAuth Redirect URIs: `https://captcha-dev-jw.argus.pw/oauth/facebook/callback`
   - Web OAuth Login: **Enabled**
   - Use Strict Mode for Redirect URIs: **Enabled**
3. Note the **App ID** (public).
4. Settings → Basic → reveal **App Secret**. Create a Secrets Manager entry:
   ```sh
   aws secretsmanager create-secret \
     --name ms-argus-pair-dev-jw-facebook-app-secret \
     --secret-string "<your-app-secret>"
   ```
   Copy the resulting ARN.
5. App Review → Permissions and Features → keep `public_profile` only (no review needed). The scope `email` requires review for production.
6. Switch the app to **Live** mode once basics are confirmed (dev mode only lets app admins / testers sign in).
7. Pass to CDK:
   - `-c oauthFacebookAppId=<id>`
   - `-c oauthFacebookAppSecretArn=<arn>`
   - `VITE_OAUTH_FACEBOOK_APP_ID=<id>`

## Per-environment apps

Register a **separate app per stage** (dev-jw, prod) so a dev mistake can't
poison prod's app status with the provider. Same applies to the SecretsManager
entries.

## Audit notes

- All three providers send analytics back to themselves about every login. If
  pair becomes user-facing at scale, the privacy story is "the provider sees
  the user authenticated at captcha-dev-jw.argus.pw; they do NOT see the
  downstream merchant the user is actually trying to reach." Argus is the
  privacy buffer between provider and merchant.
- All three providers will rate-limit you under abuse. Don't ship a tight
  retry loop — fall back to the bio CAPTCHA on `*_api_429`.
