# Google OAuth smoke test

Standalone test rig that proves the Google OAuth circuit works end-to-end
**before** wiring it into the pair flow. No AWS, no Lambda, no pair UI — just
the browser doing GIS One Tap and our production `verifyGoogle` function
running locally.

## Setup (once)

1. **Add `http://localhost:5173` to the OAuth client's authorized JavaScript origins.**
   - Google Cloud Console → APIs & Services → Credentials → click the OAuth 2.0 Client ID we created for Argus Pair dev-jw
   - Under "Authorized JavaScript origins" add `http://localhost:5173`
   - Save. The change is live within seconds.

2. Confirm `OAUTH_GOOGLE_CLIENT_ID` is set in your `.env`:

   ```sh
   grep OAUTH_GOOGLE_CLIENT_ID .env
   # OAUTH_GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   ```

## Run

From the repo root, **two terminals**:

### Terminal A — serve the test page

```sh
npx serve scripts/test-oauth -l 5173
```

(Or `python3 -m http.server 5173 --directory scripts/test-oauth`.)

Visit `http://localhost:5173`. The page:

- Generates a random nonce.
- Shows a "Continue with Google" button.
- On success, prints the ID token, decoded payload (client-side, unverified), and the exact verify command to copy-paste.

### Terminal B — verify the token server-side

Copy the verify command the page prints, paste into a terminal at the repo root, run. Example shape:

```sh
OAUTH_GOOGLE_CLIENT_ID="84525022508-...apps.googleusercontent.com" \
  npx tsx scripts/test-oauth/verify.mts \
  "<id-token>" \
  "<nonce>"
```

## What success looks like

```json
{
  "ok": true,
  "provider": "google",
  "subject": "1234567890",
  "emailVerified": true,
  "realUserHint": "unknown"
}
```

`subject` is your stable Google `sub` claim. `emailVerified` reflects what Google says about your email. If you see that, the JWKS fetch worked, RS256 signature verified, aud / iss / exp / nonce / sub all matched.

## Common failures

| Reason                  | What it means                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `google_not_configured` | Forgot `OAUTH_GOOGLE_CLIENT_ID=` in the env when running verify.                         |
| `aud_mismatch`          | The token was minted for a different client ID than the one in the env. Check both ends. |
| `nonce_mismatch`        | You ran verify with a stale nonce from a prior page load. Refresh, sign in again.        |
| `expired`               | ID tokens are 1-hour TTL. Get a fresh one.                                               |
| `signature_invalid`     | Token was tampered with, or the JWKS rotated mid-verify.                                 |
| `jwks_unavailable`      | Couldn't fetch from `https://www.googleapis.com/oauth2/v3/certs`. Check connectivity.    |
| `unknown_kid`           | The kid in the token header isn't in the current JWKS. Rare. Get a fresh token.          |

## What this proves vs doesn't

**Proves:**

- The JWKS fetch + RSA signature verification path works against real Google traffic.
- Our aud / iss / exp / nonce / sub checks all behave correctly.
- The production code path the pair Lambda will run is exercised end-to-end.

**Does NOT prove:**

- End-to-end pair flow (no session, no device-trust mint, no dual-Argus integration).
- That the Google client's authorized origins list is correct for the pair production domain (this rig uses localhost).
- That FedCM works on the actual phone the user will use.

Next step after this passes: wire the chooser button into Demo.tsx and test end-to-end on dev-jw.
