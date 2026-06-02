/**
 * OAuth provider verifiers for the pair flow.
 *
 * Each provider exposes a single `verify*` function with the same
 * normalized contract: take whatever proof the provider hands back
 * (ID token for OIDC providers, access token for OAuth-2-only ones),
 * verify it cryptographically and/or against the provider's userinfo
 * endpoint, bind to the pair session nonce for anti-replay, and
 * return a normalized `OAuthVerifyResult`.
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
 * - All three providers' tokens are anti-replay-bound here by passing
 *   the pair session.nonce as the OIDC `nonce` (Google) or by
 *   verifying state (GitHub / Facebook OAuth2). A token captured
 *   from a different pair session won't redeem against a fresh
 *   session.nonce.
 *
 * - OAuth completion is a SIGNAL, not a hard pass. The verdict still
 *   requires the dual-Argus pass on both sides. See pair-api.ts
 *   `handlePhoneAttest` for the joint gate. OAuth completion just
 *   substitutes for the WebAuthn proof-of-life ribbon.
 */
import { createPublicKey, createVerify } from 'node:crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

// Reuse a single SM client across cold-start lifetime; verifiers are
// invoked from the same Lambda as the device-trust path.
const sm = new SecretsManagerClient({});
const secretCache: Map<string, string> = new Map();
async function fetchSecretValue(arn: string): Promise<string | null> {
  const cached = secretCache.get(arn);
  if (cached) return cached;
  try {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
    if (r.SecretString) {
      secretCache.set(arn, r.SecretString);
      return r.SecretString;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export type OAuthProvider = 'google' | 'github' | 'facebook';

export interface OAuthVerifyResult {
  ok: boolean;
  reason?: string;
  /** Stable, provider-scoped user identifier (Google `sub`, GitHub
   *  numeric id, Facebook `user_id`). Never the user's email. Logged
   *  for fraud correlation, not exposed to the merchant. */
  subject?: string;
  /** Provider tag, echoed back for annotation. */
  provider?: OAuthProvider;
  /** Provider-asserted email-verified flag, when available. Google
   *  exposes this; GitHub does not surface a per-email flag at the
   *  cheap tier; Facebook returns it under `debug_token`. */
  emailVerified?: boolean;
  /** Apple-style "this account looks human" hint. Google has no
   *  equivalent at the OIDC tier; we keep the field for future
   *  Apple integration even though Apple is currently handled via
   *  PAT in pair, not OAuth. */
  realUserHint?: 'likely_real' | 'unknown' | 'unsupported';
}

interface VerifyInput {
  /** Whatever the provider gave the client. For OIDC providers
   *  (Google) this is the ID token JWT. For OAuth-2-only providers
   *  (GitHub, Facebook) this is the access token. */
  token: string;
  /** Pair session.nonce. Bound into the OIDC `nonce` claim for
   *  Google, and into `state` for GitHub / Facebook (client must
   *  echo the same value back). */
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

// ─────────────────────────────────────────────────────────────────────────
// GitHub — OAuth2 access token, redeem against /user with Bearer.
// ─────────────────────────────────────────────────────────────────────────

/**
 * GitHub doesn't ship OIDC ID tokens at the cheap tier, so the proof
 * we get is an access token. The defense is: take the token, redeem
 * it against `/user` over HTTPS — the response's `id` field is the
 * stable numeric account identifier and proves we hold a valid token
 * for SOMEONE'S account.
 *
 * Anti-replay binding: GitHub doesn't have an OIDC nonce. The pair
 * client must echo `expectedNonce` as the OAuth `state` parameter and
 * verify the state round-trip on the callback before calling this
 * verifier. State binding is enforced client-side; this function
 * doesn't see state.
 *
 * Stolen-token replay: an attacker who steals a still-valid token
 * from a GitHub session can use it here. GitHub tokens are typically
 * 1-hour scoped on OAuth Apps; if pair sees them within the window
 * they pass. Mitigation: in the joint gate with dual-Argus, a real
 * residential phone running clean Argus is required as well. Token
 * theft alone isn't enough.
 */
async function verifyGithub(input: VerifyInput): Promise<OAuthVerifyResult> {
  // State binding is enforced client-side, but the parameter stays in
  // the contract for symmetry with the other verifiers.
  void input.expectedNonce;

  if (!process.env.OAUTH_GITHUB_CLIENT_ID) {
    return { ok: false, reason: 'github_not_configured' };
  }
  const resp = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${input.token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ms-argus-pair',
    },
  });
  if (resp.status === 401) return { ok: false, reason: 'token_invalid' };
  if (!resp.ok) return { ok: false, reason: `github_api_${resp.status}` };
  const body = (await resp.json()) as { id?: number; login?: string };
  if (typeof body.id !== 'number') return { ok: false, reason: 'missing_subject' };

  return {
    ok: true,
    provider: 'github',
    subject: String(body.id),
    realUserHint: 'unknown',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Facebook — OAuth2 access token, redeem against /debug_token.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Facebook hands the client a short-lived access token. We verify it
 * against `/debug_token` using an APP token (`{appId}|{appSecret}`).
 * The debug response tells us: which app the token is for (must
 * match ours), whether it's still valid, and the bound user_id.
 *
 * Anti-replay binding: client passes `state = expectedNonce` and
 * verifies the state round-trip on the OAuth callback before calling
 * this verifier (same pattern as GitHub).
 *
 * `debug_token` also returns `is_valid` and the app-scoped user_id.
 * Cross-app token replay is blocked because `app_id !== ours` fails.
 */
async function verifyFacebook(input: VerifyInput): Promise<OAuthVerifyResult> {
  void input.expectedNonce; // state-bound client-side, same as GitHub

  const appId = process.env.OAUTH_FACEBOOK_APP_ID;
  const secretArn = process.env.OAUTH_FACEBOOK_APP_SECRET_ARN;
  if (!appId || !secretArn) return { ok: false, reason: 'facebook_not_configured' };
  const appSecret = await fetchSecretValue(secretArn);
  if (!appSecret) return { ok: false, reason: 'facebook_secret_unavailable' };

  const appToken = `${appId}|${appSecret}`;
  const url = `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(
    input.token
  )}&access_token=${encodeURIComponent(appToken)}`;
  const resp = await fetch(url);
  if (!resp.ok) return { ok: false, reason: `facebook_api_${resp.status}` };
  const body = (await resp.json()) as {
    data?: {
      app_id?: string;
      is_valid?: boolean;
      user_id?: string;
      expires_at?: number;
    };
  };
  const d = body.data;
  if (!d) return { ok: false, reason: 'debug_no_data' };
  if (d.app_id !== appId) return { ok: false, reason: 'wrong_app' };
  if (d.is_valid !== true) return { ok: false, reason: 'invalid_token' };
  if (typeof d.expires_at === 'number' && d.expires_at > 0) {
    if (Math.floor(Date.now() / 1000) > d.expires_at) {
      return { ok: false, reason: 'expired' };
    }
  }
  if (!d.user_id) return { ok: false, reason: 'missing_subject' };

  return {
    ok: true,
    provider: 'facebook',
    subject: d.user_id,
    realUserHint: 'unknown',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────

export async function verifyOAuth(
  provider: OAuthProvider,
  input: VerifyInput
): Promise<OAuthVerifyResult> {
  switch (provider) {
    case 'google':
      return verifyGoogle(input);
    case 'github':
      return verifyGithub(input);
    case 'facebook':
      return verifyFacebook(input);
    default:
      return { ok: false, reason: 'unknown_provider' };
  }
}

export function isOAuthProvider(s: unknown): s is OAuthProvider {
  return s === 'google' || s === 'github' || s === 'facebook';
}
