/**
 * OAuth provider verifiers for the pair flow.
 *
 * Verifies the Google OIDC ID token, binds it to the pair session nonce,
 * and returns a normalized `OAuthVerifyResult`.
 *
 * On `ok: true` the caller (`/oauth-attest`) reuses the existing
 * `mintDeviceTrust` path to issue the same HMAC envelope it would
 * have issued after a WebAuthn ceremony — silent re-auth keeps
 * working identically.
 *
 * Design notes:
 *
 * - WebAuthn-fmt-none is structurally forgeable from Node, see
 *   `pair-api.ts:893-912` for the existing acknowledgement. Real
 *   OAuth tokens cost $5-50 each on the stolen-account market and
 *   get burnt over time by the provider's own fraud detection — a
 *   real economic floor on bot attempts that fmt-none doesn't add.
 *
 * - Tokens are anti-replay-bound by passing the pair session nonce as the
 *   OIDC `nonce`. A token captured from a different pair session will not
 *   redeem against a fresh nonce.
 *
 * - OAuth completion is a SIGNAL, not a hard pass. The verdict still
 *   requires the dual-Argus pass on both sides. See pair-api.ts
 *   `handlePhoneAttest` for the joint gate. OAuth completion just
 *   substitutes for the WebAuthn proof-of-life ribbon.
 */
import { createPublicKey, createVerify } from 'node:crypto';

export type OAuthProvider = 'google';

export interface OAuthVerifyResult {
  ok: boolean;
  reason?: string;
  /** Stable Google `sub`. Never the user's email. Logged for fraud
   * correlation, not exposed to the merchant. */
  subject?: string;
  /** Provider tag, echoed back for annotation. */
  provider?: OAuthProvider;
  /** Provider-asserted email-verified flag. */
  emailVerified?: boolean;
  /** Apple-style "this account looks human" hint. Google has no
   *  equivalent at the OIDC tier; we keep the field for future
   *  Apple integration even though Apple is currently handled via
   *  PAT in pair, not OAuth. */
  realUserHint?: 'likely_real' | 'unknown' | 'unsupported';
}

interface VerifyInput {
  /** Google OIDC ID token JWT. */
  token: string;
  /** Pair session nonce, bound into the OIDC `nonce` claim. */
  expectedNonce: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Google — OIDC ID token, verify JWT signature against the JWKS.
// ─────────────────────────────────────────────────────────────────────────

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUER = ['https://accounts.google.com', 'accounts.google.com'];

interface GoogleJwksCache {
  fetchedAt: number;
  byKid: Record<string, string>; // kid -> PEM public key
}
let googleJwksCache: GoogleJwksCache | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function getGoogleJwks(): Promise<Record<string, string>> {
  const now = Date.now();
  if (googleJwksCache && now - googleJwksCache.fetchedAt < JWKS_TTL_MS) {
    return googleJwksCache.byKid;
  }
  const resp = await fetch(GOOGLE_JWKS_URL);
  if (!resp.ok) throw new Error('jwks_fetch_failed');
  const body = (await resp.json()) as { keys: { kid: string; n: string; e: string }[] };
  const byKid: Record<string, string> = {};
  for (const k of body.keys) {
    const keyObj = createPublicKey({
      key: { kty: 'RSA', n: k.n, e: k.e } as never,
      format: 'jwk',
    });
    byKid[k.kid] = keyObj.export({ type: 'spki', format: 'pem' }).toString();
  }
  googleJwksCache = { fetchedAt: now, byKid };
  return byKid;
}

function b64urlToBuf(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

async function verifyGoogle(input: VerifyInput): Promise<OAuthVerifyResult> {
  const clientId = process.env.OAUTH_GOOGLE_CLIENT_ID;
  if (!clientId) return { ok: false, reason: 'google_not_configured' };

  const parts = input.token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed_jwt' };
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; kid?: string };
  let payload: {
    iss?: string;
    aud?: string;
    sub?: string;
    nonce?: string;
    exp?: number;
    email_verified?: boolean;
  };
  try {
    header = JSON.parse(b64urlToBuf(headerB64).toString('utf8'));
    payload = JSON.parse(b64urlToBuf(payloadB64).toString('utf8'));
  } catch {
    return { ok: false, reason: 'jwt_parse_failed' };
  }
  if (header.alg !== 'RS256') return { ok: false, reason: 'unsupported_alg' };
  if (!header.kid) return { ok: false, reason: 'missing_kid' };

  let jwks: Record<string, string>;
  try {
    jwks = await getGoogleJwks();
  } catch {
    return { ok: false, reason: 'jwks_unavailable' };
  }
  const pem = jwks[header.kid];
  if (!pem) return { ok: false, reason: 'unknown_kid' };

  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  const sigOk = verifier.verify(pem, b64urlToBuf(sigB64));
  if (!sigOk) return { ok: false, reason: 'signature_invalid' };

  if (!payload.iss || !GOOGLE_ISSUER.includes(payload.iss)) {
    return { ok: false, reason: 'wrong_issuer' };
  }
  if (payload.aud !== clientId) return { ok: false, reason: 'aud_mismatch' };
  if (typeof payload.exp !== 'number' || Math.floor(Date.now() / 1000) > payload.exp) {
    return { ok: false, reason: 'expired' };
  }
  if (payload.nonce !== input.expectedNonce) return { ok: false, reason: 'nonce_mismatch' };
  if (!payload.sub) return { ok: false, reason: 'missing_subject' };

  return {
    ok: true,
    provider: 'google',
    subject: payload.sub,
    emailVerified: payload.email_verified === true,
    realUserHint: 'unknown',
  };
}

export async function verifyOAuth(input: VerifyInput): Promise<OAuthVerifyResult> {
  return verifyGoogle(input);
}

export function isOAuthProvider(s: unknown): s is OAuthProvider {
  return s === 'google';
}
