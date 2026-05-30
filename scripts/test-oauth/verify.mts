/**
 * Server-side verifier smoke test for the Google OAuth path.
 *
 * Imports the production `verifyGoogle` from `cdk/lib/oauth-providers.ts`
 * and runs it against a token + nonce pair you captured from
 * `scripts/test-oauth/index.html`. Prints the full OAuthVerifyResult.
 *
 * Usage:
 *   OAUTH_GOOGLE_CLIENT_ID="<your-client-id>" \
 *     npx tsx scripts/test-oauth/verify.mts "<id-token>" "<nonce>"
 *
 * What this proves:
 *   - The JWKS fetch + RS256 signature verify path actually works
 *     against a real Google-signed token.
 *   - aud / iss / exp / nonce / sub checks all behave as documented.
 *   - The same code path the pair Lambda would run is exercised.
 *
 * What it does NOT prove:
 *   - End-to-end pair flow (no session, no device-trust mint, no
 *     dual-Argus). That's the next step after this passes.
 */
import { verifyGoogle } from '../../cdk/lib/oauth-providers.js';

const [token, nonce] = process.argv.slice(2);
if (!token || !nonce) {
  console.error('Usage: verify.mts <id-token> <nonce>');
  console.error('  Set OAUTH_GOOGLE_CLIENT_ID before running.');
  process.exit(1);
}
if (!process.env.OAUTH_GOOGLE_CLIENT_ID) {
  console.error('OAUTH_GOOGLE_CLIENT_ID env var not set.');
  process.exit(1);
}

console.error('expectedNonce :', nonce);
console.error('client_id     :', process.env.OAUTH_GOOGLE_CLIENT_ID);
console.error('token length  :', token.length, 'chars');
console.error('---');

const result = await verifyGoogle({ token, expectedNonce: nonce });
console.log(JSON.stringify(result, null, 2));

if (!result.ok) {
  console.error('---');
  console.error('FAILED. Reason:', result.reason);
  process.exit(2);
}
