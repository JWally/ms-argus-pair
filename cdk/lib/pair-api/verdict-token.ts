/**
 * Verdict token — a signed, server-to-server-verifiable statement that a pairing
 * session reached a verdict.
 *
 *   token = base64url(JSON claims) + '.' + base64url(HMAC-SHA256(secret, payload))
 *
 * Claims bind { cpi, sessionId, verdict, reason, iat, exp } so a token minted for
 * one merchant/session can't be replayed for another, and goes stale in 5 min.
 * The host POSTs the token to /api/verify (siteverify-style) — we never trust a
 * browser-reported verdict. Symmetric (HMAC) on purpose: verification is a
 * server-to-server call to us, the conventional captcha model, and the secret is
 * auto-generated in Secrets Manager (no keypair ceremony). Mirrors the
 * device-trust token format in ./attestation/trust.ts.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

export const VERDICT_TOKEN_TTL_SEC = 300; // matches the 5-min session TTL

export interface VerdictClaims {
  cpi: string | null;
  sessionId: string;
  verdict: string;
  reason: string | null;
  iat: number;
  exp: number;
}

const sm = new SecretsManagerClient({});
let cached: { secret: string; at: number } | null = null;

/** Fetch (and 5-min cache) the HMAC secret. null when unconfigured. */
export async function getVerdictSecret(): Promise<string | null> {
  const arn = process.env.VERDICT_SIGNING_SECRET_ARN;
  if (!arn) return null;
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.secret;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const secret = r.SecretString ?? null;
  if (secret) cached = { secret, at: Date.now() };
  return secret;
}

const macOf = (secret: string, payload: string) =>
  createHmac('sha256', secret).update(payload).digest().toString('base64url');

export function signVerdict(
  secret: string,
  input: Omit<VerdictClaims, 'iat' | 'exp'>,
  now: number = Date.now()
): string {
  const iat = Math.floor(now / 1000);
  const claims: VerdictClaims = { ...input, iat, exp: iat + VERDICT_TOKEN_TTL_SEC };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${macOf(secret, payload)}`;
}

export type VerifyVerdictResult =
  | { ok: true; claims: VerdictClaims }
  | { ok: false; reason: string };

export function verifyVerdictToken(
  secret: string,
  token: string,
  now: number = Date.now()
): VerifyVerdictResult {
  const dot = token.indexOf('.');
  if (dot < 1 || dot === token.length - 1) return { ok: false, reason: 'malformed' };
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = macOf(secret, payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    return { ok: false, reason: 'bad_signature' };

  let claims: VerdictClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as VerdictClaims;
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }
  if (typeof claims.sessionId !== 'string' || typeof claims.verdict !== 'string') {
    return { ok: false, reason: 'bad_claims' };
  }
  const nowSec = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < nowSec)
    return { ok: false, reason: 'expired' };
  if (typeof claims.iat !== 'number' || claims.iat > nowSec + 60)
    return { ok: false, reason: 'future' };
  return { ok: true, claims };
}
